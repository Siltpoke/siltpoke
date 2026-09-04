// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
// Copyright (c) 2026 Jiaqi Duan
/**
 * Critique-chat — Task 6 end-to-end acceptance proof.
 *
 * Every other critique-anchor test in the suite stubs `resolveCritiqueAnchor`
 * (or `resolveCritiqueContext`) directly with a canned `AnchorContext` —
 * that proves the ROUTE wiring but not the full resolve chain. THIS test
 * mounts the chat app with the REAL production chain:
 *
 *   POST /api/chat
 *     → resolveCritiqueAnchorImpl (src/daemon/server.ts, format-guards
 *       proj_hash, resolves memScope)
 *       → resolveCritiqueContext (src/chat/critique-context.ts, REAL —
 *         only its innermost IO seam, readTelemetry, is stubbed)
 *         → assembleCritiqueContext (REAL, pure — builds the AnchorContext
 *           body from the CriticCall)
 *     → writeAnchorContext (REAL — sidecar written to a temp homeBase)
 *     → readAnchorContext (REAL — sidecar read back before streaming)
 *     → composeBaseSystemPrompt (REAL — injects anchorCtx into systemPrompt)
 *   → streamFactory (test seam — the ONLY thing standing in for `claude -p`)
 *
 * The streamFactory echoes the received `systemPrompt` into the reply text,
 * so the SSE response body becomes an observable proof of what actually
 * reached the model. Only three things are stubbed: the telemetry reader
 * (no real brain-calls.jsonl on disk), `resolveRepoByHash` (no real
 * repo-graph registration needed for the critique lookup to succeed), and
 * the `claude -p` subprocess itself.
 *
 * What breaks this test if the wiring regresses:
 *   - resolveCritiqueAnchorImpl's proj_hash format guard rejects a
 *     well-formed hash → critique_not_found → JSON block, no stream.
 *   - resolveCritiqueContext fails to pass `readTelemetry` through to the
 *     real reader, or looks up the wrong field (e.g. matches on session_id
 *     instead of critique_id) → critique_not_found.
 *   - assembleCritiqueContext drops critique_for_claude from the body →
 *     the distinctive text never reaches contextBundle.
 *   - writeAnchorContext/readAnchorContext round-trip loses fields (e.g. a
 *     schema drift silently truncates contextBundle) → sidecar read back
 *     missing the critique text.
 *   - composeBaseSystemPrompt stops injecting `anchorCtx.contextBundle` →
 *     systemPrompt never carries the critique text even though the sidecar
 *     has it.
 * Any of these regressions makes the assertion on the STREAMED TEXT fail —
 * not a mock-level assertion on an intermediate object, so this cannot pass
 * with the injection chain broken.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { resolveCritiqueContext } from "../../src/chat/critique-context";
import { openIndex } from "../../src/chat/fts5-index";
import { mountChatRoutes } from "../../src/daemon/routes/chat";
import type { StreamChatOptions, StreamEvent } from "../../src/daemon/routes/chat-stream";
import { resolveCritiqueAnchorImpl } from "../../src/daemon/server";
import { GLOBAL_ONLY } from "../../src/memory/memory";
import type { CriticTelemetry } from "../../src/state/api";
import type { CriticCall, ReadTelemetryOpts } from "../../src/state/critic-event-log-types";

const CRITIQUE_ID = "c-1a2b";
const PROJ_HASH = "abc123abc123"; // 12 lowercase hex chars — isValidProjHash-shaped.
const DISTINCTIVE_CRITIQUE_TEXT = "token expiry uses < not <=";
const TEST_SECRET = "test-secret";

const ELIGIBLE_PROJECT = async () => ({
  project_id: null,
  proj_hash: null,
  project_root: null,
  display_name: null,
  source: "explicit" as const,
});

let home: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "siltpoke-critique-chat-acceptance-"));
});
afterEach(() => rmSync(home, { recursive: true, force: true }));

/** Minimal well-formed CriticCall carrying the target critique_id + text. */
function makeCriticCall(overrides: Partial<CriticCall> = {}): CriticCall {
  return {
    timestamp: "2026-07-12T19:00:00.000Z",
    session_id: "sess-acc-1",
    cwd: "/repo/acceptance",
    project: "acceptance",
    status: "fired",
    skip_reason: null,
    bubble_short: "acceptance test critique",
    bubble_long: null,
    critique_for_claude: DISTINCTIVE_CRITIQUE_TEXT,
    severity: "high",
    confidence: "high",
    evidence: [{ file: "src/auth/token.ts", line: 42, snippet: "if (age < ttl)" }],
    audit_absence: "unrecorded" as const,
    evidence_label: null,
    evidence_unverified: 0,
    diff_shown: null,
    diff_total: null,
    gating_decision: null,
    turns_included: null,
    duration_ms: null,
    cost_usd: null,
    tokens: null,
    provider: "anthropic",
    authorFamily: "claude",
    billing: "usd",
    model: null,
    diff_snapshot_id: null,
    diff_text: "diff --git a/src/auth/token.ts b/src/auth/token.ts\n-if (age < ttl)\n+if (age <= ttl)",
    diff_summary: null,
    summary_error: null,
    error_message: null,
    user_action: null,
    speech_kind: "critical",
    reasoning: "The comparison excludes the boundary instant, letting an expired token through.",
    timing: null,
    critique_id: CRITIQUE_ID,
    v2: null,
    branch: null,
    user_raw_query: null,
    user_raw_query_truncated: false,
    agent_reply: null,
    ...overrides,
  };
}

