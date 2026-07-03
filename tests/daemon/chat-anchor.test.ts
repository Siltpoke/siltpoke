/**
 * Chat route anchor pinning + context injection + stale gate.
 *
 * The following tests verify the no-feed wiring at the route level with a
 * fake resolveAnchor + a capturing fake streamFactory (no real graph, no
 * real Brain):
 *  - new session + anchor → context frozen to sidecar + injected as systemPrompt
 *  - send carries the node's context (the no-feed point)
 *  - existing session does NOT re-pin (INV1)
 *  - no anchor / unresolved → no systemPrompt (back-compat / graceful)
 *
 * The stale-fingerprint pre-flight gate:
 *  - pinned + unchanged fingerprint → streams normally
 *  - pinned + changed fingerprint + no decision → JSON blocked:stale; message NOT appended
 *  - anchor_decision:"freeze" → streams old frozen sidecar unchanged
 *  - anchor_decision:"continue" → sidecar overwritten + session fingerprint updated + streams fresh
 *  - non-pinned session → unaffected (no stale check)
 *  - INV2: the ONLY path that overwrites the sidecar with a newer fingerprint is "continue"
 */
import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { Hono } from "hono";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mountChatRoutes, type ChatAnchorRef } from "../../src/daemon/routes/chat";
import { openIndex } from "../../src/chat/fts5-index";
import { readAnchorContext } from "../../src/chat/anchor-store";
import { readMemory } from "../../src/memory/memory";
import { readSession } from "../../src/chat/jsonl-store";
import type { ResolveAnchorResult } from "../../src/chat/anchor-context";
import type { StreamChatOptions, StreamEvent } from "../../src/daemon/routes/chat-stream";

let home: string;
let captured: StreamChatOptions[];

function fakeStream(opts: StreamChatOptions): AsyncGenerator<StreamEvent, void, void> {
  captured.push(opts);
  return (async function* () {
    yield { type: "message_start", message_id: "m-fake", model: "mock" };
    yield { type: "content_block_delta", text: "ok" };
    yield {
      type: "message_stop",
      usage: { input_tokens: 1, output_tokens: 1 },
      full_text: "ok",
    };
  })();
}

const RESOLVED_CTX: ResolveAnchorResult = {
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

function app(resolveAnchor?: (a: ChatAnchorRef) => Promise<ResolveAnchorResult>): Hono {
  const a = new Hono();
  mountChatRoutes(a, {
    homeBase: home,
    index: openIndex(home),
    streamFactory: fakeStream,
    resolveAnchor,
    now: () => new Date("2026-06-22T20:00:00.000Z"),
  });
  return a;
}

async function post(a: Hono, body: unknown): Promise<Response> {
  return a.request("/api/chat", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}
async function drain(res: Response): Promise<void> {
  await res.text(); // consume SSE so the stream's start() completes (persists)
}

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "siltpoke-chat-anchor-"));
  captured = [];
});
afterEach(() => rmSync(home, { recursive: true, force: true }));

