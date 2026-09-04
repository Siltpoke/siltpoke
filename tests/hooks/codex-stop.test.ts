// Codex-host Stop hook entry (track #7 T4, AC4 recursion suppression).
//
// codex-stop.ts is the actual process the user's codex config invokes
// (wired by src/installer/codex-integration.ts:84). It normalizes the codex
// event shape then delegates to on-stop.ts's runHook -> handle-stop.ts's
// handleStopHook, whose FIRST line is shouldFire(event, env) — the same
// SILTPOKE_INTERNAL early-return the claude Stop path already relies on
// (src/router/router.ts). No duplicate guard is added in codex-stop.ts
// itself; these tests prove the inherited guard actually fires for the
// codex-normalized event shape, before any brain call or network side effect.
import { test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runCodexStopHook, normalizeCodexStop } from "../../src/hooks/codex-stop";
import { shouldFire, type HookEvent } from "../../src/router/router";
import type { CallBrainOptions, BrainCallResult } from "../../src/brain/brain";

let tmpHome: string;

beforeEach(() => {
  tmpHome = mkdtempSync(join(tmpdir(), "siltpoke-codex-stop-"));
});

afterEach(() => {
  rmSync(tmpHome, { recursive: true, force: true });
});

const NEVER_CALL_BRAIN = async (_opts: CallBrainOptions): Promise<BrainCallResult> => {
  throw new Error("brainFn must never be invoked when SILTPOKE_INTERNAL=1");
};

test("SILTPOKE_INTERNAL=1: zero brain calls, zero network side effects, skip logged as recursion_guard", async () => {
  const originalFetch = globalThis.fetch;
  let fetchCalls = 0;
  globalThis.fetch = (async (...args: Parameters<typeof fetch>) => {
    fetchCalls++;
    return originalFetch(...args);
  }) as typeof fetch;

  try {
    await runCodexStopHook({
      rawJson: JSON.stringify({
        session_id: "codex-abc",
        transcript_path: join(tmpHome, "missing.jsonl"),
        cwd: "/tmp",
      }),
      env: {
        SILTPOKE_INTERNAL: "1",
        HOME: tmpHome,
        // Belt-and-braces: prove zero network side effects, not just zero
        // brain calls — the always-run daemon self-heal (maybeRespawnDaemon
        // in on-stop.ts) is a SEPARATE, harmless health-check unrelated to
        // AC4's recursion concern; disabling it here isolates the assertion
        // to exactly what AC4 cares about (no review-of-review spawn).
        SILTPOKE_DISABLE_RESPAWN: "1",
      },
      brainFn: NEVER_CALL_BRAIN,
    });
  } finally {
    globalThis.fetch = originalFetch;
  }

  expect(fetchCalls).toBe(0);

  const log = readFileSync(join(tmpHome, ".siltpoke", "brain-calls.jsonl"), "utf8");
  expect(log).toContain('"skipped":"recursion_guard"');
});

test("without SILTPOKE_INTERNAL, the codex-normalized event shape is accepted by shouldFire (proves the guard above is a real gate, not an always-skip)", () => {
  const normalized = JSON.parse(
    normalizeCodexStop(
      JSON.stringify({
        session_id: "codex-abc",
        transcript_path: "/tmp/codex-transcript.jsonl",
        cwd: "/tmp",
      }),
    ),
  ) as HookEvent;

  expect(shouldFire(normalized, {}).fire).toBe(true);
});

test("normalizeCodexStop tags siltpoke_host: codex and defaults session_id when absent", () => {
  const normalized = JSON.parse(normalizeCodexStop("{}")) as Record<string, unknown>;
  expect(normalized.siltpoke_host).toBe("codex");
  expect(normalized.session_id).toBe("codex");
  expect(normalized.hook_event_name).toBe("Stop");
});
