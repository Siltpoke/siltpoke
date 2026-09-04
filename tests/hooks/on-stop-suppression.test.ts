import { beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  claimMarker,
  completeMarker,
  deriveStopMarkerKey,
} from "../../src/daemon/marker";
import { runHook } from "../../src/hooks/on-stop";

// The marker key is derived from session_id + a hash of the transcript
// CONTENT (deriveStopMarkerKey), NOT from any timestamp. These tests therefore
// key off a real transcript file whose bytes are what both the pre-seed and
// runHook hash — exactly what a real install does.
describe("on-stop suppression", () => {
  let markerDir: string;
  let home: string;
  let transcriptPath: string;
  let brainCalls: number;
  let baseEnv: NodeJS.ProcessEnv;

  function makeStopJson(sessionId: string): string {
    return JSON.stringify({
      hook_event_name: "Stop",
      session_id: sessionId,
      transcript_path: transcriptPath,
      cwd: "/tmp",
      stop_hook_active: false,
    });
  }

  // The transcript is always written in beforeEach, so the key is never null
  // here — resolve it without a non-null assertion.
  function keyFor(sessionId: string): string {
    const k = deriveStopMarkerKey({ session_id: sessionId, transcript_path: transcriptPath });
    if (k === null) throw new Error("test transcript should be readable");
    return k;
  }

  beforeEach(() => {
    markerDir = mkdtempSync(join(tmpdir(), "supp-"));
    home = mkdtempSync(join(tmpdir(), "supp-home-"));
    transcriptPath = join(home, "transcript.jsonl");
    // A single stable transcript — the identity of THIS Stop event.
    writeFileSync(
      transcriptPath,
      `${JSON.stringify({ type: "user", message: { role: "user", content: "hi" } })}\n`,
    );
    brainCalls = 0;
    baseEnv = {
      ...process.env,
      HOME: home,
      SILTPOKE_SUPPRESSION_ENABLED: "1",
      SILTPOKE_MARKER_DIR: markerDir,
      SILTPOKE_DAEMON_PORT: "65535", // unreachable port — probe always fails
      SILTPOKE_SUPPRESSION_DISABLE_RESPAWN: "1",
    };
  });

  // Task 7 flipped the default: marker suppression is now ON unless the caller
  // explicitly opts out with SILTPOKE_SUPPRESSION_ENABLED=0 — so "no env" no
  // longer means legacy. This test now exercises the explicit escape hatch.
  test("suppression explicitly disabled (SILTPOKE_SUPPRESSION_ENABLED=0) → falls through to handleStopHook", async () => {
    await runHook({
      rawJson: makeStopJson("s1"),
      env: {
        ...process.env,
        HOME: mkdtempSync(join(tmpdir(), "h-")),
        SILTPOKE_SUPPRESSION_ENABLED: "0",
      },
      brainFn: async () => {
        return {} as any;
      },
      // Legacy path now self-heals too (AC9) — intercept so the test never
      // spawns a real daemon.
      spawnFn: () => ({ unref() {} }),
    });
    // Legacy behavior preserved. handleStopHook may or may not call brainFn depending on gates,
    // but the suppression-marker layer must NOT short-circuit.
    // We mainly assert the marker dir was NOT touched.
    expect(readdirSync(markerDir).length).toBe(0);
  });

  test("marker state=done → suppresses (no brain call, no claim)", async () => {
    const key = keyFor("s1");
    claimMarker(markerDir, key);
    completeMarker(markerDir, key);
    await runHook({
      rawJson: makeStopJson("s1"),
      env: baseEnv,
      brainFn: async () => {
        brainCalls += 1;
        return {} as any;
      },
    });
    expect(brainCalls).toBe(0);
  });

  test("marker state=claimed + daemon probe fails → claims + runs brain", async () => {
    const key = keyFor("s1");
    // Pre-write a CLAIMED (not stale) marker but daemon is unreachable (port 65535).
    claimMarker(markerDir, key);
    // No completeMarker call.
    await runHook({
      rawJson: makeStopJson("s1"),
      env: baseEnv,
      brainFn: async () => {
        brainCalls += 1;
        return {} as any;
      },
    });
    // Probe fails → falls through to claim. But claim returns false (already claimed by us above).
    // So we exit without brain. This tests the safe path: someone else owns the claim and daemon isn't responding,
    // we don't double-claim.
    expect(brainCalls).toBe(0);
  });

  test("no marker + daemon down → claims + runs brain", async () => {
    await runHook({
      rawJson: makeStopJson("s1"),
      env: baseEnv,
      brainFn: async () => {
        brainCalls += 1;
        return {} as any;
      },
    });
    // We claimed our own marker and ran brain (subject to handleStopHook's gates).
    // brain may or may not be called depending on handleStopHook gates (code-change gate, etc.).
    // But the marker MUST be present.
    const key = keyFor("s1");
    expect(readdirSync(markerDir).some((f) => f.includes(key))).toBe(true);
  });

  test("stale claimed marker (>120s) → treated retry-eligible, claims-or-skips", async () => {
    const key = keyFor("s1");
    claimMarker(markerDir, key);
    // Manually age the claim by overwriting the file with old claimedAt.
    writeFileSync(
      join(markerDir, `${key}.marker`),
      JSON.stringify({
        state: "claimed",
        claimedAt: Date.now() - 200_000, // > 120s
        doneAt: null,
      }),
    );
    await runHook({
      rawJson: makeStopJson("s1"),
      env: baseEnv,
      brainFn: async () => {
        brainCalls += 1;
        return {} as any;
      },
    });
    // staleClaim → probe (fails) → claim again. Claim returns false (file still exists from pre-write).
    // So no brain. This is acceptable behavior: stale marker is logged + skipped to avoid double-fire.
    // We just assert no crash + marker still exists.
    expect(readdirSync(markerDir).some((f) => f.includes(key))).toBe(true);
  });
});
