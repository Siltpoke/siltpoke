// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
// Copyright (c) 2026 Jiaqi Duan
//
// `baseline.json` was stored per-CWD in a single slot but READ with an exact
// per-session key (`resolveSessionHeadSha`: `persisted.session_id === sessionId`).
// So the moment a SECOND real session started in the same cwd it overwrote the
// slot, and the FIRST session was blinded for the rest of its life — every
// `PendingCritique` it enqueued carried `created_sha: null` and the acted-on
// oracle abstained `no_baseline_sha` on all of them, so no rule was ever written.
//
// SCOPE — this suite covers a STRUCTURAL HAZARD, established by reading the
// code, NOT the `no_baseline_sha` abstains actually observed in this repo up to
// 2026-07-30. Those were diagnosed separately as siltpoke's OWN nested Brain
// session rewriting the slot with a throwaway id, and fixed by the
// `SILTPOKE_INTERNAL` recursion guard (`session-start-recursion-guard.test.ts`)
// — positive evidence: `brain-calls.jsonl` rows carrying
// `{"skipped": "recursion_guard"}` ~0.4s before each real Stop row, plus the
// timing argument that `resolveSessionHeadSha` runs before the Brain call. A
// live store still reading `0 acted` after that fix is explained by the
// already-poisoned `baseline.json` the fix cannot retro-heal. Do not re-derive
// concurrency as the cause of that reading; it was refuted once already.
//
// The two defects are still distinct: that guard keys on an env var, and two
// REAL concurrent sessions are indistinguishable by env var, so it cannot cover
// this case. Running several sessions in one checkout is the documented working
// pattern for this workspace, so "don't do that" is not available as a fix.
import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { handleSessionStart } from "../../src/hooks/handle-session-start";
import { resolveSessionHeadSha } from "../../src/hooks/handle-stop";
import {
  BASELINE_RETENTION_DAYS,
  readSessionBaseline,
  resolveOrCaptureSessionHeadSha,
  sessionBaselineDir,
  sessionBaselinePath,
} from "../../src/hooks/session-baseline";

const SESSION_A = "aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa";
const SESSION_B = "bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb";

/** A git repo with one commit, so `head_sha` is a real sha. */
function repo(): { dir: string; sha: string } {
  const dir = mkdtempSync(join(tmpdir(), "sp-concurrent-"));
  spawnSync("git", ["init"], { cwd: dir });
  writeFileSync(join(dir, "a.txt"), "a");
  spawnSync("git", ["add", "."], { cwd: dir });
  spawnSync("git", ["-c", "user.email=t@t.t", "-c", "user.name=t", "commit", "-m", "init"], { cwd: dir });
  const sha = spawnSync("git", ["rev-parse", "HEAD"], { cwd: dir, encoding: "utf8" }).stdout.trim();
  return { dir, sha };
}

function tmpHome(): string {
  const h = mkdtempSync(join(tmpdir(), "sp-concurrent-home-"));
  mkdirSync(join(h, ".siltpoke"), { recursive: true });
  return h;
}

const envFor = (home: string) => ({ HOME: home }) as NodeJS.ProcessEnv;