describe("chat anchor pinning", () => {
  test("new session + anchor → context frozen + injected as systemPrompt (no-feed)", async () => {
    const a = app(async () => RESOLVED_CTX);
    const res = await post(a, {
      message: "what is this?",
      anchor: { node_id: "function:src/foo.ts:applyDiscount", proj_hash: "abc123def456" },
    });
    const sid = res.headers.get("X-Siltpoke-Session-Id");
    await drain(res);
    expect(sid).toBeTruthy();

    // sidecar frozen at pin time
    const sidecar = await readAnchorContext(home, sid!);
    expect(sidecar?.contextBundle).toContain("return p * (1 - pct)");

    // the stream received the node context as systemPrompt — the no-feed point
    expect(captured).toHaveLength(1);
    expect(captured[0].systemPrompt).toContain("return p * (1 - pct)");
    expect(captured[0].systemPrompt).toContain("CHAT-SYS");

    // anchor metadata recorded on the session (immutable from here, INV1)
    const mem = await readMemory(home);
    const sess = mem?.chat_sessions.find((s) => s.id === sid);
    expect(sess?.anchor?.node_id).toBe("function:src/foo.ts:applyDiscount");
    expect(sess?.anchor?.fingerprint).toBe("sha-foo-123");
  });

  test("existing session does NOT re-pin even if a new anchor is sent (INV1)", async () => {
    const a = app(async () => RESOLVED_CTX);
    const r1 = await post(a, {
      message: "first",
      anchor: { node_id: "function:src/foo.ts:applyDiscount", proj_hash: "abc123def456" },
    });
    const sid = r1.headers.get("X-Siltpoke-Session-Id")!;
    await drain(r1);

    let calls = 0;
    const a2 = app(async () => {
      calls++;
      return RESOLVED_CTX;
    });
    const r2 = await post(a2, {
      session_id: sid,
      message: "second",
      anchor: { node_id: "function:src/foo.ts:OTHER", proj_hash: "abc123def456" },
    });
    await drain(r2);
    // Perf fix: the node_gone check now uses cheapNodeExists (graph.json)
    // rather than resolveAnchor. The `app()` factory does not wire getGraphStorageDir,
    // so the node_gone check is skipped → resolveAnchor is NOT called (0, not 1).
    // INV1 still holds: the sidecar is unchanged (no re-pin).
    expect(calls).toBe(0); // resolveAnchor not called for the existence check
    // the original sidecar is still the one that was pinned (INV1 satisfied)
    const sidecar = await readAnchorContext(home, sid);
    expect(sidecar?.nodeId).toBe("function:src/foo.ts:applyDiscount");
  });

  test("no anchor → no systemPrompt (back-compat free-text chat)", async () => {
    const a = app(async () => RESOLVED_CTX);
    const res = await post(a, { message: "hi" });
    await drain(res);
    expect(captured[0].systemPrompt).toBeUndefined();
  });

  test("descriptor anchor {name, path} pins + injects (option b symbol-drill path)", async () => {
    let received: unknown;
    const a = app(async (anchor) => {
      received = anchor;
      return RESOLVED_CTX;
    });
    const res = await post(a, {
      message: "what is this?",
      anchor: { name: "applyDiscount", path: "src/foo.ts", node_type: "function", proj_hash: "abc123def456" },
    });
    await drain(res);
    // the descriptor reached resolveAnchor unmangled (backend owns id resolution)
    expect(received).toEqual({
      name: "applyDiscount",
      path: "src/foo.ts",
      node_type: "function",
      proj_hash: "abc123def456",
    });
    expect(captured[0].systemPrompt).toContain("return p * (1 - pct)");
  });

  test("rejects a path-traversal session_id (security)", async () => {
    const a = app(async () => RESOLVED_CTX);
    const res = await post(a, { session_id: "../../etc/passwd", message: "hi" });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "invalid_session_id" });
  });

  test("rejects a non-string anchor field", async () => {
    const a = app(async () => RESOLVED_CTX);
    const res = await post(a, {
      message: "hi",
      anchor: { node_id: { evil: 1 }, proj_hash: "abc123def456" },
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "invalid_anchor" });
  });

  test("unresolved anchor (no graph) → no pin, no systemPrompt (graceful)", async () => {
    const a = app(async () => ({ kind: "no_graph", message: "no index" }));
    const res = await post(a, {
      message: "what is this?",
      anchor: { node_id: "function:src/x.ts:y", proj_hash: "abc123def456" },
    });
    const sid = res.headers.get("X-Siltpoke-Session-Id")!;
    await drain(res);
    expect(await readAnchorContext(home, sid)).toBeNull();
    expect(captured[0].systemPrompt).toBeUndefined();
  });
});

// ── Stale fingerprint pre-flight gate ─────────────────────────────────────────

const FRESH_CTX: ResolveAnchorResult = {
  kind: "resolved",
  context: {
    nodeId: "function:src/foo.ts:applyDiscount",
    nodeName: "applyDiscount",
    nodeType: "function",
    path: "src/foo.ts",
    contextBundle: "SOURCE: return p * discount — FRESH VERSION",
    systemPrompt: "CHAT-SYS-FRESH",
    fingerprint: "sha-foo-456",
    includedSources: ["src/foo.ts"],
    truncated: false,
  },
};

/**
 * Build a fake graph storage dir with a fingerprints.json that maps
 * `src/foo.ts` to the given sha. Returns the storageDir path.
 *
 * Each call gets a unique subdir (keyed on `sha`) so parallel / reordered
 * tests that pass different shas cannot cross-read each other's fingerprint file.
 */
let _fakeStorageSeq = 0;
function makeFakeStorage(parentDir: string, sha: string): string {
  const storageDir = join(parentDir, `fake-storage-${++_fakeStorageSeq}`);
  mkdirSync(storageDir, { recursive: true });
  const fingerprints = {
    schemaVersion: 1,
    files: {
      "src/foo.ts": { content_sha256: sha, ast_sig: "ast-sig-placeholder" },
    },
  };
  writeFileSync(join(storageDir, "fingerprints.json"), JSON.stringify(fingerprints));
  return storageDir;
}

/**
 * App factory with getGraphStorageDir injected.
 * `currentSha`: the sha that fingerprints.json will report for src/foo.ts.
 * Pass undefined to simulate "no storage dir" (getGraphStorageDir returns null).
 */
