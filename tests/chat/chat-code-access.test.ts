/**
 * The chat's context bar says whether chat can open the user's files
 * (src/chat/repo-access.ts `previewCodeAccess`, src/web/client/lib/chat-code-access.ts).
 *
 * The promise: the bar says "can open your files" exactly when the next
 * message would run claude in a project folder. The parity block below sends
 * the same inputs to the preview and to the real send path and compares.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { openIndex } from "../../src/chat/fts5-index";
import { previewCodeAccess } from "../../src/chat/repo-access";
import { emptyMemory, writeMemory } from "../../src/memory/memory";
import { mountChatRoutes } from "../../src/daemon/routes/chat";
import type { StreamChatOptions, StreamEvent } from "../../src/daemon/routes/chat-stream";
import { makeFloatingChatData, type ViewedNode } from "../../src/web/client/islands/floating-chat";
import { codeAccessChip, codeAccessQuery } from "../../src/web/client/lib/chat-code-access";
import type { CodeMapViewPayload } from "../../src/web/client/lib/code-map-view";

const SECRET = "test-secret";
const PROJ = tmpdir();
const PINNED = process.cwd();
const GONE = join(tmpdir(), "siltpoke-no-such-project-5521");
const ROOTS: Record<string, string> = { abc123: PROJ, def456: PINNED, dead00: GONE };
const resolve = async (h: string) => ROOTS[h] ?? null;
const CODEX = { kind: "use", family: "codex", source: "settings" } as never;
const homes: string[] = [];
afterEach(() => {
  for (const h of homes.splice(0)) rmSync(h, { recursive: true, force: true });
});

describe("previewCodeAccess: the server's answer", () => {
  const noSessions = async () => [];
  const base = { resolution: undefined, listSessions: noSessions, resolve };

  test("claude + the Code Map's open project → reads; no project → no_project", async () => {
    expect(await previewCodeAccess({ ...base, viewHash: "abc123" })).toBe("reads");
    expect(await previewCodeAccess(base)).toBe("no_project");
    expect(await previewCodeAccess({ ...base, viewHash: "ffffff" })).toBe("no_project");
    expect(await previewCodeAccess({ ...base, viewHash: "abc123", resolve: undefined })).toBe("no_project");
  });

  test("another agent answers → agent, whatever the project", async () => {
    expect(await previewCodeAccess({ ...base, resolution: CODEX, viewHash: "abc123" })).toBe("agent");
    expect(await previewCodeAccess({ ...base, resolution: { kind: "none" } as never })).toBe("agent");
  });

  test("the conversation's own project wins over the view, even when its folder is gone", async () => {
    expect(await previewCodeAccess({ ...base, anchorHash: "def456", viewHash: "ffffff" })).toBe("reads");
    // Send path: a resolved-but-missing root does not fall back to the view.
    expect(await previewCodeAccess({ ...base, anchorHash: "dead00", viewHash: "abc123" })).toBe("no_project");
    // An anchor hash nobody knows does fall back (memScope stays GLOBAL_ONLY).
    expect(await previewCodeAccess({ ...base, anchorHash: "ffffff", viewHash: "abc123" })).toBe("reads");
  });

  test("a stored session anchor beats the anchor hash in the query", async () => {
    const listSessions = async () => [{ id: "s-1", anchor: { proj_hash: "dead00" } }];
    expect(await previewCodeAccess({ ...base, listSessions, session: "s-1", anchorHash: "abc123" })).toBe("no_project");
    expect(await previewCodeAccess({ ...base, listSessions, session: "s-2", anchorHash: "abc123" })).toBe("reads");
  });

  test("malformed query values are ignored; a failing read never throws", async () => {
    let listed = 0;
    const listSessions = async () => {
      listed++;
      return [{ id: "../x", anchor: { proj_hash: "abc123" } }];
    };
    expect(await previewCodeAccess({ ...base, listSessions, session: "../x" })).toBe("no_project");
    expect(listed).toBe(0);
    expect(await previewCodeAccess({ ...base, viewHash: "../../etc" })).toBe("no_project");
    expect(await previewCodeAccess({ ...base, anchorHash: "ABC123" })).toBe("no_project");
    const throws = async () => {
      throw new Error("io");
    };
    expect(await previewCodeAccess({ ...base, listSessions: throws, session: "s-1", viewHash: "abc123" })).toBe("reads");
    expect(await previewCodeAccess({ ...base, resolve: throws, anchorHash: "abc123" })).toBe("no_project");
  });
});

/** One app wired like production's chat routes, with a stream that records its options. */
function app(resolveChatProvider?: () => unknown) {
  const home = mkdtempSync(join(tmpdir(), "siltpoke-code-access-"));
  homes.push(home);
  const seen: StreamChatOptions[] = [];
  const stream = async function* (opts: StreamChatOptions): AsyncGenerator<StreamEvent> {
    seen.push(opts);
    yield { type: "message_start", message_id: "m-1", model: "mock" } as StreamEvent;
    yield { type: "content_block_delta", text: "ok" } as StreamEvent;
    yield { type: "message_stop", usage: { input_tokens: 1, output_tokens: 1 }, full_text: "ok" } as StreamEvent;
  };
  const a = new Hono();
  mountChatRoutes(a, {
    resolveProject: async () => ({ project_id: null, proj_hash: null, project_root: null, display_name: null, source: "explicit" as const }),
    homeBase: home,
    index: openIndex(home),
    secret: SECRET,
    streamFactory: stream,
    resolveProjectRootByHash: resolve,
    ...(resolveChatProvider ? { resolveChatProvider } : {}),
  } as never);
  return { a, seen, home };
}