describe("concurrent real sessions in one cwd each keep their own baseline", () => {
  test("the FIRST session can still resolve its baseline after a second real session starts", async () => {
    const { dir, sha } = repo();
    const home = tmpHome();

    await handleSessionStart({ cwd: dir, session_id: SESSION_A, env: envFor(home) });
    await handleSessionStart({ cwd: dir, session_id: SESSION_B, env: envFor(home) });

    // The defect: this was null, so every critique A enqueued abstained.
    expect(resolveSessionHeadSha(dir, SESSION_A)).toBe(sha);
    // The LIVE resolver too, and not just for its sha. `resolveOrCaptureSessionHeadSha`
    // rescues a missing baseline by capturing HEAD, and HEAD has not moved in this
    // fixture — so if this defect regressed, the sha alone would still match and this
    // guard would go quiet. The marker is what distinguishes "resolved its own
    // baseline" from "was rescued": a genuine record carries no `late_capture`.
    expect(resolveOrCaptureSessionHeadSha(dir, SESSION_A)).toBe(sha);
    expect(readSessionBaseline(dir, SESSION_A)?.late_capture).toBeUndefined();
  });

  test("the SECOND session resolves its baseline too", async () => {
    const { dir, sha } = repo();
    const home = tmpHome();

    await handleSessionStart({ cwd: dir, session_id: SESSION_A, env: envFor(home) });
    await handleSessionStart({ cwd: dir, session_id: SESSION_B, env: envFor(home) });

    expect(resolveSessionHeadSha(dir, SESSION_B)).toBe(sha);
  });

  test("a session that never started still resolves to null", async () => {
    // The lookup must stay a lookup — it may not start inventing baselines.
    const { dir } = repo();
    const home = tmpHome();
    await handleSessionStart({ cwd: dir, session_id: SESSION_A, env: envFor(home) });
    expect(resolveSessionHeadSha(dir, "cccccccc-3333-4333-8333-cccccccccccc")).toBeNull();
  });

  test("SIMULTANEOUS starts — every session resolves, and nobody reads a half-written file", async () => {
    // The rest of this file awaits each start in turn, which proves the
    // SEQUENTIAL case only. The write is tmp+rename precisely so the truly
    // parallel case cannot expose a partial file to a concurrent reader; that is
    // untested unless something actually races.
    const { dir, sha } = repo();
    const home = tmpHome();
    const ids = Array.from({ length: 8 }, (_, i) => `eeeeeeee-5555-4555-8555-00000000000${i}`);

    await Promise.all(ids.map((id) => handleSessionStart({ cwd: dir, session_id: id, env: envFor(home) })));

    for (const id of ids) expect(resolveSessionHeadSha(dir, id)).toBe(sha);
    // The shared legacy slot must still be parseable — a torn write would make
    // this throw or read as null.
    const legacy = JSON.parse(readFileSync(join(dir, ".siltpoke", "baseline.json"), "utf8"));
    expect(legacy.head_sha).toBe(sha);
    expect(ids).toContain(legacy.session_id); // some winner, never a mangled value
  });

  test("session ids differing only in case do not share one file on a case-insensitive filesystem", async () => {
    // macOS APFS defaults to case-insensitive, so `AAA.json` and `aaa.json` are
    // one physical file. Without a digest in the filename the second write
    // clobbers the first, below the level the exact-id content check can see.
    const { dir, sha } = repo();
    const home = tmpHome();
    const lower = "ff00ff00-6666-4666-8666-abcdefabcdef";
    const upper = lower.toUpperCase();

    await handleSessionStart({ cwd: dir, session_id: lower, env: envFor(home) });
    await handleSessionStart({ cwd: dir, session_id: upper, env: envFor(home) });

    expect(sessionBaselinePath(join(dir, ".siltpoke"), lower)).not.toBe(
      sessionBaselinePath(join(dir, ".siltpoke"), upper),
    );
    expect(resolveSessionHeadSha(dir, lower)).toBe(sha);
    expect(resolveSessionHeadSha(dir, upper)).toBe(sha);
  });

  test("five interleaved sessions all resolve — not just the last writer", async () => {
    const { dir, sha } = repo();
    const home = tmpHome();
    const ids = Array.from({ length: 5 }, (_, i) => `dddddddd-4444-4444-8444-00000000000${i}`);
    for (const id of ids) await handleSessionStart({ cwd: dir, session_id: id, env: envFor(home) });
    for (const id of ids) expect(resolveSessionHeadSha(dir, id)).toBe(sha);
  });

  // --- back-compat: a session already in flight when this ships ---

  test("a legacy-only baseline.json still resolves for its matching session", async () => {
    // An upgrade lands mid-session: the per-session file was never written
    // because the old code did not write one. The exact-match read must still
    // work, or shipping the fix would blind every live session once.
    const { dir } = repo();
    mkdirSync(join(dir, ".siltpoke"), { recursive: true });
    writeFileSync(
      join(dir, ".siltpoke", "baseline.json"),
      JSON.stringify({ head_sha: "deadbeef", session_id: SESSION_A, captured_at: new Date().toISOString() }),
    );
    expect(resolveSessionHeadSha(dir, SESSION_A)).toBe("deadbeef");
    expect(resolveSessionHeadSha(dir, SESSION_B)).toBeNull();
  });

  test("legacy baseline.json is still written, so its other readers keep working", async () => {
    // `why-index-wiring.ts` and `eval/e2e-canary/drive.ts` both read this path
    // directly; the fix is additive and may not move their file out from under
    // them.
    const { dir, sha } = repo();
    const home = tmpHome();
    await handleSessionStart({ cwd: dir, session_id: SESSION_A, env: envFor(home) });
    const legacy = JSON.parse(readFileSync(join(dir, ".siltpoke", "baseline.json"), "utf8"));
    expect(legacy.session_id).toBe(SESSION_A);
    expect(legacy.head_sha).toBe(sha);
  });

  // --- the session id reaches a filesystem path, so it is untrusted input ---

  test("a traversing session id cannot write outside the state dir, and never throws", async () => {
    const { dir } = repo();
    const home = tmpHome();
    const evil = "../../../../etc/pwned";
    await handleSessionStart({ cwd: dir, session_id: evil, env: envFor(home) });

    expect(existsSync(join(dir, ".siltpoke", "baselines", "..", "..", "..", "..", "etc", "pwned.json"))).toBe(false);
    // It degrades to the legacy slot rather than losing the baseline entirely.
    expect(JSON.parse(readFileSync(join(dir, ".siltpoke", "baseline.json"), "utf8")).session_id).toBe(evil);
    expect(resolveSessionHeadSha(dir, evil)).not.toBeNull();
  });

  test("a session id with a path separator writes no per-session file", async () => {
    const { dir } = repo();
    const home = tmpHome();
    await handleSessionStart({ cwd: dir, session_id: "a/b", env: envFor(home) });
    // Nothing nested got created under baselines/.
    expect(existsSync(join(sessionBaselineDir(join(dir, ".siltpoke")), "a"))).toBe(false);
  });

  // --- bounded growth: one file per session would otherwise accumulate forever ---

  test("per-session baselines older than the retention window are pruned on the next start", async () => {
    const { dir, sha } = repo();
    const home = tmpHome();

    await handleSessionStart({ cwd: dir, session_id: SESSION_A, env: envFor(home) });
    // Resolved through the production path helper, so the test cannot drift from
    // the real filename scheme (it carries a digest suffix).
    const stale = sessionBaselinePath(join(dir, ".siltpoke"), SESSION_A)!;
    expect(existsSync(stale)).toBe(true);

    // Backdate it well past the window.
    const old = Date.now() / 1000 - (BASELINE_RETENTION_DAYS + 1) * 86_400;
    utimesSync(stale, old, old);

    await handleSessionStart({ cwd: dir, session_id: SESSION_B, env: envFor(home) });

    expect(existsSync(stale)).toBe(false);
    expect(resolveSessionHeadSha(dir, SESSION_B)).toBe(sha); // the fresh one survives
  });
});