function appWithStale(
  resolveAnchor: (a: ChatAnchorRef) => Promise<ResolveAnchorResult>,
  currentSha: string | undefined,
): Hono {
  const a = new Hono();
  const getGraphStorageDir = async (_projHash: string): Promise<string | null> => {
    if (currentSha === undefined) return null;
    return makeFakeStorage(home, currentSha);
  };
  mountChatRoutes(a, {
    homeBase: home,
    index: openIndex(home),
    streamFactory: fakeStream,
    resolveAnchor,
    getGraphStorageDir,
    now: () => new Date("2026-06-22T20:00:00.000Z"),
  });
  return a;
}

/** Pin a new session (turn 1). Returns sessionId. */
async function pinSession(
  a: Hono,
  msg = "what is this?",
): Promise<string> {
  const res = await post(a, {
    message: msg,
    anchor: { node_id: "function:src/foo.ts:applyDiscount", proj_hash: "abc123def456" },
  });
  const sid = res.headers.get("X-Siltpoke-Session-Id")!;
  await drain(res);
  return sid;
}

describe("stale fingerprint pre-flight gate", () => {
  test("pinned + UNCHANGED fingerprint → streams normally (no stale block)", async () => {
    // currentSha matches pinnedFingerprint ("sha-foo-123")
    const a = appWithStale(async () => RESOLVED_CTX, "sha-foo-123");
    const sid = await pinSession(a);
    captured = []; // reset

    const res = await post(a, { session_id: sid, message: "follow-up" });
    // Must be SSE (not JSON signal)
    expect(res.headers.get("Content-Type")).toContain("text/event-stream");
    await drain(res);
    expect(captured).toHaveLength(1);

    // Message was appended (not blocked)
    const msgs = await readSession(home, sid);
    expect(msgs.filter((m) => m.role === "user")).toHaveLength(2);
  });

  test("pinned + CHANGED fingerprint + no decision → JSON blocked:stale; message NOT appended (INV2)", async () => {
    const a = appWithStale(async () => RESOLVED_CTX, "sha-foo-DIFFERENT");
    const sid = await pinSession(a);
    captured = []; // reset

    const res = await post(a, { session_id: sid, message: "follow-up" });

    // Must be JSON (blocked signal)
    expect(res.headers.get("Content-Type")).toContain("application/json");
    const signal = (await res.json()) as Record<string, unknown>;
    expect(signal.blocked).toBe("stale");
    expect(signal.pinned_fingerprint).toBe("sha-foo-123");
    expect(signal.current_fingerprint).toBe("sha-foo-DIFFERENT");
    expect(signal.pinned_at).toBe("2026-06-22T20:00:00.000Z");
    expect(signal.node_name).toBe("applyDiscount");
    expect(signal.v4_file_level_only).toBe(true);

    // No stream was started
    expect(captured).toHaveLength(0);

    // Message was NOT appended to the transcript (INV2 — not answered)
    const msgs = await readSession(home, sid);
    expect(msgs.filter((m) => m.role === "user")).toHaveLength(1); // only the pinning message
  });

  test("anchor_decision:'freeze' → streams with EXISTING frozen sidecar; sidecar NOT overwritten", async () => {
    const a = appWithStale(async () => RESOLVED_CTX, "sha-foo-DIFFERENT");
    const sid = await pinSession(a);
    const sidecarBefore = await readAnchorContext(home, sid);
    captured = []; // reset

    const res = await post(a, {
      session_id: sid,
      message: "keep going",
      anchor_decision: "freeze",
    });

    // Must be SSE
    expect(res.headers.get("Content-Type")).toContain("text/event-stream");
    await drain(res);
    expect(captured).toHaveLength(1);
    // The stream used the OLD (frozen) sidecar context
    expect(captured[0].systemPrompt).toContain("return p * (1 - pct)");

    // Sidecar is UNCHANGED (freeze = keep old version)
    const sidecarAfter = await readAnchorContext(home, sid);
    expect(sidecarAfter?.fingerprint).toBe(sidecarBefore?.fingerprint); // "sha-foo-123"
    expect(sidecarAfter?.contextBundle).toBe(sidecarBefore?.contextBundle);

    // Message WAS appended
    const msgs = await readSession(home, sid);
    expect(msgs.filter((m) => m.role === "user")).toHaveLength(2);
  });

  test("anchor_decision:'continue' → sidecar overwritten + session fingerprint updated + streams fresh (INV2 explicit re-derive)", async () => {
    let resolveCallCount = 0;
    const a = appWithStale(async () => {
      resolveCallCount++;
      // Call 1 = pin time (pinSession), call 2 = "continue" re-resolve
      return resolveCallCount === 1 ? RESOLVED_CTX : FRESH_CTX;
    }, "sha-foo-DIFFERENT");
    const sid = await pinSession(a);
    captured = []; // reset

    const res = await post(a, {
      session_id: sid,
      message: "use the new version",
      anchor_decision: "continue",
    });

    // Must be SSE
    expect(res.headers.get("Content-Type")).toContain("text/event-stream");
    await drain(res);
    expect(captured).toHaveLength(1);

    // Stream used FRESH context
    expect(captured[0].systemPrompt).toContain("FRESH VERSION");

    // Sidecar was OVERWRITTEN with fresh context (the only permitted re-derive)
    const sidecar = await readAnchorContext(home, sid);
    expect(sidecar?.fingerprint).toBe("sha-foo-456"); // FRESH_CTX fingerprint
    expect(sidecar?.contextBundle).toContain("FRESH VERSION");

    // Session record has updated fingerprint
    const mem = await readMemory(home);
    const sess = mem?.chat_sessions.find((s) => s.id === sid);
    expect(sess?.anchor?.fingerprint).toBe("sha-foo-456");

    // Message WAS appended
    const msgs = await readSession(home, sid);
    expect(msgs.filter((m) => m.role === "user")).toHaveLength(2);
  });

  test("anchor_decision:'continue' for descriptor-anchored session → re-resolves via server node_id (stored at pin time)", async () => {
    // Sessions pinned via {name, path, node_type} (descriptor form) have their
    // server-resolved node_id stored in session.anchor.node_id (written at pin time
    // by upsertChatSession). The "continue" branch reconstructs ChatAnchorRef as
    // { proj_hash, node_id } using that stored value. Verify this path works.
    let receivedAnchorRef: ChatAnchorRef | undefined;
    let resolveCallCount = 0;
    const a = appWithStale(async (ref) => {
      resolveCallCount++;
      receivedAnchorRef = ref;
      return resolveCallCount === 1 ? RESOLVED_CTX : FRESH_CTX;
    }, "sha-foo-DIFFERENT");

    // Pin via descriptor form
    const r1 = await a.request("/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        message: "pin via descriptor",
        anchor: {
          name: "applyDiscount",
          path: "src/foo.ts",
          node_type: "function",
          proj_hash: "abc123def456",
        },
      }),
    });
    const sid = r1.headers.get("X-Siltpoke-Session-Id")!;
    await drain(r1);
    // Verify session was pinned with the resolved node_id
    const mem1 = await readMemory(home);
    const pinned = mem1?.chat_sessions.find((s) => s.id === sid);
    expect(pinned?.anchor?.node_id).toBe("function:src/foo.ts:applyDiscount");
    captured = []; // reset

    // "continue" re-resolve uses the stored node_id (descriptor → resolved server id)
    const res = await post(a, {
      session_id: sid,
      message: "use the new version",
      anchor_decision: "continue",
    });
    expect(res.headers.get("Content-Type")).toContain("text/event-stream");
    await drain(res);
    // The re-resolve call received a node_id form (not descriptor)
    expect(receivedAnchorRef && "node_id" in receivedAnchorRef).toBe(true);
    expect((receivedAnchorRef as { node_id?: string })?.node_id).toBe("function:src/foo.ts:applyDiscount");
    // Sidecar updated with fresh context
    const sidecar = await readAnchorContext(home, sid);
    expect(sidecar?.fingerprint).toBe("sha-foo-456");
  });

  test("non-pinned session → stale check never runs (unaffected)", async () => {
    // No anchor → the session has no sidecar → anchorCtx is null → gate skips
    const a = appWithStale(async () => RESOLVED_CTX, "sha-foo-DIFFERENT");
    const r1 = await post(a, { message: "free text chat" }); // no anchor
    const sid = r1.headers.get("X-Siltpoke-Session-Id")!;
    await drain(r1);
    captured = []; // reset

    const r2 = await post(a, { session_id: sid, message: "follow-up" });
    // Non-pinned → SSE, no block
    expect(r2.headers.get("Content-Type")).toContain("text/event-stream");
    await drain(r2);
    expect(captured).toHaveLength(1);
  });

  test("pinned + null fingerprint (untracked file) → skips stale check, streams normally", async () => {
    // Sidecar has fingerprint: null (file wasn't tracked at pin time)
    const nullFpCtx: ResolveAnchorResult = {
      kind: "resolved",
      context: {
        ...RESOLVED_CTX.context,
        fingerprint: null, // V4: file not fingerprint-tracked
      },
    };
    const a = appWithStale(async () => nullFpCtx, "sha-foo-DIFFERENT");
    const sid = await pinSession(a, "pin with null fingerprint");
    captured = []; // reset

    const res = await post(a, { session_id: sid, message: "follow-up" });
    // Null pinnedFingerprint → gate skipped → SSE
    expect(res.headers.get("Content-Type")).toContain("text/event-stream");
    await drain(res);
    expect(captured).toHaveLength(1);
  });

  test("getGraphStorageDir absent → stale check skipped (dep-injection safety)", async () => {
    // Dep absent → behaves like unchanged, no block
    const a = new Hono();
    mountChatRoutes(a, {
      homeBase: home,
      index: openIndex(home),
      streamFactory: fakeStream,
      resolveAnchor: async () => RESOLVED_CTX,
      // getGraphStorageDir NOT wired
      now: () => new Date("2026-06-22T20:00:00.000Z"),
    });
    const sid = await pinSession(a);
    captured = []; // reset

    const res = await post(a, { session_id: sid, message: "follow-up" });
    expect(res.headers.get("Content-Type")).toContain("text/event-stream");
    await drain(res);
    expect(captured).toHaveLength(1);
  });

  /**
   * INV2 machine-checkable assertion (POST /api/chat paths only):
   * for an existing pinned session with a changed fingerprint, the ONLY POST
   * path that overwrites the sidecar with a newer fingerprint is
   * `anchor_decision: "continue"`.
   *
   * Note: PATCH /api/chat/sessions/:id/anchor is also a permitted sidecar write
   * (the re-anchor path) — that is intentional and covered by chat-reanchor.test.ts.
   * This test covers the three POST /api/chat paths for the stale case.
   *
   * Verifies by exhaustion of POST paths: (1) no decision → blocked, sidecar
   * unchanged; (2) freeze → streams, sidecar unchanged; (3) continue → overwritten.
   */
  test("INV2: only the 'continue' branch overwrites the sidecar (no silent re-derive, POST paths)", async () => {
    // -- Path 1: no decision → block, sidecar unchanged --
    const a1 = appWithStale(async () => RESOLVED_CTX, "sha-foo-DIFFERENT");
    const sid1 = await pinSession(a1);
    const r1 = await post(a1, { session_id: sid1, message: "p1" });
    expect(((await r1.json()) as Record<string, unknown>).blocked).toBe("stale");
    expect((await readAnchorContext(home, sid1))?.fingerprint).toBe("sha-foo-123"); // UNCHANGED

    // -- Path 2: freeze → sidecar unchanged --
    const a2 = appWithStale(async () => RESOLVED_CTX, "sha-foo-DIFFERENT");
    const sid2 = await pinSession(a2);
    const r2 = await post(a2, { session_id: sid2, message: "p2", anchor_decision: "freeze" });
    await drain(r2);
    expect(r2.headers.get("Content-Type")).toContain("text/event-stream");
    expect((await readAnchorContext(home, sid2))?.fingerprint).toBe("sha-foo-123"); // STILL old

    // -- Path 3: continue → sidecar overwritten (the ONLY permitted path) --
    let resolveCount = 0;
    const a3 = appWithStale(async () => {
      resolveCount++;
      return resolveCount === 1 ? RESOLVED_CTX : FRESH_CTX;
    }, "sha-foo-DIFFERENT");
    const sid3 = await pinSession(a3);
    const r3 = await post(a3, { session_id: sid3, message: "p3", anchor_decision: "continue" });
    await drain(r3);
    expect(r3.headers.get("Content-Type")).toContain("text/event-stream");
    expect((await readAnchorContext(home, sid3))?.fingerprint).toBe("sha-foo-456"); // NEW (only here)
  });
});

