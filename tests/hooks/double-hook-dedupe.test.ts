// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
// Copyright (c) 2026 Jiaqi Duan
//
// An upgrading user can have BOTH the legacy settings.json Stop hook AND the
// plugin's hooks.json Stop hook registered at once. Claude Code fires both for
// the SAME Stop event, and both run on-stop.ts — so without a working dedupe
// that is two Brain calls (double spend) per turn.
//
// The marker (src/daemon/marker.ts) is what stands between such a user and
// double spend. Its key MUST be derived from data both hook processes compute
// IDENTICALLY for the same logical Stop event. It now is: session_id + a hash
// of the transcript CONTENT (deriveStopMarkerKey). The previous key,
// sha256(session_id | stop_event_timestamp_ms), was broken — that timestamp is
// not a field in Claude Code's real Stop payload, so both processes fell back
// to Date.now() at different instants, produced different keys, and NEVER
// collided. The marker silently did nothing.
//
// WHY THESE TESTS USE ONLY REAL PAYLOAD FIELDS (no stop_event_timestamp_ms):
// the deleted predecessor of this file injected an identical
// stop_event_timestamp_ms into both calls, which no real install ever produces
// — a false green that passed against the broken key. These fire the real
// event shape instead.
//
// WHY TEST 1 USES TWO SEPARATE HOMEs: handleStopHook has its OWN orthogonal
// per-session content-hash "no_change" gate (src/router/skip-detector.ts),
// whose skip-state lives under HOME. With a shared HOME that gate would dedupe
// the second call on its own and MASK the marker — exactly the false green the
// old test fell into. Splitting HOME neutralizes that gate so the MARKER is the
// only thing that can dedupe; the marker dir is shared (as the real
// ~/.siltpoke/markers is), so brainCalls===1 isolates and proves the marker.
// Under the old Date.now() key this test reads 2.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runHook } from "../../src/hooks/on-stop";
import { commitAll, makeGitRepo } from "../_shared/git-fixture";

let tmpHome: string;
let markerDir: string;

beforeEach(() => {
  tmpHome = mkdtempSync(join(tmpdir(), "siltpoke-dedupe-home-"));
  markerDir = mkdtempSync(join(tmpdir(), "siltpoke-dedupe-markers-"));
});
afterEach(() => {
  rmSync(tmpHome, { recursive: true, force: true });
  rmSync(markerDir, { recursive: true, force: true });
});

function writeTranscript(path: string, userText: string): void {
  writeFileSync(
    path,
    `${JSON.stringify({ type: "user", message: { role: "user", content: userText } })}\n` +
      `${JSON.stringify({
        type: "assistant",
        message: {
          content: [
            { type: "text", text: "reply" },
            { type: "tool_use", name: "Edit", input: { file_path: "src/dummy.ts" } },
          ],
        },
      })}\n`,
  );
}

function makeCwdWithChange(): string {
  const cwd = join(tmpHome, "proj");
  // Git-init BEFORE anything resolves a project root — creating `.git`
  // moves that root, and per-repo memory is keyed on it.
  makeGitRepo(cwd);
  mkdirSync(join(cwd, "src"), { recursive: true });
  writeFileSync(join(cwd, "src", "dummy.ts"), "export const dummy = 1;\n");
  return cwd;
}

