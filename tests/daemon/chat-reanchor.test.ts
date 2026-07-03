/**
 * PATCH /api/chat/sessions/:id/anchor re-anchor endpoint.
 *
 * INV1 hard enforcement:
 *  - re-anchor PATCH is the ONLY path that mutates a session's anchor after creation
 *  - the POST /api/chat route's existing-session branch does NOT touch the anchor
 *    (already proven by the creation-only invariant in upsertChatSession + the
 *    isNewSession guard in the POST handler; re-stated here as a regression guard)
 *  - navigation alone (no PATCH) does not mutate the anchor
 *
 * Happy path: PATCH re-resolves the node, overwrites the sidecar, updates session
 * meta with fresh pinned_at. History (JSONL) is UNCHANGED.
 *
 * Error paths: node_not_found → 404; invalid session_id → 400; invalid anchor → 400.
 */
import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { Hono } from "hono";
import { mkdtempSync, rmSync } from "node:fs";
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

const CTX_A: ResolveAnchorResult = {
  kind: "resolved",
  context: {
    nodeId: "function:src/foo.ts:applyDiscount",
    nodeName: "applyDiscount",
    nodeType: "function",
    path: "src/foo.ts",
    contextBundle: "SOURCE-A: return p * (1 - pct)",
    systemPrompt: "CHAT-SYS",
    fingerprint: "sha-foo-aaa",
    includedSources: ["src/foo.ts"],
    truncated: false,
  },
};

const CTX_B: ResolveAnchorResult = {
  kind: "resolved",
  context: {
    nodeId: "function:src/bar.ts:computeTotal",
    nodeName: "computeTotal",
    nodeType: "function",
    path: "src/bar.ts",
    contextBundle: "SOURCE-B: return items.reduce((s, i) => s + i.price, 0)",
    systemPrompt: "CHAT-SYS",
    fingerprint: "sha-bar-bbb",
    includedSources: ["src/bar.ts"],
    truncated: false,
  },
};

function makeApp(
  resolveAnchor?: (a: ChatAnchorRef) => Promise<ResolveAnchorResult>,
): Hono {
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

async function drain(res: Response): Promise<void> {
  await res.text();
}

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "siltpoke-reanchor-"));
  captured = [];
});

afterEach(() => rmSync(home, { recursive: true, force: true }));

