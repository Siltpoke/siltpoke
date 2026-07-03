/**
 * HTTP/observable acceptance tests for the context-aware
 * floating-chat behavior + INV1/INV2 machine-checks.
 *
 * Each test drives the MOUNTED Hono app via app.request() — the same surface
 * the running daemon exposes. No internal functions are called directly; all
 * assertions are on HTTP responses or persisted state that a client could
 * observe (session list, sidecar existence, append-state).
 *
 * Covered by HTTP tests here:
 *   anchor pinned at creation; sidecar written once (resolveAnchor
 *   called once; subsequent sends do NOT re-call it).
 *   navigation / additional POST sends do NOT change a pinned
 *   session's anchor; PATCH re-anchor is the ONLY mutation path (INV1).
 *   PATCH /api/chat/sessions/:id/anchor → re-resolves + returns
 *   {ok, anchor}; session_not_found / node_not_found leave the
 *   stored anchor intact (INV1).
 *   pinned + fingerprint changed + no anchor_decision →
 *   JSON {blocked:"stale"}; message NOT appended; no stream.
 *   anchor_decision:"freeze" streams old frozen sidecar.
 *   anchor_decision:"continue" overwrites sidecar + streams.
 *   INV2: no other POST /api/chat path overwrites the sidecar.
 *   pinned node gone (cheapNodeExists "not_found") →
 *   JSON {blocked:"node_gone"}; no stream; no append.
 *   Fail-open when graph unreadable.
 *   checkSendGate → quiet_hours / budget hard →
 *   JSON {blocked:…}; no stream; no append; gate runs BEFORE
 *   node_gone (dead node while quiet → quiet_hours wins).
 *   Soft / null → streams unblocked.
 *
 * NOT HTTP-observable (UI-only) — covered by Playwright:
 *   floating chat button visible on dashboard.
 *   "+" button starts a new conversation.
 *   persistent anchor indicator per conversation.
 *   inline CTA with two choices when current-view ≠ anchor (UI).
 *   "return to source" jump affordance.
 *   conversation list labels per anchor node name.
 *   auto-create on first open with node selected.
 *   "+" disabled with tooltip when no node selected.
 *   active-conversation switching visible + explicit.
 *
 * INV1 machine-check: tests/daemon/chat-reanchor.test.ts
 *   "INV1: POST to existing session does NOT change the anchor" +
 *   "node_not_found → 404, existing anchor is NOT mutated" fully cover this.
 *   This file adds a complementary HTTP-level assertion (navigation group below).
 *
 * INV2 machine-check: tests/daemon/chat-anchor.test.ts
 *   "INV2: only the 'continue' branch overwrites the sidecar" fully covers
 *   the POST /api/chat paths. This file adds an HTTP-level complementary
 *   assertion (stale-fingerprint group below).
 */
import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { Hono } from "hono";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mountChatRoutes, type ChatAnchorRef, type BudgetSignal, type QuietHoursSignal } from "../../src/daemon/routes/chat";
import { openIndex } from "../../src/chat/fts5-index";
import { readAnchorContext } from "../../src/chat/anchor-store";
import { readMemory } from "../../src/memory/memory";
import { readSession } from "../../src/chat/jsonl-store";
import type { ResolveAnchorResult } from "../../src/chat/anchor-context";
import type { StreamChatOptions, StreamEvent } from "../../src/daemon/routes/chat-stream";

// ── Shared fixtures ───────────────────────────────────────────────────────────

let home: string;
let capturedStreams: StreamChatOptions[];

function fakeStream(opts: StreamChatOptions): AsyncGenerator<StreamEvent, void, void> {
  capturedStreams.push(opts);
  return (async function* () {
    yield { type: "message_start", message_id: "m-acc-test", model: "mock" };
    yield { type: "content_block_delta", text: "acceptance reply" };
    yield {
      type: "message_stop",
      usage: { input_tokens: 2, output_tokens: 3 },
      full_text: "acceptance reply",
    };
  })();
}

