/**
 * The island asks GET /api/repo-graph/staleness on boot and acts on it — the
 * wiring half of repo-graph-index-freshness.test.ts, through the real boot
 * path. Before this, the page said "Diagram is current" over an index that was
 * 88% out of date (agent-runtime, 2026-10-15).
 *
 * Run: bun test tests/web/client/islands/repo-graph-index-freshness-wiring.test.ts
 */
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { installFetchMock, jsonResponse, mountRepoGraph, registerDom, unregisterDom } from "./_dom-harness";

beforeAll(() => {
  registerDom();
});
afterAll(async () => {
  await unregisterDom();
});
afterEach(() => {
  window.history.replaceState(null, "", "/repo-graph");
});

const EV = [{ file: "src/alpha/a.ts", line: 1 }];
const GEN_DOC = {
  boundary: "fixture-gen",
  bands: [{ id: "core", label: { value: "GenBand", evidence: EV }, order: 0, members: ["genbox"] }],
  nodes: [
    {
      id: "genbox",
      kind: "cont",
      title: { value: "GeneratedBox", evidence: EV },
      band: { value: "core", evidence: EV },
      drillTo: "alpha",
      members: ["src/alpha/a.ts"],
    },
  ],
  edges: [],
};
const STALE = {
  level: "stale",
  headline: "88% out of date — re-index recommended",
  caveat: null,
  counts: { content_changed: 4, deleted_still_indexed: 0, unindexed_files: 3, indexed: 5, wrong_ratio: 0.875 },
};

function tick(): Promise<void> {
  return new Promise((r) => setTimeout(r, 0));
}

async function mountWith(staleness: () => Promise<Response>, generated: boolean): Promise<{ root: HTMLElement; posts: string[] }> {
  const posts: string[] = [];
  installFetchMock([
    ["/arch/task", () => Promise.resolve(jsonResponse({ data: { task: null } }))],
    ["/arch/estimate", () => Promise.resolve(jsonResponse({ success: true, data: { estUsd: 0.2 } }))],
    ["/api/repo-graph/staleness", staleness],
  ]);
  const realFetch = globalThis.fetch;
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (url.endsWith("/api/repo-graph/index") && init?.method === "POST") {
      posts.push(String(init.body));
      return Promise.resolve(new Response(JSON.stringify({ success: false, error: "index_in_progress" }), { status: 409, headers: { "content-type": "application/json" } }));
    }
    return realFetch(input, init);
  }) as typeof fetch;
  window.history.replaceState(null, "", "/repo-graph?arch-source=subset");
  const root = await mountRepoGraph(
    generated ? { generatedModel: { doc: GEN_DOC as never, groundedPct: 88, stale: false } } : {},
  );
  for (let i = 0; i < 4; i++) await tick();
  return { root, posts };
}

/** Same as mountWith(generated), but the repo entry has no project_root, and
 * any arch generate POST is recorded. */
async function mountWithRepos(
  staleness: () => Promise<Response>,
  generates: string[],
): Promise<{ root: HTMLElement; posts: string[] }> {
  const posts: string[] = [];
  installFetchMock([
    ["/arch/task", () => Promise.resolve(jsonResponse({ data: { task: null } }))],
    ["/arch/estimate", () => Promise.resolve(jsonResponse({ success: true, data: { estUsd: 0.2 } }))],
    ["/api/repo-graph/staleness", staleness],
  ]);
  const realFetch = globalThis.fetch;
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (init?.method === "POST" && url.endsWith("/api/repo-graph/index")) posts.push(String(init.body));
    if (init?.method === "POST" && url.includes("/arch")) generates.push(url);
    return realFetch(input, init);
  }) as typeof fetch;
  window.history.replaceState(null, "", "/repo-graph?arch-source=subset");
  const root = await mountRepoGraph({
    generatedModel: { doc: GEN_DOC as never, groundedPct: 88, stale: false },
    repoEntries: [{ proj_hash: "f1x7ur3hash0", project_root: null, last_indexed_ts: "2026-06-09T00:00:00.000Z", status: "ready" as const }] as never,
  });
  for (let i = 0; i < 4; i++) await tick();
  return { root, posts };
}

const text = (root: HTMLElement, sel: string): string => root.querySelector<HTMLElement>(sel)?.textContent ?? "";

describe("Code Map acts on the index freshness check", () => {
  test("index behind: header names the drift, button re-indexes instead of claiming 'Diagram is current'", async () => {
    const { root, posts } = await mountWith(() => Promise.resolve(jsonResponse({ success: true, data: STALE })), true);
    const line = root.querySelector<HTMLElement>("#rg-index-stale");
    expect(line?.hidden).toBe(false);
    expect(line?.textContent).toBe("· code changed since this map was indexed: 4 files edited, 3 new — re-index");
    expect(text(root, "#rg-arch-gen-label")).toBe("↻ Re-index — code changed");
    expect(text(root, "#rg-arch-gen-cost")).not.toContain("Diagram is current");

    root.querySelector<HTMLButtonElement>("#rg-arch-gen")?.click();
    await tick();
    expect(posts.map((b) => JSON.parse(b).path)).toEqual(["/tmp/island-harness-fixture-repo"]);
  });

  test("the header line itself re-indexes when clicked", async () => {
    const { root, posts } = await mountWith(() => Promise.resolve(jsonResponse({ success: true, data: STALE })), false);
    root.querySelector<HTMLButtonElement>("#rg-index-stale")?.click();
    await tick();
    expect(posts).toHaveLength(1);
  });

  test("index behind but the repo path is unknown: the button never generates, the line offers no dead re-index", async () => {
    // Review of 395fd691: the label said Re-index while the click fell through
    // to a paid generate when the repo entry carried no project_root.
    const generates: string[] = [];
    const { root, posts } = await mountWithRepos(
      () => Promise.resolve(jsonResponse({ success: true, data: STALE })),
      generates,
    );
    expect(text(root, "#rg-arch-gen-label")).toBe("↻ Re-index — code changed");
    expect(text(root, "#rg-index-stale")).toBe("· code changed since this map was indexed: 4 files edited, 3 new");
    root.querySelector<HTMLButtonElement>("#rg-arch-gen")?.click();
    for (let i = 0; i < 3; i++) await tick();
    expect(posts).toEqual([]);
    expect(generates).toEqual([]);
    // The Re-generate confirm (confirm-modal.ts) mounts on document.body.
    expect(document.querySelector('[role="dialog"].cm-dialog')).toBeNull();
    expect(text(root, "#rg-arch-gen-cost")).toBe("re-index from the repo picker — this repo's path is unknown");
  });

  test("a failed check never reads as 'Diagram is current'", async () => {
    const { root } = await mountWith(() => Promise.resolve(new Response("boom", { status: 500 })), true);
    expect(text(root, "#rg-arch-gen-cost")).toBe("index freshness unknown");
    expect(root.querySelector<HTMLElement>("#rg-index-stale")?.hidden).toBe(true);
  });

  test("the first Generate's cost survives the check answering after the estimate", async () => {
    let release: () => void = () => {};
    const late = new Promise<void>((r) => {
      release = r;
    });
    const { root } = await mountWith(
      () => late.then(() => jsonResponse({ success: true, data: { ...STALE, level: "fresh", counts: { ...STALE.counts, content_changed: 0, unindexed_files: 0, wrong_ratio: 0 } } })),
      false,
    );
    expect(text(root, "#rg-arch-gen-cost")).toContain("≈$0.20");
    release();
    for (let i = 0; i < 4; i++) await tick();
    expect(text(root, "#rg-arch-gen-cost")).toContain("≈$0.20");
  });
});