// ── Dead-anchor (node_gone) pre-flight gate ───────────────────────────────────

/**
 * Write a fake graph storage dir with a graph.json that either includes or
 * excludes the pinned node (function:src/foo.ts:applyDiscount).
 *
 * The existence check uses cheapNodeExists → readGraph + findTargetNode, so
 * tests drive the check via graph.json content (not via resolveAnchor).
 * A separate fingerprints.json is included so the same dir can also serve the
 * stale check without a separate storage dir.
 *
 * @param nodePresent  true → node is in graph.json (resolves to "found")
 *                     false → node absent ("not_found")
 * @param currentSha   sha to write into fingerprints.json for src/foo.ts.
 *                     Defaults to the pinned sha ("sha-foo-123") → no stale.
 */
let _graphStorageSeq = 0;
function makeGraphStorage(
  parentDir: string,
  nodePresent: boolean,
  currentSha = "sha-foo-123",
): string {
  const storageDir = join(parentDir, `fake-graph-${++_graphStorageSeq}`);
  mkdirSync(storageDir, { recursive: true });

  // meta.json — cheapNodeExists checks for this first.
  writeFileSync(
    join(storageDir, "meta.json"),
    JSON.stringify({ schemaVersion: 1, projHash: "abc123def456", indexedAt: "2026-06-22T00:00:00.000Z" }),
  );

  // graph.json — the node_gone check reads this via readGraph + findTargetNode.
  const nodes = nodePresent
    ? [
        {
          id: "function:src/foo.ts:applyDiscount",
          type: "function",
          name: "applyDiscount",
          path: "src/foo.ts",
          lineRange: [1, 10],
        },
      ]
    : [];
  writeFileSync(
    join(storageDir, "graph.json"),
    JSON.stringify({ schemaVersion: 1, nodes, edges: [] }),
  );

  // fingerprints.json — for the stale check in the ordering test.
  writeFileSync(
    join(storageDir, "fingerprints.json"),
    JSON.stringify({
      schemaVersion: 1,
      files: { "src/foo.ts": { content_sha256: currentSha, ast_sig: "ast-sig" } },
    }),
  );

  return storageDir;
}