describe("the route says the same thing the send does", () => {
  const cases: Array<[string, string | undefined]> = [
    ["open project, claude", "abc123"],
    ["no project, claude", undefined],
    ["unknown project, claude", "ffffff"],
  ];
  for (const [name, hash] of cases) {
    test(name, async () => {
      const { a, seen } = app();
      const view = { repo: "proj", selection: null, ...(hash ? { proj_hash: hash } : {}) };
      const q = hash ? `&view_hash=${hash}` : "";
      const preview = (await (await a.request(`/api/chat/context-preview?page=/repo-graph${q}`)).json()) as {
        code_access: string;
      };
      const res = await a.request("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Siltpoke-Secret": SECRET },
        body: JSON.stringify({ message: "what is in utils?", page: "/repo-graph", view }),
      });
      await res.text();
      expect(seen).toHaveLength(1);
      expect(preview.code_access === "reads").toBe(seen[0].cwd !== undefined);
    });
  }

  test("the route passes the conversation and the anchor through", async () => {
    const { a, home } = app();
    const anchor = { node_id: "function:src/a.ts:f", proj_hash: "dead00", node_name: "f", node_type: "function", fingerprint: null, pinned_at: "t", kind: "node" as const, critique_id: null };
    const session = { id: "s-1", started_at: "t", ended_at: null, message_count: 1, summary: "x", summary_generated_at: null, tags: [], anchor };
    await writeMemory(home, { ...emptyMemory(), chat_sessions: [session] });
    const ask = async (q: string) =>
      ((await (await a.request(`/api/chat/context-preview?page=/repo-graph${q}`)).json()) as { code_access: string }).code_access;
    expect(await ask("&anchor_hash=abc123")).toBe("reads");
    // The stored anchor's folder is gone, and it wins over the view.
    expect(await ask("&session=s-1&view_hash=abc123")).toBe("no_project");
    expect(await ask("&session=s-9&view_hash=abc123")).toBe("reads");
  });

  // Not sent: the codex path ignores the stream seam and would spawn a real codex.
  // The send side of "only claude reads" is pinned in tests/chat/repo-access.test.ts.
  test("open project, codex → agent", async () => {
    const { a } = app(() => CODEX);
    const res = await a.request("/api/chat/context-preview?page=/repo-graph&view_hash=abc123");
    expect(((await res.json()) as { code_access: string }).code_access).toBe("agent");
  });
});

const VIEW: CodeMapViewPayload = { repo: "proj", selection: null, proj_hash: "abc123" };
const NODE: ViewedNode = { target: { name: "f", path: "src/a.ts", node_type: "function" }, projHash: "def456", label: "f" };

describe("the client: the question and the words", () => {
  test("an unpinned conversation on the Code Map asks about the open project", () => {
    expect(codeAccessQuery({ serverSessionId: null, anchor: null }, VIEW, true)).toBe("&view_hash=abc123");
    expect(codeAccessQuery({ serverSessionId: "s-1", anchor: null }, VIEW, true)).toBe("&session=s-1&view_hash=abc123");
    // Off the Code Map the message would not carry the view, so neither does the question.
    expect(codeAccessQuery({ serverSessionId: null, anchor: null }, VIEW, false)).toBe("");
    expect(codeAccessQuery(null, VIEW, true)).toBe("");
  });

  test("a pinned conversation asks about its own project, never the view", () => {
    expect(codeAccessQuery({ serverSessionId: null, anchor: NODE }, VIEW, true)).toBe("&anchor_hash=def456");
    expect(codeAccessQuery({ serverSessionId: null, anchor: null, critiqueAnchor: { proj_hash: "abc123" } }, VIEW, true)).toBe(
      "&anchor_hash=abc123",
    );
  });

  test("after the pin is sent the anchor is not asked about again (the send does not carry it either)", () => {
    // A pin the server never stored (anchor did not resolve) runs with no
    // project; asking with the anchor hash would answer "can open" (review, 2026-10-18).
    expect(codeAccessQuery({ serverSessionId: "s-1", anchor: NODE, pinSent: true }, VIEW, true)).toBe("&session=s-1");
    expect(
      codeAccessQuery({ serverSessionId: "s-1", anchor: null, critiqueAnchor: { proj_hash: "abc123" }, pinSent: true }, VIEW, true),
    ).toBe("&session=s-1");
  });

  test("can open: shown everywhere; can't open: only where code is expected", () => {
    expect(codeAccessChip("reads", false)?.label).toBe("can open your files");
    expect(codeAccessChip("agent", true)?.label).toBe("can't open your files");
    expect(codeAccessChip("agent", true)?.title).toContain("Only claude opens your files");
    expect(codeAccessChip("no_project", true)?.title).toContain("no project folder");
    expect(codeAccessChip("agent", false)).toBeNull();
    expect(codeAccessChip("no_project", false)).toBeNull();
    expect(codeAccessChip(undefined, true)).toBeNull();
  });
});