const ANCHOR_A: ResolveAnchorResult = {
  kind: "resolved",
  context: {
    nodeId: "function:src/foo.ts:applyDiscount",
    nodeName: "applyDiscount",
    nodeType: "function",
    path: "src/foo.ts",
    contextBundle: "SOURCE: return p * (1 - pct)",
    systemPrompt: "CHAT-SYS",
    fingerprint: "sha-foo-123",
    includedSources: ["src/foo.ts"],
    truncated: false,
  },
};

const ANCHOR_B: ResolveAnchorResult = {
  kind: "resolved",
  context: {
    nodeId: "function:src/bar.ts:computeTotal",
    nodeName: "computeTotal",
    nodeType: "function",
    path: "src/bar.ts",
    contextBundle: "SOURCE: return items.reduce(...)",
    systemPrompt: "CHAT-SYS-B",
    fingerprint: "sha-bar-456",
    includedSources: ["src/bar.ts"],
    truncated: false,
  },
};

const ANCHOR_A_FRESH: ResolveAnchorResult = {
  kind: "resolved",
  context: {
    ...ANCHOR_A.context,
    contextBundle: "SOURCE: return p * discount — FRESH",
    systemPrompt: "CHAT-SYS-FRESH",
    fingerprint: "sha-foo-999",
  },
};

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "siltpoke-2c-acc-"));
  capturedStreams = [];
});
afterEach(() => rmSync(home, { recursive: true, force: true }));

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeApp(
  resolveAnchor?: (a: ChatAnchorRef) => Promise<ResolveAnchorResult>,
  overrides: Partial<Parameters<typeof mountChatRoutes>[1]> = {},
): Hono {
  const a = new Hono();
  mountChatRoutes(a, {
    homeBase: home,
    index: openIndex(home),
    streamFactory: fakeStream,
    resolveAnchor,
    now: () => new Date("2026-06-22T20:00:00.000Z"),
    ...overrides,
  });
  return a;
}