/**
 * App factory for node_gone tests. The existence check uses
 * cheapNodeExists → getGraphStorageDir → graph.json (NOT resolveAnchor).
 *
 * @param nodePresent  whether the pinned node is present in graph.json
 *                     during the CHECK (second) request.
 * @param resolveAnchor  still needed for the pin (first) request; defaults to
 *                       returning RESOLVED_CTX.
 */
function appWithNodeGone(
  nodePresent: boolean,
  resolveAnchorFn?: (a: ChatAnchorRef) => Promise<ResolveAnchorResult>,
): Hono {
  const a = new Hono();
  // Storage dir is created lazily on first getGraphStorageDir call so that
  // the home dir exists (it's created in beforeEach).
  let storageDirForCheck: string | null = null;
  mountChatRoutes(a, {
    homeBase: home,
    index: openIndex(home),
    streamFactory: fakeStream,
    resolveAnchor: resolveAnchorFn ?? (async () => RESOLVED_CTX),
    getGraphStorageDir: async (_projHash: string): Promise<string | null> => {
      if (!storageDirForCheck) {
        storageDirForCheck = makeGraphStorage(home, nodePresent);
      }
      return storageDirForCheck;
    },
    now: () => new Date("2026-06-22T20:00:00.000Z"),
  });
  return a;
}