/** Stub telemetry reader — the ONLY IO seam resolveCritiqueContext exposes.
 * Returns exactly one CriticCall carrying CRITIQUE_ID + the distinctive text.
 * Everything downstream of this (assembleCritiqueContext, the sidecar
 * round-trip, composeBaseSystemPrompt) is the REAL production code. */
function makeStubReadTelemetry(call: CriticCall): typeof import("../../src/state/api").readCriticTelemetry {
  return (async (_homeBase: string, _now: Date, _opts?: ReadTelemetryOpts) => {
    return {
      recent: [call],
    } as CriticTelemetry;
  }) as typeof import("../../src/state/api").readCriticTelemetry;
}

/** streamFactory test seam standing in for `claude -p` — echoes the received
 * systemPrompt into the reply text so the SSE body becomes an observable
 * proof of what actually reached the model. */
function echoSystemPromptStream(
  opts: StreamChatOptions,
): AsyncGenerator<StreamEvent, void, void> {
  const echoed = opts.systemPrompt ?? "(no systemPrompt)";
  return (async function* () {
    yield { type: "message_start", message_id: "m-echo", model: "mock" };
    yield { type: "content_block_delta", text: echoed };
    yield {
      type: "message_stop",
      usage: { input_tokens: 1, output_tokens: 1 },
      full_text: echoed,
    };
  })();
}