describe("PATCH /api/chat/sessions/:id/anchor (re-anchor endpoint)", () => {
  test("happy path: re-anchor overwrites sidecar + updates session meta, keeps history intact", async () => {
    // 1. Create a session pinned to node A
    let resolveCallCount = 0;
    const a = makeApp(async () => {
      resolveCallCount++;
      return resolveCallCount === 1 ? CTX_A : CTX_B;
    });

    const r1 = await postChat(a, {
      message: "first message",
      anchor: { node_id: "function:src/foo.ts:applyDiscount", proj_hash: "abc123" },
    });
    const sid = r1.headers.get("X-Siltpoke-Session-Id")!;
    await drain(r1);

    // sidecar is A
    const sidecar1 = await readAnchorContext(home, sid);
    expect(sidecar1?.nodeId).toBe("function:src/foo.ts:applyDiscount");

    // 2. PATCH re-anchor to node B
    const patchBody: ChatAnchorRef = {
      node_id: "function:src/bar.ts:computeTotal",
      proj_hash: "def456",
    };
    const patchRes = await patchAnchor(a, sid, patchBody);
    expect(patchRes.status).toBe(200);
    const json = (await patchRes.json()) as { ok: boolean; anchor: Record<string, unknown> };
    expect(json.ok).toBe(true);
    expect(json.anchor.node_id).toBe("function:src/bar.ts:computeTotal");
    expect(json.anchor.node_name).toBe("computeTotal");

    // 3. Sidecar is now B
    const sidecar2 = await readAnchorContext(home, sid);
    expect(sidecar2?.nodeId).toBe("function:src/bar.ts:computeTotal");
    expect(sidecar2?.contextBundle).toContain("SOURCE-B");

    // 4. Session meta reflects node B
    const mem = await readMemory(home);
    const sess = mem?.chat_sessions.find((s) => s.id === sid);
    expect(sess?.anchor?.node_id).toBe("function:src/bar.ts:computeTotal");
    expect(sess?.anchor?.node_name).toBe("computeTotal");
    expect(sess?.anchor?.fingerprint).toBe("sha-bar-bbb");

    // 5. JSONL history is UNCHANGED (still has the original messages)
    const msgs = await readSession(home, sid);
    expect(msgs.length).toBeGreaterThanOrEqual(2); // user + assistant from first send
    expect(msgs[0]?.content).toBe("first message");
  });

  test("node_not_found → 404, existing anchor is NOT mutated (INV1)", async () => {
    const a = makeApp(async (ref) => {
      const nodeId = "node_id" in ref ? ref.node_id : "";
      if (nodeId.includes("bad")) {
        return { kind: "node_not_found", target: { node_id: "bad" } };
      }
      return CTX_A;
    });

    const r1 = await postChat(a, {
      message: "hi",
      anchor: { node_id: "function:src/foo.ts:applyDiscount", proj_hash: "abc123" },
    });
    const sid = r1.headers.get("X-Siltpoke-Session-Id")!;
    await drain(r1);

    const patchRes = await patchAnchor(a, sid, {
      node_id: "bad:node",
      proj_hash: "abc123",
    });
    expect(patchRes.status).toBe(404);
    const errJson = (await patchRes.json()) as { error: string };
    expect(errJson.error).toBe("node_not_found");

    // Anchor is still A (not mutated) — INV1 holds
    const sidecar = await readAnchorContext(home, sid);
    expect(sidecar?.nodeId).toBe("function:src/foo.ts:applyDiscount");

    const mem = await readMemory(home);
    const sess = mem?.chat_sessions.find((s) => s.id === sid);
    expect(sess?.anchor?.node_id).toBe("function:src/foo.ts:applyDiscount");
  });

  test("invalid session_id (dot-containing id rejected by SESSION_ID_RE) → 400", async () => {
    // Hono normalizes URLs so path-traversal `../../` attempts produce 404 before
    // reaching the handler. For the guard we test a dot-containing id that Hono
    // DOES route to the handler but SESSION_ID_RE rejects.
    const a = makeApp(async () => CTX_A);
    const res = await patchAnchor(a, "s.evil.id", {
      node_id: "function:src/foo.ts:applyDiscount",
      proj_hash: "abc123",
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "invalid_session_id" });
  });

  test("invalid anchor body (non-string node_id) → 400", async () => {
    const a = makeApp(async () => CTX_A);
    const res = await patchAnchor(a, "s-valid", {
      node_id: { evil: 1 },
      proj_hash: "abc123",
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "invalid_anchor" });
  });

  test("no resolveAnchor dep configured → 404 node_not_found (safe fallback)", async () => {
    const a = new Hono();
    mountChatRoutes(a, {
      homeBase: home,
      index: openIndex(home),
      streamFactory: fakeStream,
      // no resolveAnchor
    });
    const res = await patchAnchor(a, "s-any", {
      node_id: "function:src/foo.ts:x",
      proj_hash: "abc123",
    });
    expect(res.status).toBe(404);
  });

  test("Finding 3: session absent from memory → 404 with session_not_found (not node_not_found)", async () => {
    // PATCH on a session_id that was never created in memory.json.
    // reanchorChatSession returns false → must return session_not_found, NOT node_not_found.
    const a = makeApp(async () => CTX_A);
    const res = await patchAnchor(a, "s-nonexistent", {
      node_id: "function:src/foo.ts:applyDiscount",
      proj_hash: "abc123",
    });
    expect(res.status).toBe(404);
    const json = (await res.json()) as { error: string };
    expect(json.error).toBe("session_not_found");
  });

  test("INV1: POST to existing session does NOT change the anchor (even if anchor field sent)", async () => {
    // The existing-session branch in POST /api/chat has `isNewSession = false`
    // so it never calls resolveAnchor for the anchor field. This test is a
    // regression guard to ensure that invariant holds after adding the PATCH route.
    let resolveCallsForExisting = 0;
    const a = makeApp(async () => {
      resolveCallsForExisting++;
      return CTX_A;
    });

    const r1 = await postChat(a, {
      message: "first",
      anchor: { node_id: "function:src/foo.ts:applyDiscount", proj_hash: "abc123" },
    });
    const sid = r1.headers.get("X-Siltpoke-Session-Id")!;
    await drain(r1);
    // Reset counter after creation (which calls resolveAnchor once)
    resolveCallsForExisting = 0;

    // Second POST to existing session with a different anchor — must NOT re-resolve
    const r2 = await postChat(a, {
      session_id: sid,
      message: "second",
      anchor: { node_id: "function:src/bar.ts:computeTotal", proj_hash: "def456" },
    });
    await drain(r2);

    // Perf fix: resolveAnchor is NOT called for the node_gone check
    // (the check now uses cheapNodeExists via getGraphStorageDir, which is absent
    // from makeApp → check is skipped). The sidecar must NOT be overwritten (INV1).
    expect(resolveCallsForExisting).toBe(0); // resolveAnchor not called for existence check

    const sidecar = await readAnchorContext(home, sid);
    expect(sidecar?.nodeId).toBe("function:src/foo.ts:applyDiscount"); // still A
  });
});
