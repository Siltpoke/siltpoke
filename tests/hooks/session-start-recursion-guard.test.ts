// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
// Copyright (c) 2026 Jiaqi Duan
//
// The SessionStart hook had NO `SILTPOKE_INTERNAL` guard while its sibling the
// Stop hook did (`shouldFire` → `recursion_guard`). Consequence, live-observed
// across five repos and several weeks: every Brain call (`claude -p`, codex,
// agy, ccfork — all spawn with `SILTPOKE_INTERNAL: "1"`) starts a nested host
// session in the SAME cwd, whose SessionStart rewrote
// `{cwd}/.siltpoke/baseline.json` with the nested session's throwaway
// `session_id`. `resolveSessionHeadSha` matches on EXACT `session_id`, so from
// the first review onward the real session could no longer resolve its own
// baseline → every `PendingCritique` enqueued with `created_sha: null` → the
// acted-on oracle abstained `no_baseline_sha` 100% of the time → no rule was
// ever written and forward-capture Phase 2 could never finalize.
//
// The pre-existing deferred entry (🌱 2026-07-07) called this "benign within a
// turn (head_sha unchanged)" — it tracked only `head_sha` drift and missed that
// the same write replaces `session_id`, which is the field the lookup keys on.
import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { codexFirstRunNudge, handleSessionStart } from "../../src/hooks/handle-session-start";
import { resolveSessionHeadSha } from "../../src/hooks/handle-stop";
import { readSessionBaseline, resolveOrCaptureSessionHeadSha } from "../../src/hooks/session-baseline";
import { isSiltpokeInternal, shouldFire } from "../../src/router/router";

const REAL_SESSION = "real-session-aaaa";
const NESTED_SESSION = "nested-throwaway-bbbb";

/** A git repo with one commit, so `head_sha` is a real sha. */
function repo(): { dir: string; sha: string } {
  const dir = mkdtempSync(join(tmpdir(), "sp-ssguard-"));
  spawnSync("git", ["init"], { cwd: dir });
  writeFileSync(join(dir, "a.txt"), "a");
  spawnSync("git", ["add", "."], { cwd: dir });
  spawnSync("git", ["-c", "user.email=t@t.t", "-c", "user.name=t", "commit", "-m", "init"], { cwd: dir });
  const sha = spawnSync("git", ["rev-parse", "HEAD"], { cwd: dir, encoding: "utf8" }).stdout.trim();
  return { dir, sha };
}

function tmpHome(): string {
  const h = mkdtempSync(join(tmpdir(), "sp-ssguard-home-"));
  mkdirSync(join(h, ".siltpoke"), { recursive: true });
  return h;
}