describe("the island: the chip follows the conversation and the project", () => {
  function island(answer: (url: string) => string) {
    const asked: string[] = [];
    let view: CodeMapViewPayload | null = VIEW;
    const fetchFn = (async (url: string) => {
      asked.push(String(url));
      return Response.json({ page_label: "Repo Graph", facts_count: 0, code_access: answer(String(url)) });
    }) as unknown as typeof fetch;
    const d = makeFloatingChatData(fetchFn, {
      onGraph: () => true,
      getViewed: () => null,
      getView: () => view,
      pageProvider: () => "/repo-graph",
    });
    d.syncViewed();
    d.newConversation();
    d.open = true;
    return { d, asked, setView: (v: CodeMapViewPayload | null) => (view = v) };
  }
  const tick = () => new Promise((r) => setTimeout(r, 0));

  test("asks once per question, shows the answer, hides it while a new question is pending", async () => {
    const { d, asked, setView } = island((u) => (u.includes("view_hash=abc123") ? "reads" : "no_project"));
    expect(d.contextChips().code).toBeNull(); // asked, not answered yet
    d.contextChips();
    expect(asked).toEqual(["/api/chat/context-preview?page=%2Frepo-graph&view_hash=abc123"]);
    await tick();
    expect(d.contextChips().code?.label).toBe("can open your files");
    expect(asked).toHaveLength(1);

    setView({ repo: "other", selection: null });
    d.syncViewed();
    expect(d.contextChips().code).toBeNull(); // old answer is not shown for the new project
    await tick();
    expect(asked[1]).toBe("/api/chat/context-preview?page=%2Frepo-graph");
    expect(d.contextChips().code?.label).toBe("can't open your files");
  });

  test("an answer to an old question does not overwrite a newer one", async () => {
    const pending: Array<() => void> = [];
    const asked: string[] = [];
    let view: CodeMapViewPayload | null = VIEW;
    const fetchFn = (async (url: string) => {
      asked.push(String(url));
      const code_access = String(url).includes("view_hash") ? "reads" : "no_project";
      await new Promise<void>((r) => pending.push(r));
      return Response.json({ page_label: "Repo Graph", facts_count: 0, code_access });
    }) as unknown as typeof fetch;
    const d = makeFloatingChatData(fetchFn, { onGraph: () => true, getViewed: () => null, getView: () => view, pageProvider: () => "/repo-graph" });
    d.syncViewed();
    d.newConversation();
    d.open = true;
    d.contextChips(); // question 1 (view_hash)
    view = { repo: "other", selection: null };
    d.syncViewed();
    d.contextChips(); // question 2 (no view hash)
    expect(asked).toHaveLength(2);
    pending[1]();
    await tick();
    pending[0]();
    await tick();
    expect(d.contextChips().code?.label).toBe("can't open your files");
  });

  test("no conversation yet: no chip", async () => {
    const fetchFn = (async () => Response.json({ page_label: "Repo Graph", facts_count: 0, code_access: "no_project" })) as unknown as typeof fetch;
    const d = makeFloatingChatData(fetchFn, { onGraph: () => true, getViewed: () => null, getView: () => VIEW, pageProvider: () => "/repo-graph" });
    d.syncViewed();
    d.open = true;
    d.contextChips();
    await tick();
    expect(d.contextChips().code).toBeNull();
  });

  test("Alpine's fresh proxy per evaluation does not make it ask again", async () => {
    // Alpine evaluates each binding through a NEW merged proxy, so `this`
    // differs on every call. A `this`-keyed cache missed every time and
    // looped (a CI run: five chat e2e specs timed out).
    const { d, asked } = island(() => "reads");
    const render = () => {
      const scope = new Proxy(d, {});
      return [1, 2, 3, 4, 5].map(() => scope.contextChips.call(new Proxy(d, {})));
    };
    render();
    await tick();
    render();
    await tick();
    render();
    expect(asked).toHaveLength(1);
    expect(render()[0].code?.label).toBe("can open your files");
  });

  test("closed panel: no question is asked", () => {
    const { d, asked } = island(() => "reads");
    d.open = false;
    asked.length = 0;
    d.contextChips();
    expect(asked).toHaveLength(0);
  });
});