describe("dead-anchor (node_gone) pre-flight gate", () => {
  test("pinned + node STILL present in graph → proceeds / streams (no block)", async () => {
    const a = appWithNodeGone(true /* nodePresent */);
    const sid = await pinSession(a);
    captured = [];

    const res = await post(a, { session_id: sid, message: "follow-up" });
    expect(res.headers.get("Content-Type")).toContain("text/event-stream");
    await drain(res);
    expect(captured).toHaveLength(1);

    // Message was appended (not blocked)
    const msgs = await readSession(home, sid);
    expect(msgs.filter((m) => m.role === "user")).toHaveLength(2);
  });

  test("pinned + node ABSENT from graph → JSON blocked:node_gone; message NOT appended (INV2)", async () => {
    const a = appWithNodeGone(false /* nodePresent — node removed from graph */);
    const sid = await pinSession(a);
    captured = [];

    const res = await post(a, { session_id: sid, message: "follow-up after rename" });

    // Must be JSON (blocked signal)
    expect(res.headers.get("Content-Type")).toContain("application/json");
    const signal = (await res.json()) as Record<string, unknown>;
    expect(signal.blocked).toBe("node_gone");
    expect(signal.node_name).toBe("applyDiscount");
    expect(signal.pinned_at).toBe("2026-06-22T20:00:00.000Z");

    // No stream was started
    expect(captured).toHaveLength(0);

    // Message was NOT appended to the transcript (INV2 — not answered)
    const msgs = await readSession(home, sid);
    expect(msgs.filter((m) => m.role === "user")).toHaveLength(1); // only the pinning message
  });

  test("pinned + graph unreadable → fails open (NOT blocked — no_graph path)", async () => {
    // getGraphStorageDir returns a path with no meta.json → cheapNodeExists returns "no_graph"
    const a = new Hono();
    mountChatRoutes(a, {
      homeBase: home,
      index: openIndex(home),
      streamFactory: fakeStream,
      resolveAnchor: async () => RESOLVED_CTX,
      getGraphStorageDir: async (_projHash: string): Promise<string | null> => {
        // Return a dir that has NO meta.json → cheapNodeExists → "no_graph" → fail-open.
        const emptyDir = join(home, "empty-storage");
        mkdirSync(emptyDir, { recursive: true });
        return emptyDir;
      },
      now: () => new Date("2026-06-22T20:00:00.000Z"),
    });
    const sid = await pinSession(a);
    captured = [];

    const res = await post(a, { session_id: sid, message: "follow-up" });
    // No meta.json → no_graph → fail-open → SSE
    expect(res.headers.get("Content-Type")).toContain("text/event-stream");
    await drain(res);
    expect(captured).toHaveLength(1);
  });

  test("cheap existence check does NOT call resolveAnchor for the node_gone step", async () => {
    // Prove the perf fix: the node_gone gate reads graph.json via cheapNodeExists;
    // resolveAnchor is NOT invoked for the existence check (only for pin + continue).
    // We wire resolveAnchor to track calls; after pinning, the check send must NOT
    // increment the counter.
    let resolveCallCount = 0;
    const a = new Hono();
    mountChatRoutes(a, {
      homeBase: home,
      index: openIndex(home),
      streamFactory: fakeStream,
      resolveAnchor: async () => {
        resolveCallCount++;
        return RESOLVED_CTX;
      },
      getGraphStorageDir: async (_projHash: string): Promise<string | null> => {
        return makeGraphStorage(home, true /* node present */);
      },
      now: () => new Date("2026-06-22T20:00:00.000Z"),
    });
    const sid = await pinSession(a); // resolveCallCount = 1 (pin)
    resolveCallCount = 0; // reset after pin
    captured = [];

    const res = await post(a, { session_id: sid, message: "follow-up" });
    await drain(res);

    // resolveAnchor must NOT have been called for the existence check
    expect(resolveCallCount).toBe(0);
    // But we did stream (node is present)
    expect(captured).toHaveLength(1);
  });

  test("getGraphStorageDir absent → node_gone check skipped, streams normally (dep-injection safety)", async () => {
    // getGraphStorageDir absent → the node_gone gate is skipped entirely (fail-open).
    const a = new Hono();
    mountChatRoutes(a, {
      homeBase: home,
      index: openIndex(home),
      streamFactory: fakeStream,
      resolveAnchor: async () => RESOLVED_CTX,
      // getGraphStorageDir NOT wired
      now: () => new Date("2026-06-22T20:00:00.000Z"),
    });
    // Pin a session using a separate app instance that has resolveAnchor for the pin.
    const aPin = app(async () => RESOLVED_CTX);
    const sid = await pinSession(aPin);
    captured = [];

    // Now send to the app WITHOUT getGraphStorageDir
    const res = await a.request("/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ session_id: sid, message: "follow-up" }),
    });
    // getGraphStorageDir absent → no node_gone check → SSE
    expect(res.headers.get("Content-Type")).toContain("text/event-stream");
    await drain(res);
  });

  test("node_gone check runs BEFORE the stale check (ordering invariant)", async () => {
    // If the node is gone, the stale block must never fire (node_gone takes priority).
    // Set up: graph has node ABSENT (triggers node_gone) AND fingerprints differ
    // (would trigger stale if node_gone didn't fire first).
    // Same storage dir serves both checks; graph has no node, fp sha differs.
    const a = new Hono();
    mountChatRoutes(a, {
      homeBase: home,
      index: openIndex(home),
      streamFactory: fakeStream,
      resolveAnchor: async () => RESOLVED_CTX, // only used for pinning
      getGraphStorageDir: async (_projHash: string): Promise<string | null> => {
        // Node is ABSENT + fingerprint is DIFFERENT → node_gone fires first.
        return makeGraphStorage(home, false /* absent */, "sha-foo-DIFFERENT");
      },
      now: () => new Date("2026-06-22T20:00:00.000Z"),
    });
    const sid = await pinSession(a);
    captured = [];

    const res = await post(a, { session_id: sid, message: "follow-up" });
    const signal = (await res.json()) as Record<string, unknown>;
    // Must be node_gone, NOT stale
    expect(signal.blocked).toBe("node_gone");
    expect(captured).toHaveLength(0);
  });

  test("non-pinned session → node_gone check never runs (unaffected)", async () => {
    // No anchor → anchorCtx is null → gate skips (even if graph says node absent).
    const a = appWithNodeGone(false /* would be node_gone if check ran */);
    const r1 = await post(a, { message: "free text chat" }); // no anchor
    const sid = r1.headers.get("X-Siltpoke-Session-Id")!;
    await drain(r1);
    captured = [];

    const r2 = await post(a, { session_id: sid, message: "follow-up" });
    // Non-pinned → SSE, no block
    expect(r2.headers.get("Content-Type")).toContain("text/event-stream");
    await drain(r2);
    expect(captured).toHaveLength(1);
  });
});