describe("SessionStart recursion guard (SILTPOKE_INTERNAL)", () => {
  test("a nested internal SessionStart leaves an existing baseline.json byte-identical", async () => {
    const { dir, sha } = repo();
    const home = tmpHome();
    const baselinePath = join(dir, ".siltpoke", "baseline.json");

    // The REAL session's baseline, as its own SessionStart wrote it.
    await handleSessionStart({ cwd: dir, session_id: REAL_SESSION, env: { HOME: home } as NodeJS.ProcessEnv });
    const before = readFileSync(baselinePath, "utf8");
    expect(JSON.parse(before).session_id).toBe(REAL_SESSION);

    // Now a Brain call spawns a nested host session in the SAME cwd.
    await handleSessionStart({
      cwd: dir,
      session_id: NESTED_SESSION,
      env: { HOME: home, SILTPOKE_INTERNAL: "1" } as NodeJS.ProcessEnv,
    });

    expect(readFileSync(baselinePath, "utf8")).toBe(before); // byte-identical
    const after = JSON.parse(readFileSync(baselinePath, "utf8"));
    expect(after.session_id).toBe(REAL_SESSION); // NOT the nested throwaway id
    expect(after.head_sha).toBe(sha);
  });

  test("the real session can still resolve its own baseline after a nested internal SessionStart — i.e. created_sha will NOT be null", async () => {
    // This is the actual defect's consequence, asserted end-to-end through the
    // very function the enqueue path uses. A null here is exactly what made the
    // oracle abstain `no_baseline_sha` on every critique.
    const { dir, sha } = repo();
    const home = tmpHome();

    await handleSessionStart({ cwd: dir, session_id: REAL_SESSION, env: { HOME: home } as NodeJS.ProcessEnv });
    await handleSessionStart({
      cwd: dir,
      session_id: NESTED_SESSION,
      env: { HOME: home, SILTPOKE_INTERNAL: "1" } as NodeJS.ProcessEnv,
    });

    expect(resolveSessionHeadSha(dir, REAL_SESSION)).toBe(sha);
    // The LIVE resolver too, and not just for its sha. `resolveOrCaptureSessionHeadSha`
    // rescues a missing baseline by capturing HEAD, and HEAD has not moved in this
    // fixture — so if this defect regressed, the sha alone would still match and this
    // guard would go quiet. The marker is what distinguishes "resolved its own
    // baseline" from "was rescued": a genuine record carries no `late_capture`.
    expect(resolveOrCaptureSessionHeadSha(dir, REAL_SESSION)).toBe(sha);
    expect(readSessionBaseline(dir, REAL_SESSION)?.late_capture).toBeUndefined();
  });

  test("a nested internal SessionStart in a virgin cwd writes no baseline at all", async () => {
    const { dir } = repo();
    const home = tmpHome();
    await handleSessionStart({
      cwd: dir,
      session_id: NESTED_SESSION,
      env: { HOME: home, SILTPOKE_INTERNAL: "1" } as NodeJS.ProcessEnv,
    });
    expect(existsSync(join(dir, ".siltpoke", "baseline.json"))).toBe(false);
  });

  // --- Positive controls: the guard must not swallow the normal path ---

  test("POSITIVE CONTROL: without the flag, SessionStart still writes the baseline", async () => {
    const { dir, sha } = repo();
    const home = tmpHome();
    await handleSessionStart({ cwd: dir, session_id: REAL_SESSION, env: { HOME: home } as NodeJS.ProcessEnv });
    const b = JSON.parse(readFileSync(join(dir, ".siltpoke", "baseline.json"), "utf8"));
    expect(b.session_id).toBe(REAL_SESSION);
    expect(b.head_sha).toBe(sha);
  });

  test("POSITIVE CONTROL: a genuinely new REAL session still replaces a stale baseline", async () => {
    // The guard keys on the env flag, never on "the id differs" — a real
    // second session must still be able to re-baseline.
    const { dir } = repo();
    const home = tmpHome();
    await handleSessionStart({ cwd: dir, session_id: REAL_SESSION, env: { HOME: home } as NodeJS.ProcessEnv });
    await handleSessionStart({ cwd: dir, session_id: "second-real-cccc", env: { HOME: home } as NodeJS.ProcessEnv });
    const b = JSON.parse(readFileSync(join(dir, ".siltpoke", "baseline.json"), "utf8"));
    expect(b.session_id).toBe("second-real-cccc");
  });

  test("SILTPOKE_INTERNAL values other than \"1\" do NOT suppress (same strictness as shouldFire)", async () => {
    const { dir } = repo();
    const home = tmpHome();
    await handleSessionStart({
      cwd: dir,
      session_id: REAL_SESSION,
      env: { HOME: home, SILTPOKE_INTERNAL: "0" } as NodeJS.ProcessEnv,
    });
    expect(JSON.parse(readFileSync(join(dir, ".siltpoke", "baseline.json"), "utf8")).session_id).toBe(REAL_SESSION);
  });

  // --- Sibling instance of the same missing guard ---

  test("the codex first-run nudge marker is not burned by a nested internal session", async () => {
    // The marker fires once ever. Consuming it inside a nested Brain call means
    // the user's REAL session never shows the nudge — same root cause, second
    // victim.
    const home = tmpHome();
    const env = { HOME: home, SILTPOKE_HOST: "codex", SILTPOKE_INTERNAL: "1" } as unknown as NodeJS.ProcessEnv;
    expect(codexFirstRunNudge(env)).toBeNull();
    expect(existsSync(join(home, ".siltpoke", ".codex-nudged"))).toBe(false);

    // POSITIVE CONTROL: the same call without the flag still nudges.
    const env2 = { HOME: home, SILTPOKE_HOST: "codex" } as unknown as NodeJS.ProcessEnv;
    expect(codexFirstRunNudge(env2)).not.toBeNull();
    expect(existsSync(join(home, ".siltpoke", ".codex-nudged"))).toBe(true);
  });

  // --- One predicate, so the two hooks can never drift apart again ---

  test("SessionStart and Stop read the SAME recursion predicate", () => {
    expect(isSiltpokeInternal({ SILTPOKE_INTERNAL: "1" } as NodeJS.ProcessEnv)).toBe(true);
    expect(isSiltpokeInternal({ SILTPOKE_INTERNAL: "0" } as NodeJS.ProcessEnv)).toBe(false);
    expect(isSiltpokeInternal({} as NodeJS.ProcessEnv)).toBe(false);
    // the Stop side still routes it to the same reason string
    expect(
      shouldFire(
        { hook_event_name: "Stop", session_id: "s", transcript_path: "/t" },
        { SILTPOKE_INTERNAL: "1" } as NodeJS.ProcessEnv,
      ),
    ).toEqual({ fire: false, reason: "recursion_guard" });
  });
});
