/**
 * Defect [44], the chat's half: an UNPINNED conversation started on the Code
 * Map sends what the page says is open, and shows it in the context bar.
 *
 * Run: bun test tests/web/client/islands/floating-chat-code-map-view.test.ts
 */
import { describe, expect, test } from "bun:test";
import { makeFloatingChatData, type ViewedNode } from "../../../../src/web/client/islands/floating-chat";
import { type CodeMapViewPayload, viewChip, viewedRepoName } from "../../../../src/web/client/lib/code-map-view";

const VIEW: CodeMapViewPayload = {
  repo: "siltpoke",
  selection: { kind: "component", title: "Brain", description: "The second-opinion reviewer." },
};
const NODE: ViewedNode = {
  target: { name: "doThing", path: "src/a.ts", node_type: "function" },
  projHash: "abc",
  label: "doThing",
};

/** An island on a fake page, plus every body it POSTed to /api/chat. */
function island(opts: { view: CodeMapViewPayload | null; onGraph?: boolean; viewed?: ViewedNode | null }) {
  const bodies: Array<Record<string, unknown>> = [];
  const fetchFn = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (url.endsWith("/api/chat") && init?.method === "POST") {
      bodies.push(JSON.parse(String(init.body)) as Record<string, unknown>);
    }
    return new Response("");
  }) as unknown as typeof fetch;
  const d = makeFloatingChatData(fetchFn, {
    onGraph: () => opts.onGraph ?? true,
    getViewed: () => opts.viewed ?? null,
    getView: () => opts.view,
    pageProvider: () => "/repo-graph",
  });
  d.syncViewed();
  return { d, bodies };
}

async function sendOne(d: ReturnType<typeof island>["d"]): Promise<void> {
  d.newConversation();
  d.draft = "What does this do?";
  await d.send();
}

describe("what an unpinned chat on the Code Map sends (defect [44])", () => {
  test("the repository and the selected component ride with the message", async () => {
    const { d, bodies } = island({ view: VIEW });
    await sendOne(d);
    expect(bodies).toHaveLength(1);
    expect(bodies[0]?.view).toEqual(VIEW);
    expect(bodies[0]?.anchor).toBeUndefined();
  });

  test("control: with nothing published by the page, no view is sent", async () => {
    const { d, bodies } = island({ view: null });
    await sendOne(d);
    expect(bodies).toHaveLength(1);
    expect("view" in (bodies[0] ?? {})).toBe(false);
  });

  test("a conversation pinned to a node sends its anchor, not the view", async () => {
    const { d, bodies } = island({ view: VIEW, viewed: NODE });
    await sendOne(d);
    expect(bodies[0]?.anchor).toBeDefined();
    expect("view" in (bodies[0] ?? {})).toBe(false);
  });

  test("a conversation pinned to a review sends its critique anchor, not the view", async () => {
    const { d, bodies } = island({ view: VIEW });
    d.openCritiqueChat({ critiqueId: "c-1234", projHash: "abc" });
    d.draft = "Why this finding?";
    await d.send();
    expect(bodies[0]?.critique_anchor).toBeDefined();
    expect("view" in (bodies[0] ?? {})).toBe(false);
  });

  test("off the Code Map a leftover view is not sent", async () => {
    const { d, bodies } = island({ view: VIEW, onGraph: false });
    await sendOne(d);
    expect("view" in (bodies[0] ?? {})).toBe(false);
  });

});

