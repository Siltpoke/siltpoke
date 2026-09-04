// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
// Copyright (c) 2026 Jiaqi Duan
/**
 * Critique-anchored chat route wiring (Task 3 — "keystone").
 *
 * A critique anchor produces an `AnchorContext`-shaped bundle (Task 2:
 * resolveCritiqueContext), so it is frozen into the SAME sidecar
 * (writeAnchorContext) and injected by the SAME composeBaseSystemPrompt as a
 * node anchor — the entire downstream streaming turn is reused unchanged.
 * These tests verify only the route-level wiring:
 *
 *  - new session + critique_anchor → context frozen + injected as systemPrompt
 *  - malformed critique_anchor → 400 invalid_critique_anchor
 *  - unresolved critique (critique_not_found) on a NEW session → an HONEST
 *    `blocked: "critique_gone"` JSON signal — NOT a silent free-text
 *    fall-through (controller deviation from the original task brief: a
 *    confident, ungrounded answer to "why did you flag this?" would be
 *    dishonest). Message is NOT appended, nothing streams.
 *  - a follow-up send on a critique-anchored session must NOT false-block on
 *    the node-only pre-flight gates (node_gone / stale) — a critique_id is
 *    never a graph node id, so `cheapNodeExists` would wrongly report
 *    "not_found" if the `kind` discriminant didn't skip the check.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import type { AnchorContext } from "../../src/chat/anchor-context";
import { readAnchorContext } from "../../src/chat/anchor-store";
import type { ResolveCritiqueResult } from "../../src/chat/critique-context";
import { openIndex } from "../../src/chat/fts5-index";
import { readSession } from "../../src/chat/jsonl-store";
import { type ChatRouteDeps, mountChatRoutes } from "../../src/daemon/routes/chat";
import type { StreamChatOptions, StreamEvent } from "../../src/daemon/routes/chat-stream";
import { GLOBAL_ONLY } from "../../src/memory/memory";

const TEST_SECRET = "test-secret";

const ELIGIBLE_PROJECT = async () => ({
  project_id: null,
  proj_hash: null,
  project_root: null,
  display_name: null,
  source: "explicit" as const,
});

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

const RESOLVED_CRITIQUE_CTX: AnchorContext = {
  nodeId: "c-1a2b",
  nodeName: "critique c-1a2b",
  nodeType: "critique",
  path: "/repo",
  contextBundle: "TOKEN_EXPIRY_CRITIQUE_MARKER",
  systemPrompt: "CRITIQUE_SYSTEM_PROMPT_MARKER",
  fingerprint: null,
  includedSources: [],
  truncated: false,
};

function makeChatApp(overrides: Partial<ChatRouteDeps> = {}): Hono {
  const a = new Hono();
  mountChatRoutes(a, {
    resolveProject: ELIGIBLE_PROJECT,
    homeBase: home,
    index: openIndex(home),
    streamFactory: fakeStream,
    secret: TEST_SECRET,
    now: () => new Date("2026-07-12T20:00:00.000Z"),
    ...overrides,
  });
  return a;
}

async function post(a: Hono, body: unknown): Promise<Response> {
  return a.request("/api/chat", {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Siltpoke-Secret": TEST_SECRET },
    body: JSON.stringify(body),
  });
}
async function drain(res: Response): Promise<void> {
  await res.text(); // consume SSE so the stream's start() completes (persists)
}

/**
 * Fake graph storage with meta.json + an EMPTY graph.json (no nodes at all).
 * If the node_gone pre-flight gate wrongly consulted this for a critique
 * session, `cheapNodeExists({node_id: "c-1a2b"}, storageDir)` would return
 * "not_found" and false-block with node_gone — proving the `kind` guard
 * matters (not just a shape assertion).
 */
function makeEmptyGraphStorage(parentDir: string): string {
  const storageDir = join(parentDir, "fake-critique-graph");
  mkdirSync(storageDir, { recursive: true });
  writeFileSync(
    join(storageDir, "meta.json"),
    JSON.stringify({ schemaVersion: 1, projHash: "abc123abc123", indexedAt: "2026-07-12T00:00:00.000Z" }),
  );
  writeFileSync(join(storageDir, "graph.json"), JSON.stringify({ schemaVersion: 1, nodes: [], edges: [] }));
  return storageDir;
}

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "siltpoke-chat-critique-anchor-"));
  captured = [];
});
afterEach(() => rmSync(home, { recursive: true, force: true }));