// ── Budget + quiet-hours gate ──────────────────────────────────────────────

import type { BudgetSignal, QuietHoursSignal } from "../../src/daemon/routes/chat";

/**
 * App factory for the budget/quiet-hours gate tests. Wires a checkSendGate dep that returns the
 * given signal (or null = pass). Also wires getGraphStorageDir so the node_gone
 * check can be set up independently.
 *
 * @param gateResult  what checkSendGate returns: a blocked signal or null (pass).
 * @param nodePresent  whether the pinned node is present in graph.json (default true).
 */
function appWithGate(
  gateResult: BudgetSignal | QuietHoursSignal | null,
  nodePresent = true,
): Hono {
  const a = new Hono();
  mountChatRoutes(a, {
    homeBase: home,
    index: openIndex(home),
    streamFactory: fakeStream,
    resolveAnchor: async () => RESOLVED_CTX,
    getGraphStorageDir: async (_projHash: string): Promise<string | null> => {
      return makeGraphStorage(home, nodePresent);
    },
    checkSendGate: async () => gateResult,
    now: () => new Date("2026-06-22T20:00:00.000Z"),
  });
  return a;
}

describe("budget + quiet-hours send gate", () => {
  test("quiet_hours active → JSON blocked:quiet_hours; message NOT appended; no stream", async () => {
    const a = appWithGate({ blocked: "quiet_hours" });
    const res = await post(a, { message: "hello" });

    expect(res.headers.get("Content-Type")).toContain("application/json");
    const signal = (await res.json()) as Record<string, unknown>;
    expect(signal.blocked).toBe("quiet_hours");
    expect(captured).toHaveLength(0);

    // Message NOT in any session (we don't know the session id — it was never assigned)
    // Verify by checking that no sessions directory was written
    // (home dir only has the chat index, not a chats/<id>.jsonl from this send)
    // We confirm via captured = 0 (no stream started = no appendMessage path reached).
  });

  test("budget hard-stop → JSON blocked:budget with used_pct; message NOT appended; no stream", async () => {
    const a = appWithGate({ blocked: "budget", used_pct: 102.5 });
    const res = await post(a, { message: "hello" });

    expect(res.headers.get("Content-Type")).toContain("application/json");
    const signal = (await res.json()) as Record<string, unknown>;
    expect(signal.blocked).toBe("budget");
    expect(signal.used_pct).toBe(102.5);
    expect(captured).toHaveLength(0);
  });

  test("soft budget (gate returns null) → streams normally (soft does NOT block)", async () => {
    // Gate returning null = neither budget-hard nor quiet-hours
    const a = appWithGate(null /* pass — e.g. soft budget stage */);
    const res = await post(a, { message: "hello" });

    expect(res.headers.get("Content-Type")).toContain("text/event-stream");
    await drain(res);
    expect(captured).toHaveLength(1);
  });

  test("ok budget + not-quiet → streams normally", async () => {
    const a = appWithGate(null);
    const res = await post(a, { message: "hello" });

    expect(res.headers.get("Content-Type")).toContain("text/event-stream");
    await drain(res);
    expect(captured).toHaveLength(1);
  });

  test("absent checkSendGate dep → fails open (streams normally)", async () => {
    const a = new Hono();
    mountChatRoutes(a, {
      homeBase: home,
      index: openIndex(home),
      streamFactory: fakeStream,
      resolveAnchor: async () => RESOLVED_CTX,
      // checkSendGate NOT wired
      now: () => new Date("2026-06-22T20:00:00.000Z"),
    });
    const res = await post(a, { message: "hello" });
    expect(res.headers.get("Content-Type")).toContain("text/event-stream");
    await drain(res);
    expect(captured).toHaveLength(1);
  });

  test("gate runs for a NON-pinned (general) conversation too", async () => {
    // Budget gate applies to ALL sends — not just anchor-pinned sessions.
    const a = appWithGate({ blocked: "quiet_hours" });
    // Send without an anchor (general chat)
    const res = await post(a, { message: "general question" });
    expect(res.headers.get("Content-Type")).toContain("application/json");
    const signal = (await res.json()) as Record<string, unknown>;
    expect(signal.blocked).toBe("quiet_hours");
    expect(captured).toHaveLength(0);
  });

  test("quiet_hours fires BEFORE node_gone (gate order invariant)", async () => {
    // Node is ABSENT (would trigger node_gone if gate ran after) +
    // quiet_hours active (triggers first). Verify the quiet_hours signal wins.
    const a = appWithGate({ blocked: "quiet_hours" }, false /* nodePresent: false */);
    const sid = await pinSession(appWithNodeGone(true)); // pin with node present
    captured = [];

    const res = await post(a, { session_id: sid, message: "follow-up" });
    const signal = (await res.json()) as Record<string, unknown>;
    // quiet_hours must fire first (before node_gone)
    expect(signal.blocked).toBe("quiet_hours");
    expect(captured).toHaveLength(0);
  });

  test("checkSendGate throws → fails open (streams normally)", async () => {
    const a = new Hono();
    mountChatRoutes(a, {
      homeBase: home,
      index: openIndex(home),
      streamFactory: fakeStream,
      resolveAnchor: async () => RESOLVED_CTX,
      checkSendGate: async () => { throw new Error("gate exploded"); },
      now: () => new Date("2026-06-22T20:00:00.000Z"),
    });
    const res = await post(a, { message: "hello" });
    // Gate error → fail-open → SSE
    expect(res.headers.get("Content-Type")).toContain("text/event-stream");
    await drain(res);
    expect(captured).toHaveLength(1);
  });
});