describe("a view that has gone stale by the time of sending (defect [44])", () => {
  test("leaving the Code Map without any event still stops the view being sent", async () => {
    // The chat island survives navigation; nothing fires the bridge event when
    // the page under it changes, so the mirror can be stale at send time.
    let onGraph = true;
    const bodies: Array<Record<string, unknown>> = [];
    const fetchFn = (async (_i: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === "POST") bodies.push(JSON.parse(String(init.body)) as Record<string, unknown>);
      return new Response("");
    }) as unknown as typeof fetch;
    const d = makeFloatingChatData(fetchFn, { onGraph: () => onGraph, getViewed: () => null, getView: () => VIEW, pageProvider: () => "/memory" });
    // Start the conversation ON the map (starting one refreshes the mirror),
    // then leave, then send: the mirror still holds the component.
    d.newConversation();
    expect(d.view).toEqual(VIEW);
    onGraph = false;
    d.draft = "What does this do?";
    await d.send();
    expect(d.view).toEqual(VIEW); // stale, as described — the guard is what holds
    expect("view" in (bodies[0] ?? {})).toBe(false);
  });

  test("the view sent is the one open at SEND time, not at conversation start", async () => {
    let current: CodeMapViewPayload | null = VIEW;
    const bodies: Array<Record<string, unknown>> = [];
    const fetchFn = (async (_i: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === "POST") bodies.push(JSON.parse(String(init.body)) as Record<string, unknown>);
      return new Response("");
    }) as unknown as typeof fetch;
    const d = makeFloatingChatData(fetchFn, { onGraph: () => true, getViewed: () => null, getView: () => current, pageProvider: () => "/repo-graph" });
    d.syncViewed();
    d.newConversation();
    current = { repo: "siltpoke", selection: { kind: "component", title: "Critic" } };
    d.syncViewed(); // what the bridge event does when the page publishes
    d.draft = "And this?";
    await d.send();
    expect((bodies[0]?.view as CodeMapViewPayload).selection?.title).toBe("Critic");
  });
});

describe("the context bar", () => {
  test("names the repository and the selected component", () => {
    const { d } = island({ view: VIEW });
    d.contextPreview = { pageLabel: "Repo Graph", factsCount: 0 };
    expect(d.contextChips().page).toBe("Repo Graph · siltpoke · Brain");
  });

  test("with nothing selected it still names the repository", () => {
    const { d } = island({ view: { repo: "siltpoke", selection: null } });
    d.contextPreview = { pageLabel: "Repo Graph", factsCount: 0 };
    expect(d.contextChips().page).toBe("Repo Graph · siltpoke");
  });

  test("control: without a view it is the page label alone", () => {
    const { d } = island({ view: null });
    d.contextPreview = { pageLabel: "Repo Graph", factsCount: 0 };
    expect(d.contextChips().page).toBe("Repo Graph");
  });

  test("off the Code Map the bar does not show a component left over from it", () => {
    // The mirror is only refreshed by the bridge event and by starting a
    // conversation; navigating away does neither.
    let onGraph = true;
    const fetchFn = (async () => new Response("")) as unknown as typeof fetch;
    const d = makeFloatingChatData(fetchFn, { onGraph: () => onGraph, getViewed: () => null, getView: () => VIEW, pageProvider: () => "/memory" });
    d.syncViewed();
    onGraph = false;
    d.contextPreview = { pageLabel: "Memory Book", factsCount: 0 };
    expect(d.view).toEqual(VIEW); // stale
    expect(d.contextChips().page).toBe("Memory Book");
  });

  test("viewChip drops empty parts", () => {
    expect(viewChip("Repo Graph", { repo: "", selection: { kind: "folder", title: "src/brain/" } })).toBe("Repo Graph · src/brain/");
    expect(viewChip("", { repo: "siltpoke", selection: null })).toBe("siltpoke");
  });
});

// with no repo indexed the chip still said "siltpoke" —
// the page passed on the folder it looks at, which has no graph. Only an
// indexed repo is named.
describe("the repo the Code Map names to the chat", () => {
  test("an indexed repo is named; a repo with no graph is not", () => {
    expect(viewedRepoName({ repo: { name: "siltpoke" }, subdirs: [{}] })).toBe("siltpoke");
    expect(viewedRepoName({ repo: { name: "siltpoke" }, subdirs: [] })).toBe("");
    expect(viewedRepoName({ subdirs: [{}] })).toBe("");
  });
});