describe("POST /api/chat — critique anchor", () => {
  test("pins a new session to a critique and injects the critique bundle", async () => {
    const resolveCritiqueAnchor = async (): Promise<ResolveCritiqueResult> => ({
      kind: "resolved",
      context: RESOLVED_CRITIQUE_CTX,
    });

    const a = makeChatApp({ resolveCritiqueAnchor });
    const res = await post(a, {
      message: "why did you flag this?",
      critique_anchor: { proj_hash: "abc123abc123", critique_id: "c-1a2b" },
    });

    expect(res.headers.get("content-type")).toContain("event-stream");
    const sid = res.headers.get("X-Siltpoke-Session-Id");
    await drain(res);
    expect(sid).toBeTruthy();

    expect(captured).toHaveLength(1);
    expect(captured[0].systemPrompt).toContain("CRITIQUE_SYSTEM_PROMPT_MARKER");
    expect(captured[0].systemPrompt).toContain("TOKEN_EXPIRY_CRITIQUE_MARKER");

    // sidecar frozen at pin time — same sidecar the node anchor uses.
    const sidecar = await readAnchorContext(home, sid!);
    expect(sidecar?.contextBundle).toBe("TOKEN_EXPIRY_CRITIQUE_MARKER");
    expect(sidecar?.fingerprint).toBeNull();
  });

  test("critique_anchor present + resolveCritiqueAnchor UNBOUND on a NEW session → honest blocked:critique_gone signal (no ungrounded fall-through)", async () => {
    // Task 4 review finding (A): the pin branch used to be keyed on
    // `isNewSession && body.critique_anchor && deps.resolveCritiqueAnchor` —
    // if the dep was unbound the condition went false and control fell
    // through to the no-pin free-text path, so a user clicking a review and
    // asking "why did you flag this?" got a confident, ungrounded reply.
    // Deliberately omit resolveCritiqueAnchor from overrides to prove the
    // fix: presence of `body.critique_anchor` ALONE must trigger the honest
    // critique_gone block, never a silent stream.
    const a = makeChatApp(); // no resolveCritiqueAnchor bound
    const res = await post(a, {
      message: "why did you flag this?",
      critique_anchor: { proj_hash: "abc123abc123", critique_id: "c-1a2b" },
    });

    expect(res.headers.get("content-type")).toContain("application/json");
    const signal = (await res.json()) as Record<string, unknown>;
    expect(signal.blocked).toBe("critique_gone");
    expect(signal.critique_id).toBe("c-1a2b");
    // No stream, no captured transcript, no message appended.
    expect(captured).toHaveLength(0);
  });

  test("returns invalid_critique_anchor for a malformed critique_anchor", async () => {
    const a = makeChatApp();
    const res = await post(a, { message: "hi", critique_anchor: { proj_hash: 5 } });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "invalid_critique_anchor" });
  });

  test("critique_not_found on a NEW session → honest blocked:critique_gone signal (no silent fall-through)", async () => {
    const resolveCritiqueAnchor = async (): Promise<ResolveCritiqueResult> => ({
      kind: "critique_not_found",
      critique_id: "c-ghost",
    });
    const a = makeChatApp({ resolveCritiqueAnchor });
    const res = await post(a, {
      message: "why did you flag this?",
      critique_anchor: { proj_hash: "abc123abc123", critique_id: "c-ghost" },
    });

    // Must be JSON (blocked signal) — NOT a stream.
    expect(res.headers.get("content-type")).toContain("application/json");
    const signal = (await res.json()) as Record<string, unknown>;
    expect(signal.blocked).toBe("critique_gone");
    expect(signal.critique_id).toBe("c-ghost");
    expect(captured).toHaveLength(0);
  });

  test("a follow-up send on a critique session does not false-block (no node_gone/stale)", async () => {
    const resolveCritiqueAnchor = async (): Promise<ResolveCritiqueResult> => ({
      kind: "resolved",
      context: RESOLVED_CRITIQUE_CTX,
    });
    // Wired on purpose: if the node_gone gate did NOT skip on kind:"critique",
    // this empty-graph storage would make cheapNodeExists report "not_found"
    // and the second send would false-block.
    const getGraphStorageDir = async (_projHash: string): Promise<string | null> =>
      makeEmptyGraphStorage(home);

    const a = makeChatApp({ resolveCritiqueAnchor, getGraphStorageDir });

    const r1 = await post(a, {
      message: "why did you flag this?",
      critique_anchor: { proj_hash: "abc123abc123", critique_id: "c-1a2b" },
    });
    const sid = r1.headers.get("X-Siltpoke-Session-Id")!;
    await drain(r1);
    captured = [];

    const r2 = await post(a, { session_id: sid, message: "follow-up question" });

    // Must be SSE, NOT a node_gone/stale JSON block.
    expect(r2.headers.get("content-type")).toContain("text/event-stream");
    await drain(r2);
    expect(captured).toHaveLength(1);

    // Message WAS appended (not blocked — INV2 only blocked a real gate hit).
    const msgs = await readSession(home, sid);
    expect(msgs.filter((m) => m.role === "user")).toHaveLength(2);
  });

  test("Fix 5: a request carrying BOTH anchor and critique_anchor is rejected 400 conflicting_anchor", async () => {
    const a = makeChatApp();
    const res = await post(a, {
      message: "hi",
      anchor: { proj_hash: "abc123abc123", node_id: "n1" },
      critique_anchor: { proj_hash: "abc123abc123", critique_id: "c-1a2b" },
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "conflicting_anchor" });
    // Rejected BEFORE any pin/stream — no message appended, nothing captured.
    expect(captured).toHaveLength(0);
  });

  test("Fix 6: a critique-anchored send resolves memScope from critique_anchor.proj_hash, not GLOBAL_ONLY", async () => {
    const resolveCritiqueAnchor = async (): Promise<ResolveCritiqueResult> => ({
      kind: "resolved",
      context: RESOLVED_CRITIQUE_CTX,
    });
    const seenScopes: unknown[] = [];
    // resolveProjectRootByHash is the seam the route uses to turn a proj_hash
    // into the memScope passed to readMemory. Recording readMemory's scope
    // argument proves the critique send's TURN read (facts/episodes) hit the
    // SAME project slice the anchor bundle itself was resolved against —
    // before the fix this always fell back to GLOBAL_ONLY for a critique
    // send (body.anchor is undefined for that path).
    const readMemory = async (_home: string, scope?: unknown) => {
      seenScopes.push(scope);
      return null;
    };
    const resolveProjectRootByHash = async (projHash: string): Promise<string | null> =>
      projHash === "abc123abc123" ? "/repo/scoped-project" : null;

    const a = makeChatApp({ resolveCritiqueAnchor, readMemory, resolveProjectRootByHash });
    const res = await post(a, {
      message: "why did you flag this?",
      critique_anchor: { proj_hash: "abc123abc123", critique_id: "c-1a2b" },
    });
    await drain(res);

    expect(seenScopes.length).toBeGreaterThan(0);
    // Every readMemory call for this turn used the critique's project scope —
    // never the GLOBAL_ONLY fallback.
    for (const scope of seenScopes) {
      expect(scope).toBe("/repo/scoped-project");
    }
  });

  test("IMPORTANT 5: a follow-up turn (turn 2) on a critique-anchored session STILL resolves memScope from the stored anchor, not GLOBAL_ONLY", async () => {
    // The client pins the anchor ONLY on turn 1 — a follow-up body carries
    // neither `anchor` nor `critique_anchor` (see floating-chat.ts's
    // "pin-once" discipline). Deriving memScope from the request body alone
    // therefore fell back to GLOBAL_ONLY on turn 2+ even though the frozen
    // sidecar bundle stayed scoped to the critique's project — two stores
    // for the same conversation. This proves turn 2 still resolves the
    // project scope, via the STORED session anchor.
    const resolveCritiqueAnchor = async (): Promise<ResolveCritiqueResult> => ({
      kind: "resolved",
      context: RESOLVED_CRITIQUE_CTX,
    });
    const seenScopes: unknown[] = [];
    const readMemory = async (_home: string, scope?: unknown) => {
      seenScopes.push(scope);
      return null;
    };
    const resolveProjectRootByHash = async (projHash: string): Promise<string | null> =>
      projHash === "abc123abc123" ? "/repo/scoped-project" : null;

    const a = makeChatApp({ resolveCritiqueAnchor, readMemory, resolveProjectRootByHash });

    // Turn 1 — pins the session.
    const r1 = await post(a, {
      message: "why did you flag this?",
      critique_anchor: { proj_hash: "abc123abc123", critique_id: "c-1a2b" },
    });
    const sid = r1.headers.get("X-Siltpoke-Session-Id")!;
    await drain(r1);
    seenScopes.length = 0; // only care about turn 2's scopes from here

    // Turn 2 — NO anchor/critique_anchor in the body (matches the real
    // client, which pins once). Before the fix, this fell back to
    // GLOBAL_ONLY here.
    const r2 = await post(a, { session_id: sid, message: "follow-up question" });
    await drain(r2);

    expect(seenScopes.length).toBeGreaterThan(0);
    for (const scope of seenScopes) {
      expect(scope).toBe("/repo/scoped-project");
      expect(scope).not.toBe(GLOBAL_ONLY);
    }
  });
});