async function postChat(a: Hono, body: unknown): Promise<Response> {
  return a.request("/api/chat", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

async function patchAnchor(a: Hono, sessionId: string, body: unknown): Promise<Response> {
  return a.request(`/api/chat/sessions/${sessionId}/anchor`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

/** Consume the SSE body so the stream's async start() completes (persists state). */
async function drain(res: Response): Promise<void> {
  await res.text();
}

/** Write a fake graph storage dir with graph.json + fingerprints.json. */
let _graphSeq = 0;
function makeGraphStorage(
  nodePresent: boolean,
  currentSha = "sha-foo-123",
): string {
  const dir = join(home, `fake-graph-${++_graphSeq}`);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "meta.json"),
    JSON.stringify({ schemaVersion: 1, projHash: "proj-abc", indexedAt: "2026-06-22T00:00:00.000Z" }),
  );
  const nodes = nodePresent
    ? [{ id: "function:src/foo.ts:applyDiscount", type: "function", name: "applyDiscount", path: "src/foo.ts", lineRange: [1, 10] }]
    : [];
  writeFileSync(join(dir, "graph.json"), JSON.stringify({ schemaVersion: 1, nodes, edges: [] }));
  writeFileSync(
    join(dir, "fingerprints.json"),
    JSON.stringify({ schemaVersion: 1, files: { "src/foo.ts": { content_sha256: currentSha, ast_sig: "ast-x" } } }),
  );
  return dir;
}

/** Pin a new conversation to ANCHOR_A. Returns session id. */
async function pinSession(a: Hono): Promise<string> {
  const res = await postChat(a, {
    message: "what is this?",
    anchor: { node_id: "function:src/foo.ts:applyDiscount", proj_hash: "proj-abc" },
  });
  const sid = res.headers.get("X-Siltpoke-Session-Id")!;
  await drain(res);
  return sid;
}

// ── anchor pinned at creation; resolveAnchor called once ─────────

describe("anchor pinned at creation, sidecar cached once", () => {
  test("POST with anchor → conversation pinned; no-feed: systemPrompt carries node context", async () => {
    // What this guarantees: creating a session with an anchor causes
    // the node's context to be frozen to a sidecar and injected as the
    // systemPrompt on the FIRST send — no user-supplied code in the message.
    let resolveCount = 0;
    const a = makeApp(async () => { resolveCount++; return ANCHOR_A; });

    const res = await postChat(a, {
      message: "what is applyDiscount?",
      anchor: { node_id: "function:src/foo.ts:applyDiscount", proj_hash: "proj-abc" },
    });
    expect(res.status).not.toBe(400);
    const sid = res.headers.get("X-Siltpoke-Session-Id");
    expect(sid).toBeTruthy();
    await drain(res);

    // resolveAnchor called exactly once (at pin time, not per send)
    expect(resolveCount).toBe(1);

    // Sidecar written at pin time (cache)
    const sidecar = await readAnchorContext(home, sid!);
    expect(sidecar?.contextBundle).toContain("return p * (1 - pct)");

    // The stream received node context as systemPrompt — the no-feed point
    expect(capturedStreams).toHaveLength(1);
    expect(capturedStreams[0].systemPrompt).toContain("CHAT-SYS");
    expect(capturedStreams[0].systemPrompt).toContain("return p * (1 - pct)");

    // Session record has pinned anchor metadata
    const mem = await readMemory(home);
    const sess = mem?.chat_sessions.find((s) => s.id === sid);
    expect(sess?.anchor?.node_id).toBe("function:src/foo.ts:applyDiscount");
    expect(sess?.anchor?.fingerprint).toBe("sha-foo-123");
  });

  test("second send does NOT call resolveAnchor again (sidecar cached at creation)", async () => {
    // What this guarantees: the anchor context (subgraph + fingerprint) is
    // cached at pin time; subsequent sends read from the sidecar, not by
    // re-deriving the context (cost control).
    let resolveCount = 0;
    const a = makeApp(async () => { resolveCount++; return ANCHOR_A; });

    const sid = await pinSession(a); // resolveCount = 1
    const resolveAfterPin = resolveCount;
    capturedStreams = []; // reset

    // Second send to the SAME session — no anchor re-derive
    const res2 = await postChat(a, { session_id: sid, message: "follow-up question" });
    await drain(res2);

    // resolveAnchor NOT called again for the second send (sidecar used from cache)
    expect(resolveCount).toBe(resolveAfterPin);

    // Stream still received the cached system prompt (sidecar still injected)
    expect(capturedStreams).toHaveLength(1);
    expect(capturedStreams[0].systemPrompt).toContain("CHAT-SYS");
  });
});

// ── navigation does NOT re-pin; PATCH is the ONLY mutation (INV1) ───────

describe("navigation/additional sends do NOT change anchor; PATCH is the only mutation", () => {
  test("POST to existing session with different anchor field does NOT change pinned anchor", async () => {
    // What this guarantees: the anchor is hard-pinned at creation. Sending
    // a message with a different anchor field on an existing session is ignored
    // (no re-pinning, no resolveAnchor call for the existence re-pin path).
    let resolveCount = 0;
    const a = makeApp(async () => { resolveCount++; return ANCHOR_A; });

    const sid = await pinSession(a); // resolveCount = 1
    const sidecarBefore = await readAnchorContext(home, sid);
    capturedStreams = [];
    resolveCount = 0;

    // Second POST: provides a different anchor — must be ignored
    const res = await postChat(a, {
      session_id: sid,
      message: "new question",
      anchor: { node_id: "function:src/bar.ts:computeTotal", proj_hash: "proj-abc" },
    });
    await drain(res);

    // resolveAnchor NOT called for the second-send anchor (not a new session)
    expect(resolveCount).toBe(0);

    // Sidecar unchanged (INV1)
    const sidecarAfter = await readAnchorContext(home, sid);
    expect(sidecarAfter?.nodeId).toBe(sidecarBefore?.nodeId);
    expect(sidecarAfter?.fingerprint).toBe(sidecarBefore?.fingerprint);

    // Session anchor metadata unchanged (INV1)
    const mem = await readMemory(home);
    const sess = mem?.chat_sessions.find((s) => s.id === sid);
    expect(sess?.anchor?.node_id).toBe("function:src/foo.ts:applyDiscount");
  });

  test("INV1: PATCH re-anchor IS the only mutation that changes the stored anchor", async () => {
    // What this invariant guarantees: the only code path that legitimately
    // mutates a session's anchor after creation is PATCH /api/chat/sessions/:id/anchor.
    // This complements the unit tests in chat-reanchor.test.ts with an HTTP-level check.
    let resolveCount = 0;
    const a = makeApp(async () => {
      resolveCount++;
      return resolveCount === 1 ? ANCHOR_A : ANCHOR_B;
    });

    const sid = await pinSession(a); // resolveCount = 1
    capturedStreams = [];

    // PATCH re-anchor → the ONLY permitted mutation
    const patchRes = await patchAnchor(a, sid, {
      node_id: "function:src/bar.ts:computeTotal",
      proj_hash: "proj-abc",
    });
    expect(patchRes.status).toBe(200);
    const json = await patchRes.json() as { ok: boolean; anchor: Record<string, unknown> };
    expect(json.ok).toBe(true);
    expect(json.anchor.node_id).toBe("function:src/bar.ts:computeTotal");
    expect(json.anchor.node_name).toBe("computeTotal");

    // Sidecar updated to ANCHOR_B
    const sidecar = await readAnchorContext(home, sid);
    expect(sidecar?.nodeId).toBe("function:src/bar.ts:computeTotal");
    expect(sidecar?.contextBundle).toContain("items.reduce");

    // Session meta also updated
    const mem = await readMemory(home);
    const sess = mem?.chat_sessions.find((s) => s.id === sid);
    expect(sess?.anchor?.node_id).toBe("function:src/bar.ts:computeTotal");
    expect(sess?.anchor?.fingerprint).toBe("sha-bar-456");

    // JSONL history unchanged (conversation continuity)
    const msgs = await readSession(home, sid);
    expect(msgs.some((m) => m.content === "what is this?")).toBe(true);
  });
});

// ── PATCH re-anchor: happy + error paths ────────────────────────────────

describe("PATCH /api/chat/sessions/:id/anchor", () => {
  test("happy path: re-resolves node + returns {ok, anchor}", async () => {
    // What this guarantees: the one-click re-anchor changes the conversation's
    // context to the currently-viewed node. Returns {ok: true, anchor: {…}}.
    let resolveCount = 0;
    const a = makeApp(async () => {
      resolveCount++;
      return resolveCount === 1 ? ANCHOR_A : ANCHOR_B;
    });
    const sid = await pinSession(a);
    capturedStreams = [];

    const res = await patchAnchor(a, sid, { node_id: "function:src/bar.ts:computeTotal", proj_hash: "proj-abc" });
    expect(res.status).toBe(200);
    const json = await res.json() as { ok: boolean; anchor: Record<string, unknown> };
    expect(json.ok).toBe(true);
    expect(json.anchor.node_id).toBe("function:src/bar.ts:computeTotal");
    expect(json.anchor.fingerprint).toBe("sha-bar-456");
    expect(json.anchor.pinned_at).toBeTruthy();
  });

  test("session_not_found: PATCH for unknown session → 404; no sidecar written", async () => {
    // What this guarantees: a non-existent session_id returns a clear error
    // and leaves no orphaned sidecar.
    const a = makeApp(async () => ANCHOR_B);
    const res = await patchAnchor(a, "s-does-not-exist", { node_id: "function:src/bar.ts:computeTotal", proj_hash: "proj-abc" });
    expect(res.status).toBe(404);
    const json = await res.json() as { error: string };
    expect(json.error).toBe("session_not_found");

    // No sidecar left behind (consistency: sidecar is only written after session confirmed)
    const sidecar = await readAnchorContext(home, "s-does-not-exist");
    expect(sidecar).toBeNull();
  });

  test("node_not_found: PATCH with bad node → 404; stored anchor is intact (INV1)", async () => {
    // What this guarantees: a failed re-anchor attempt (node doesn't exist)
    // returns node_not_found and leaves the existing anchor untouched (INV1).
    const a = makeApp(async (ref) => {
      const nodeId = "node_id" in ref ? ref.node_id : "";
      if (nodeId.includes("bad")) return { kind: "node_not_found", target: { node_id: nodeId } };
      return ANCHOR_A;
    });

    const sid = await pinSession(a);
    const sidecarBefore = await readAnchorContext(home, sid);

    const res = await patchAnchor(a, sid, { node_id: "bad:node:id", proj_hash: "proj-abc" });
    expect(res.status).toBe(404);
    expect((await res.json() as { error: string }).error).toBe("node_not_found");

    // Anchor NOT mutated (INV1)
    const sidecarAfter = await readAnchorContext(home, sid);
    expect(sidecarAfter?.nodeId).toBe(sidecarBefore?.nodeId);
  });
});

// ── stale fingerprint gate (INV2) ─────────────────────────────────────

describe("pinned + fingerprint changed", () => {
  /** App with getGraphStorageDir wired to return a dir with given sha for src/foo.ts. */
  function appWithFp(resolveAnchorFn: (a: ChatAnchorRef) => Promise<ResolveAnchorResult>, currentSha: string): Hono {
    const dir = makeGraphStorage(true /* nodePresent */, currentSha);
    return makeApp(resolveAnchorFn, {
      getGraphStorageDir: async () => dir,
    });
  }

  test("pinned + fingerprint CHANGED + no anchor_decision → JSON {blocked:'stale'}; message NOT appended; no stream", async () => {
    // What this guarantees: when the node's code has changed since pin time,
    // the system blocks the send with a structured signal so the user can decide.
    const a = appWithFp(async () => ANCHOR_A, "sha-foo-CHANGED");
    const sid = await pinSession(a);
    capturedStreams = [];

    const res = await postChat(a, { session_id: sid, message: "stale question" });

    // Must be JSON block signal, not SSE
    expect(res.headers.get("Content-Type")).toContain("application/json");
    const signal = await res.json() as Record<string, unknown>;
    expect(signal.blocked).toBe("stale");
    expect(signal.pinned_fingerprint).toBe("sha-foo-123");
    expect(signal.current_fingerprint).toBe("sha-foo-CHANGED");
    expect(signal.node_name).toBe("applyDiscount");
    expect(signal.pinned_at).toBeTruthy();
    expect(signal.v4_file_level_only).toBe(true);

    // No stream started (blocks before streaming)
    expect(capturedStreams).toHaveLength(0);

    // Message NOT appended (INV2: not answered, not in transcript)
    const msgs = await readSession(home, sid);
    const userMsgs = msgs.filter((m) => m.role === "user");
    // Only the original pin message ("what is this?") is present
    expect(userMsgs).toHaveLength(1);
    expect(userMsgs[0].content).toBe("what is this?");
  });

  test("freeze: anchor_decision='freeze' → streams with EXISTING frozen sidecar; sidecar unchanged", async () => {
    // What this guarantees: the "freeze" choice keeps discussing the old
    // code version — sidecar is NOT overwritten.
    const a = appWithFp(async () => ANCHOR_A, "sha-foo-CHANGED");
    const sid = await pinSession(a);
    const sidecarBefore = await readAnchorContext(home, sid);
    capturedStreams = [];

    const res = await postChat(a, { session_id: sid, message: "keep old", anchor_decision: "freeze" });

    // Must be SSE (proceed with frozen context)
    expect(res.headers.get("Content-Type")).toContain("text/event-stream");
    await drain(res);
    expect(capturedStreams).toHaveLength(1);
    // Stream used the OLD frozen context
    expect(capturedStreams[0].systemPrompt).toContain("return p * (1 - pct)");
    // Sidecar unchanged (freeze = no overwrite)
    const sidecarAfter = await readAnchorContext(home, sid);
    expect(sidecarAfter?.fingerprint).toBe(sidecarBefore?.fingerprint);
    expect(sidecarAfter?.contextBundle).toBe(sidecarBefore?.contextBundle);

    // Message WAS appended (freeze does send)
    const msgs = await readSession(home, sid);
    expect(msgs.filter((m) => m.role === "user")).toHaveLength(2);
  });

  test("continue: anchor_decision='continue' → sidecar overwritten + streams fresh (INV2 explicit path)", async () => {
    // What this guarantees: "continue" is the ONLY POST path that overwrites
    // the sidecar with a newer fingerprint (INV2). Stream uses the fresh context.
    let callCount = 0;
    const dir = makeGraphStorage(true /* nodePresent */, "sha-foo-CHANGED");
    const a = makeApp(async () => {
      callCount++;
      return callCount === 1 ? ANCHOR_A : ANCHOR_A_FRESH;
    }, { getGraphStorageDir: async () => dir });

    const sid = await pinSession(a); // callCount = 1
    capturedStreams = [];

    const res = await postChat(a, { session_id: sid, message: "use new version", anchor_decision: "continue" });

    expect(res.headers.get("Content-Type")).toContain("text/event-stream");
    await drain(res);
    expect(capturedStreams).toHaveLength(1);

    // Stream used FRESH context
    expect(capturedStreams[0].systemPrompt).toContain("FRESH");

    // Sidecar overwritten with fresh fingerprint (the only permitted re-derive)
    const sidecar = await readAnchorContext(home, sid);
    expect(sidecar?.fingerprint).toBe("sha-foo-999"); // ANCHOR_A_FRESH fingerprint
    expect(sidecar?.contextBundle).toContain("FRESH");

    // Session record also updated
    const mem = await readMemory(home);
    const sess = mem?.chat_sessions.find((s) => s.id === sid);
    expect(sess?.anchor?.fingerprint).toBe("sha-foo-999");

    // Message WAS appended
    const msgs = await readSession(home, sid);
    expect(msgs.filter((m) => m.role === "user")).toHaveLength(2);
  });

  test("INV2: only the 'continue' branch overwrites the sidecar (all three POST/stale paths covered)", async () => {
    // What this invariant guarantees: no POST /api/chat path silently re-derives
    // a newer fingerprint into the sidecar — only the explicit "continue" choice
    // does so. Exhaustive coverage of all three paths for a stale pinned session.

    // Path 1: no anchor_decision → stale block; sidecar fingerprint UNCHANGED
    const a1 = appWithFp(async () => ANCHOR_A, "sha-foo-CHANGED");
    const sid1 = await pinSession(a1);
    await postChat(a1, { session_id: sid1, message: "p1" });
    expect((await readAnchorContext(home, sid1))?.fingerprint).toBe("sha-foo-123"); // unchanged

    // Path 2: anchor_decision="freeze" → streams old; sidecar fingerprint UNCHANGED
    const a2 = appWithFp(async () => ANCHOR_A, "sha-foo-CHANGED");
    const sid2 = await pinSession(a2);
    await drain(await postChat(a2, { session_id: sid2, message: "p2", anchor_decision: "freeze" }));
    expect((await readAnchorContext(home, sid2))?.fingerprint).toBe("sha-foo-123"); // still old

    // Path 3: anchor_decision="continue" → sidecar overwritten (the ONLY path)
    let resolveCount3 = 0;
    const dir3 = makeGraphStorage(true, "sha-foo-CHANGED");
    const a3 = makeApp(async () => {
      resolveCount3++;
      return resolveCount3 === 1 ? ANCHOR_A : ANCHOR_A_FRESH;
    }, { getGraphStorageDir: async () => dir3 });
    const sid3 = await pinSession(a3);
    await drain(await postChat(a3, { session_id: sid3, message: "p3", anchor_decision: "continue" }));
    expect((await readAnchorContext(home, sid3))?.fingerprint).toBe("sha-foo-999"); // ONLY here
  });
});

// ── dead anchor (node_gone) ───────────────────────────────────────────

describe("dead anchor: pinned node gone", () => {
  test("pinned node GONE → JSON {blocked:'node_gone'}; no stream; message NOT appended", async () => {
    // What this guarantees: if the pinned node no longer exists in the
    // current graph (re-indexed and removed), sends degrade gracefully with a
    // structured terminal signal — no zombie that errors on every send.
    const absentDir = makeGraphStorage(false /* node NOT present */);
    const a = makeApp(async () => ANCHOR_A, { getGraphStorageDir: async () => absentDir });

    const sid = await pinSession(a);
    capturedStreams = [];

    const res = await postChat(a, { session_id: sid, message: "send to dead node" });

    // Must be JSON block signal
    expect(res.headers.get("Content-Type")).toContain("application/json");
    const signal = await res.json() as Record<string, unknown>;
    expect(signal.blocked).toBe("node_gone");
    expect(signal.node_name).toBe("applyDiscount");
    expect(signal.pinned_at).toBeTruthy();

    // No stream started (terminal block, no stream)
    expect(capturedStreams).toHaveLength(0);

    // Message NOT appended (no zombie append)
    const msgs = await readSession(home, sid);
    const userMsgs = msgs.filter((m) => m.role === "user");
    // Only the pin message is present
    expect(userMsgs).toHaveLength(1);
  });

  test("fail-open: graph unreadable → NOT blocked (no_graph path, proceed)", async () => {
    // What this guarantees: when the graph storage is unreadable (e.g. index
    // not yet run), the system does NOT brick the chat. Fail-open = stream proceeds.
    const emptyDir = join(home, "empty-storage");
    mkdirSync(emptyDir, { recursive: true });
    // No meta.json → cheapNodeExists returns "no_graph" → fail-open
    const a = makeApp(async () => ANCHOR_A, { getGraphStorageDir: async () => emptyDir });

    const sid = await pinSession(a);
    capturedStreams = [];

    const res = await postChat(a, { session_id: sid, message: "graph missing" });
    expect(res.headers.get("Content-Type")).toContain("text/event-stream");
    await drain(res);
    expect(capturedStreams).toHaveLength(1);
  });
});

// ── budget gate + quiet-hours ─────────────────────────────────────────

describe("budget gate and quiet-hours block", () => {
  function appWithGate(
    gateResult: BudgetSignal | QuietHoursSignal | null,
    nodePresent = true,
  ): Hono {
    const dir = makeGraphStorage(nodePresent);
    return makeApp(async () => ANCHOR_A, {
      getGraphStorageDir: async () => dir,
      checkSendGate: async () => gateResult,
    });
  }

  test("quiet_hours: gate returns quiet_hours → JSON {blocked:'quiet_hours'}; no stream; message NOT appended", async () => {
    // What this guarantees: sends during quiet hours are clearly blocked —
    // the user sees a structured signal, not a silent failure.
    const a = appWithGate({ blocked: "quiet_hours" });
    const res = await postChat(a, { message: "night question" });

    expect(res.headers.get("Content-Type")).toContain("application/json");
    const signal = await res.json() as Record<string, unknown>;
    expect(signal.blocked).toBe("quiet_hours");

    // No stream (blocked before streaming)
    expect(capturedStreams).toHaveLength(0);
    // We cannot check append because no session_id was returned (blocked before
    // session creation commits), but the captured stream count proves no stream
    // was started, which means the append path in the SSE start() was never reached.
  });

  test("budget hard: gate returns budget → JSON {blocked:'budget', used_pct}; no stream", async () => {
    // What this guarantees: when the daily budget hard-stop is reached, sends
    // are blocked with a structured signal including the usage percentage.
    const a = appWithGate({ blocked: "budget", used_pct: 115.7 });
    const res = await postChat(a, { message: "over budget" });

    expect(res.headers.get("Content-Type")).toContain("application/json");
    const signal = await res.json() as Record<string, unknown>;
    expect(signal.blocked).toBe("budget");
    expect(signal.used_pct).toBe(115.7);
    expect(capturedStreams).toHaveLength(0);
  });

  test("soft budget: gate returns null (soft stage) → streams normally (soft does NOT block)", async () => {
    // What this guarantees: soft budget is intentionally pass-through for
    // chat sends (only the Stop hook's trigger mode changes; chat is unaffected).
    const a = appWithGate(null /* pass — includes soft budget */);
    const res = await postChat(a, { message: "soft budget question" });

    expect(res.headers.get("Content-Type")).toContain("text/event-stream");
    await drain(res);
    expect(capturedStreams).toHaveLength(1);
  });

  test("gate absent: no checkSendGate dep → fails open, streams normally", async () => {
    // What this guarantees: the gate is optional — without it the system
    // behaves as before (never bricks due to missing gate dep).
    const a = makeApp(async () => ANCHOR_A, { checkSendGate: undefined });
    const res = await postChat(a, { message: "no gate dep" });

    expect(res.headers.get("Content-Type")).toContain("text/event-stream");
    await drain(res);
    expect(capturedStreams).toHaveLength(1);
  });

  test("gate ordering: quiet_hours fires BEFORE node_gone (dead node during quiet → quiet_hours)", async () => {
    // What this guarantees: the gate order is budget/quiet → node_gone
    // → stale. A dead-node send during quiet hours reports quiet_hours,
    // not node_gone, so the user knows to retry later rather than start fresh.
    const a = appWithGate({ blocked: "quiet_hours" }, false /* nodePresent: false */);
    // Pin session via a separate app so the anchor is recorded
    const aPin = makeApp(async () => ANCHOR_A);
    const sid = await pinSession(aPin);
    capturedStreams = [];

    const res = await postChat(a, { session_id: sid, message: "dead+quiet" });
    const signal = await res.json() as Record<string, unknown>;
    // quiet_hours fires first (before node_gone)
    expect(signal.blocked).toBe("quiet_hours");
    expect(capturedStreams).toHaveLength(0);
  });

  test("gate ordering: quiet_hours fires BEFORE stale (stale node during quiet → quiet_hours)", async () => {
    // Complementary ordering test: quiet blocks before the stale-fingerprint check.
    const stalDir = makeGraphStorage(true, "sha-foo-CHANGED");
    const a = makeApp(async () => ANCHOR_A, {
      getGraphStorageDir: async () => stalDir,
      checkSendGate: async () => ({ blocked: "quiet_hours" as const }),
    });
    const sid = await pinSession(a);
    capturedStreams = [];

    const res = await postChat(a, { session_id: sid, message: "quiet+stale" });
    const signal = await res.json() as Record<string, unknown>;
    expect(signal.blocked).toBe("quiet_hours");
    expect(capturedStreams).toHaveLength(0);
  });
});

// ── Non-pinned sessions: gates do not fire (anchor required) ─────────────────

describe("Non-pinned sessions: no gate fires for free-text chat", () => {
  test("Free-text (no anchor) → streams normally regardless of gate state", async () => {
    // What this guarantees: general chat (no anchor) is unaffected by the
    // stale/node_gone gates (they require anchorCtx != null). Budget/quiet gate
    // still applies to all sends — but if it's null here, free-text proceeds.
    const dir = makeGraphStorage(false); // node absent — would trigger node_gone if pinned
    const a = makeApp(async () => ANCHOR_A, {
      getGraphStorageDir: async () => dir,
      checkSendGate: async () => null,
    });

    const res = await postChat(a, { message: "free text question" }); // no anchor field
    expect(res.headers.get("Content-Type")).toContain("text/event-stream");
    await drain(res);
    expect(capturedStreams).toHaveLength(1);
  });
});