describe("critique-chat acceptance — real resolve chain, stubbed telemetry IO only", () => {
  test("critique-anchored send injects the REAL critique into the system prompt, and it survives the SSE stream", async () => {
    const call = makeCriticCall();
    const readTelemetry = makeStubReadTelemetry(call);

    // The REAL resolveCritiqueContext, with ONLY its telemetry IO seam
    // stubbed. readMemoryFn is left at its default (the real readMemory) —
    // there's no memory.json in this temp homeBase, so it resolves to null,
    // which assembleCritiqueContext handles (no memory block appended).
    const resolveCritiqueContextWithStubTelemetry: typeof resolveCritiqueContext = (input) =>
      resolveCritiqueContext({ ...input, readTelemetry });

    // resolveRepoByHash stub: no real repo-graph registration exists for
    // PROJ_HASH in this temp homeBase — real resolveRepoByHash would also
    // return null here, this just skips the disk read. memScope falls back
    // to GLOBAL_ONLY exactly as it would in production for an unindexed repo.
    const resolveRepoByHash = async () => null;

    // The REAL resolveCritiqueAnchorImpl (proj_hash format guard + memScope
    // resolution + delegation) — the exact function server.ts binds.
    const resolveCritiqueAnchor = (ref: { proj_hash: string; critique_id: string }) =>
      resolveCritiqueAnchorImpl(ref, {
        homeBase: home,
        resolveRepoByHash,
        resolveCritiqueContext: resolveCritiqueContextWithStubTelemetry,
      });

    const app = new Hono();
    mountChatRoutes(app, {
      resolveProject: ELIGIBLE_PROJECT,
      homeBase: home,
      index: openIndex(home),
      secret: TEST_SECRET,
      streamFactory: echoSystemPromptStream,
      resolveCritiqueAnchor,
      now: () => new Date("2026-07-12T20:00:00.000Z"),
    });

    const res = await app.request("/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Siltpoke-Secret": TEST_SECRET },
      body: JSON.stringify({
        message: "why did you flag this?",
        critique_anchor: { proj_hash: PROJ_HASH, critique_id: CRITIQUE_ID },
      }),
    });

    // Must be a real SSE stream — a broken chain would return a JSON
    // {blocked:"critique_gone"} signal instead (200, but application/json).
    expect(res.headers.get("content-type")).toContain("event-stream");
    const body = await res.text();

    // The distinctive critique text made it all the way through
    // resolve → assemble → freeze (sidecar) → inject (systemPrompt) →
    // stream (echoed by the fake claude -p) → the SSE wire.
    expect(body).toContain(DISTINCTIVE_CRITIQUE_TEXT);

    // The read-only chat system prompt is present too — proves
    // composeBaseSystemPrompt injected `anchorCtx.systemPrompt`, not just
    // the contextBundle.
    expect(body).toContain("You are siltpoke");
    expect(body).toContain("cannot take actions from this chat");

    // The evidence + diff also made it through assembleCritiqueContext's
    // formatting — further proof this is the real assembler, not a stub.
    expect(body).toContain("src/auth/token.ts:42");
    expect(body).toContain("if (age <= ttl)");
  });

  test("an unresolvable critique_id (no matching telemetry row) → honest critique_gone, no stream, no leaked text", async () => {
    // The stub telemetry returns a DIFFERENT critique_id than the one the
    // client requests — proves the real find-by-id lookup in
    // resolveCritiqueContext actually discriminates, it doesn't just return
    // the first row unconditionally.
    const call = makeCriticCall({ critique_id: "c-different", critique_for_claude: "unrelated text" });
    const readTelemetry = makeStubReadTelemetry(call);
    const resolveCritiqueContextWithStubTelemetry: typeof resolveCritiqueContext = (input) =>
      resolveCritiqueContext({ ...input, readTelemetry });
    const resolveRepoByHash = async () => null;
    const resolveCritiqueAnchor = (ref: { proj_hash: string; critique_id: string }) =>
      resolveCritiqueAnchorImpl(ref, {
        homeBase: home,
        resolveRepoByHash,
        resolveCritiqueContext: resolveCritiqueContextWithStubTelemetry,
      });

    const app = new Hono();
    mountChatRoutes(app, {
      resolveProject: ELIGIBLE_PROJECT,
      homeBase: home,
      index: openIndex(home),
      secret: TEST_SECRET,
      streamFactory: echoSystemPromptStream,
      resolveCritiqueAnchor,
      now: () => new Date("2026-07-12T20:00:00.000Z"),
    });

    const res = await app.request("/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Siltpoke-Secret": TEST_SECRET },
      body: JSON.stringify({
        message: "why did you flag this?",
        critique_anchor: { proj_hash: PROJ_HASH, critique_id: CRITIQUE_ID },
      }),
    });

    expect(res.headers.get("content-type")).toContain("application/json");
    const signal = (await res.json()) as Record<string, unknown>;
    expect(signal.blocked).toBe("critique_gone");
    expect(signal.critique_id).toBe(CRITIQUE_ID);
  });

  test("well-formed proj_hash with no registered repo still resolves the critique (memScope falls back to GLOBAL_ONLY)", async () => {
    // Complementary to the happy path: proves resolveCritiqueAnchorImpl's
    // memScope fallback (GLOBAL_ONLY) doesn't block critique resolution —
    // an unindexed repo can still chat about a fired critique.
    const call = makeCriticCall();
    const readTelemetry = makeStubReadTelemetry(call);
    let capturedMemScope: unknown;
    const resolveCritiqueContextSpy: typeof resolveCritiqueContext = async (input) => {
      capturedMemScope = input.memScope;
      return resolveCritiqueContext({ ...input, readTelemetry });
    };
    const resolveRepoByHash = async () => null;

    const result = await resolveCritiqueAnchorImpl(
      { proj_hash: PROJ_HASH, critique_id: CRITIQUE_ID },
      { homeBase: home, resolveRepoByHash, resolveCritiqueContext: resolveCritiqueContextSpy },
    );

    expect(result.kind).toBe("resolved");
    expect(capturedMemScope).toBe(GLOBAL_ONLY);
  });
});