describe("double-hook dedupe (legacy settings.json hook + plugin hook both live)", () => {
  test("the SAME stop event reviewed twice calls the Brain ONCE (marker isolated from the content-hash gate)", async () => {
    const transcriptPath = join(tmpHome, "t.jsonl");
    const cwd = makeCwdWithChange();
    writeTranscript(transcriptPath, "one and only turn");

    let brainCalls = 0;
    const brainFn = async () => {
      brainCalls++;
      return { ok: true } as never;
    };
    const rawJson = JSON.stringify({
      hook_event_name: "Stop",
      session_id: "s1",
      transcript_path: transcriptPath,
      cwd,
    });
    // Shared marker dir (as the real ~/.siltpoke/markers is), separate HOMEs so
    // the per-session content-hash gate can't mask the marker.
    const baseEnv = {
      SILTPOKE_TOOL_AUGMENTED: "0",
      SILTPOKE_MARKER_DIR: markerDir,
      SILTPOKE_DISABLE_RESPAWN: "1",
      SILTPOKE_DAEMON_PORT: "65535", // unreachable — probe never stalls
    };
    const home1 = mkdtempSync(join(tmpdir(), "dedupe-h1-"));
    const home2 = mkdtempSync(join(tmpdir(), "dedupe-h2-"));

    // First "hook" fires (e.g. the legacy settings.json registration).
    await runHook({ rawJson, env: { ...baseEnv, HOME: home1 }, brainFn });
    // Second "hook" fires for the SAME event (the plugin's hooks.json one).
    await runHook({ rawJson, env: { ...baseEnv, HOME: home2 }, brainFn });

    rmSync(home1, { recursive: true, force: true });
    rmSync(home2, { recursive: true, force: true });

    expect(brainCalls).toBe(1); // NOT 2 — that would be double spend
  });

  test("real concurrent race (two hook processes at once) → Brain called ONCE", async () => {
    const transcriptPath = join(tmpHome, "t.jsonl");
    const cwd = makeCwdWithChange();
    writeTranscript(transcriptPath, "one and only turn");

    let brainCalls = 0;
    const brainFn = async () => {
      brainCalls++;
      return { ok: true } as never;
    };
    const baseEnv = {
      SILTPOKE_TOOL_AUGMENTED: "0",
      SILTPOKE_MARKER_DIR: markerDir,
      SILTPOKE_DISABLE_RESPAWN: "1",
      SILTPOKE_DAEMON_PORT: "65535",
    };
    const rawJson = JSON.stringify({
      hook_event_name: "Stop",
      session_id: "s1",
      transcript_path: transcriptPath,
      cwd,
    });
    // Split HOME per process (same rationale as test 1): with a shared HOME the
    // content-hash gate could mask a marker regression that let both concurrent
    // calls reach handleStopHook. Separate skip-state ⇒ the MARKER is the only
    // thing that can hold brainCalls at 1 here.
    const home1 = mkdtempSync(join(tmpdir(), "dedupe-c1-"));
    const home2 = mkdtempSync(join(tmpdir(), "dedupe-c2-"));

    // Both processes fire for the identical event. Only one wins the atomic
    // O_EXCL claim; the loser exits before it reaches handleStopHook. With the
    // transcript-content key this is deterministic (both compute the same key).
    await Promise.all([
      runHook({ rawJson, env: { ...baseEnv, HOME: home1 }, brainFn }),
      runHook({ rawJson, env: { ...baseEnv, HOME: home2 }, brainFn }),
    ]);

    rmSync(home1, { recursive: true, force: true });
    rmSync(home2, { recursive: true, force: true });

    expect(brainCalls).toBe(1);
  });

  test("two DIFFERENT stop events (different transcript content) each get reviewed", async () => {
    const cwd = makeCwdWithChange();

    let brainCalls = 0;
    const brainFn = async () => {
      brainCalls++;
      return { ok: true } as never;
    };
    const env = {
      HOME: tmpHome,
      SILTPOKE_TOOL_AUGMENTED: "0",
      SILTPOKE_MARKER_DIR: markerDir,
      SILTPOKE_DISABLE_RESPAWN: "1",
      SILTPOKE_DAEMON_PORT: "65535",
    };

    const t1 = join(tmpHome, "t1.jsonl");
    writeTranscript(t1, "first turn");
    await runHook({
      rawJson: JSON.stringify({
        hook_event_name: "Stop",
        session_id: "s1",
        transcript_path: t1,
        cwd,
      }),
      env,
      brainFn,
    });

    const t2 = join(tmpHome, "t2.jsonl");
    writeTranscript(t2, "second, different turn");
    // The second turn closes its own unit. Under the ⏱ review-unit axis a turn
    // that commits nothing is not a unit, so without this the second run stops
    // at `no_new_commit` and the marker safety-net — what this test is about —
    // is never the thing being measured.
    commitAll(cwd, "second turn's work");
    await runHook({
      rawJson: JSON.stringify({
        hook_event_name: "Stop",
        session_id: "s1",
        transcript_path: t2,
        cwd,
      }),
      env,
      brainFn,
    });

    expect(brainCalls).toBe(2); // safety net must NOT suppress real reviews
  });

  test("marker dir unwritable → the review still happens (fail-soft), Brain called, no throw", async () => {
    const transcriptPath = join(tmpHome, "t.jsonl");
    const cwd = makeCwdWithChange();
    writeTranscript(transcriptPath, "a turn");

    // Make the marker subsystem error for a reason OTHER than EEXIST: point the
    // marker dir at a path UNDER a regular file, so mkdir + O_EXCL open throw
    // ENOTDIR. A dropped review here would be the worse-than-double-spend bug.
    const blocker = join(tmpHome, "blocker-file");
    writeFileSync(blocker, "not a directory");
    const unwritableMarkerDir = join(blocker, "markers");

    let brainCalls = 0;
    const brainFn = async () => {
      brainCalls++;
      return { ok: true } as never;
    };
    const env = {
      HOME: tmpHome,
      SILTPOKE_TOOL_AUGMENTED: "0",
      SILTPOKE_MARKER_DIR: unwritableMarkerDir,
      SILTPOKE_DISABLE_RESPAWN: "1",
      SILTPOKE_DAEMON_PORT: "65535",
    };
    const rawJson = JSON.stringify({
      hook_event_name: "Stop",
      session_id: "s1",
      transcript_path: transcriptPath,
      cwd,
    });

    // Must resolve without throwing AND still review.
    await runHook({ rawJson, env, brainFn });
    expect(brainCalls).toBe(1);
  });

  test("missing transcript → fail soft: no suppressing marker written (never drops a real review)", async () => {
    const cwd = makeCwdWithChange();
    let brainCalls = 0;
    const brainFn = async () => {
      brainCalls++;
      return { ok: true } as never;
    };
    const env = {
      HOME: tmpHome,
      SILTPOKE_TOOL_AUGMENTED: "0",
      SILTPOKE_MARKER_DIR: markerDir,
      SILTPOKE_DISABLE_RESPAWN: "1",
      SILTPOKE_DAEMON_PORT: "65535",
    };
    const rawJson = JSON.stringify({
      hook_event_name: "Stop",
      session_id: "s1",
      transcript_path: join(tmpHome, "does-not-exist.jsonl"),
      cwd,
    });

    // No usable key → we must fall through to reviewing, NOT write a marker
    // that could suppress a later real review. (handleStopHook's own
    // no-code-changes gate may then skip the Brain call — the point here is
    // purely that the marker layer never suppresses on a missing transcript.)
    await runHook({ rawJson, env, brainFn });
    expect(readdirSync(markerDir).length).toBe(0);
  });
});
