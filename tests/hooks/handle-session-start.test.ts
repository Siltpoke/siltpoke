import { describe, test, expect } from "bun:test";
import { mkdirSync, writeFileSync, readFileSync, rmSync, existsSync, statSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { handleSessionStart } from "../../src/hooks/handle-session-start";
import { enqueuePending, readPending, pendingQueuePath, type PendingCritique } from "../../src/memory/pending-queue";

// Every test in this file uses an isolated tmp HOME (never the real machine
// HOME) — Codex-migration tests below write/read `<HOME>/.codex/hooks.json`
// and `<HOME>/.siltpoke/.codex-migrated`; letting either resolve to the real
// HOME would mutate the developer's actual Codex install (this happened once
// during this track's own development — see the fix that replaced a
// cwd-based plugin-context check with the SILTPOKE_HOST env-var check below).

describe("handleSessionStart", () => {
  test("captures git HEAD SHA + writes to {cwd}/.siltpoke/baseline.json", async () => {
    const dir = join(tmpdir(), `siltpoke-ss-${Date.now()}`);
    mkdirSync(dir, { recursive: true });
    spawnSync("git", ["init"], { cwd: dir });
    writeFileSync(join(dir, "a.txt"), "a");
    spawnSync("git", ["add", "."], { cwd: dir });
    spawnSync("git", ["-c", "user.email=t@t.t", "-c", "user.name=t", "commit", "-m", "init"], { cwd: dir });
    await handleSessionStart({ cwd: dir, session_id: "test-session" });
    const baselinePath = join(dir, ".siltpoke", "baseline.json");
    expect(existsSync(baselinePath)).toBe(true);
    const baseline = JSON.parse(readFileSync(baselinePath, "utf8"));
    expect(baseline.head_sha).toMatch(/^[a-f0-9]+$/);
    expect(baseline.session_id).toBe("test-session");
    rmSync(dir, { recursive: true });
  });

  test("non-git directory → writes baseline with head_sha=null", async () => {
    const dir = join(tmpdir(), `siltpoke-nogit-${Date.now()}`);
    mkdirSync(dir, { recursive: true });
    await handleSessionStart({ cwd: dir, session_id: "test-2" });
    const baseline = JSON.parse(readFileSync(join(dir, ".siltpoke", "baseline.json"), "utf8"));
    expect(baseline.head_sha).toBeNull();
    rmSync(dir, { recursive: true });
  });

  test("Build-2 orphan flush: SessionStart launches the detached distil worker instead of sweeping inline; the pending queue is left unmutated in-hook", async () => {
    // Post-launcher-swap contract: handleSessionStart's flush no longer
    // sweeps the pending queue itself — it only calls
    // maybeLaunchDistilWorker, which is zero-LLM / zero-queue-mutation (it
    // reads the queue to decide whether to spawn, then spawns a detached
    // worker and returns immediately; see src/memory/distil-launcher.ts).
    // Any adjudication (oracle verdicts, hooks_elapsed bumps, writes) now
    // happens OUT-OF-PROCESS in that worker, covered by
    // tests/memory/distil-worker.test.ts (sweepEntriesOnce) and the Task 6
    // integration tests — not here. This test proves the negative: the
    // in-hook path must NOT touch the queue, so the entry survives
    // untouched (hooks_elapsed stays 0) after handleSessionStart returns.
    const dir = join(tmpdir(), `siltpoke-ss-flush-${Date.now()}`);
    const tmpHome = join(tmpdir(), `siltpoke-ss-flush-home-${Date.now()}`);
    mkdirSync(dir, { recursive: true });
    mkdirSync(tmpHome, { recursive: true });

    const stateBase = join(dir, ".siltpoke");
    const entry: PendingCritique = {
      critique_id: "c-flush-1",
      session_id: "prior-session",
      created_sha: null,
      created_at: new Date().toISOString(),
      hooks_elapsed: 0,
      status: "pending",
      severity: "medium",
      finding_text: "fix it",
      anchors: [{ file: "f.ts", line: 1, tool: "ripgrep", fingerprint: "fp" }],
      distil_attempts: 0,
    };
    await enqueuePending(pendingQueuePath(stateBase), entry);

    // Real spawn path: in this (non-bundled) src context, distil-launcher's
    // default workerPath resolves to a nonexistent src/memory/siltpoke-distil.js,
    // so the spawned `bun` process exits immediately with an error and
    // cannot mutate the queue — harmless for this hermetic, launcher-only
    // assertion.
    await handleSessionStart({ cwd: dir, session_id: "test-3", env: { HOME: tmpHome } });

    const pending = await readPending(pendingQueuePath(stateBase));
    expect(pending).toHaveLength(1);
    expect(pending[0]!.hooks_elapsed).toBe(0); // unmutated in-hook: the hook only launches, never sweeps

    rmSync(dir, { recursive: true });
    rmSync(tmpHome, { recursive: true });
  });
});

describe("Codex legacy hooks migration (track #9, tidiness — see maybeMigrateLegacyCodexHooks docstring)", () => {
  test("SILTPOKE_HOST=codex + no prior marker → strips legacy hooks.json entries, writes .codex-migrated once-marker", async () => {
    const dir = join(tmpdir(), `siltpoke-ss-codexmig-${Date.now()}`);
    const tmpHome = join(tmpdir(), `siltpoke-ss-codexmig-home-${Date.now()}`);
    mkdirSync(dir, { recursive: true });
    mkdirSync(join(tmpHome, ".codex"), { recursive: true });

    const hooksPath = join(tmpHome, ".codex", "hooks.json");
    writeFileSync(
      hooksPath,
      JSON.stringify({
        hooks: {
          Stop: [{ hooks: [{ type: "command", command: "bun /repo/src/hooks/codex-stop.ts" }] }],
          SessionStart: [
            {
              matcher: "startup|resume",
              hooks: [
                { type: "command", command: "bun /repo/src/hooks/handle-session-start.ts" },
                { type: "command", command: "bun /other-tool/hook.ts" },
              ],
            },
          ],
        },
      }),
    );

    await handleSessionStart({
      cwd: dir,
      session_id: "test-migrate",
      env: { HOME: tmpHome, SILTPOKE_HOST: "codex" },
    });

    const after = JSON.parse(readFileSync(hooksPath, "utf8"));
    const afterStr = JSON.stringify(after);
    expect(afterStr).not.toContain("codex-stop.ts");
    expect(afterStr).not.toContain("handle-session-start.ts");
    expect(afterStr).toContain("/other-tool/hook.ts"); // foreign entry survives
    expect(existsSync(join(tmpHome, ".siltpoke", ".codex-migrated"))).toBe(true);

    rmSync(dir, { recursive: true });
    rmSync(tmpHome, { recursive: true });
  });

  test("SILTPOKE_HOST unset (legacy source-path invocation) → codex-specific migration never fires, hooks.json untouched, codex marker NOT written", async () => {
    // The codex-specific sweep (removeCodexLegacyHooks) stays gated on
    // SILTPOKE_HOST === "codex". As of the review-#1 fix, its OWN
    // `.codex-migrated` marker is written if-and-only-if that branch
    // actually ran — so with the host unset, the marker must NOT exist
    // either. (Under the earlier, buggy shared-marker design this marker
    // WOULD have been written here regardless of host — that was exactly
    // the bug review #1 caught: it would have permanently defeated a LATER
    // genuine Codex session's sweep on the same machine. See the
    // "multi-host order" test below for the direct proof.)
    const dir = join(tmpdir(), `siltpoke-ss-nomig-${Date.now()}`);
    const tmpHome = join(tmpdir(), `siltpoke-ss-nomig-home-${Date.now()}`);
    mkdirSync(dir, { recursive: true });
    mkdirSync(join(tmpHome, ".codex"), { recursive: true });

    const hooksPath = join(tmpHome, ".codex", "hooks.json");
    const seed = JSON.stringify({
      hooks: { Stop: [{ hooks: [{ type: "command", command: "bun /repo/src/hooks/codex-stop.ts" }] }] },
    });
    writeFileSync(hooksPath, seed);

    await handleSessionStart({ cwd: dir, session_id: "test-nomig", env: { HOME: tmpHome } });

    expect(readFileSync(hooksPath, "utf8")).toBe(seed);
    expect(existsSync(join(tmpHome, ".siltpoke", ".codex-migrated"))).toBe(false);
    // The independent CC-fork marker DOES get written — the CC-fork sweep
    // ran (found no ~/.qoder or ~/.codebuddy home here, so it was a no-op,
    // but it still completed and marked itself done).
    expect(existsSync(join(tmpHome, ".siltpoke", ".ccfork-migrated"))).toBe(true);

    rmSync(dir, { recursive: true });
    rmSync(tmpHome, { recursive: true });
  });

  test("multi-host order: a non-codex SessionStart first must NOT pre-consume the codex marker — a later genuine Codex SessionStart still sweeps", async () => {
    // This is the direct regression proof for review-#1's finding: with the
    // old shared-marker design, the FIRST SessionStart on a machine (almost
    // always non-codex, since hooks/session-start.sh covers CC/qoder/
    // codebuddy and codex has its own wrapper) would write the ONE shared
    // marker without ever running removeCodexLegacyHooks — permanently
    // defeating the codex sweep for that machine. With independent markers,
    // the non-codex run must only consume `.ccfork-migrated`, leaving
    // `.codex-migrated` untouched so a later real Codex session still sweeps.
    const dir = join(tmpdir(), `siltpoke-ss-multihost-${Date.now()}`);
    const tmpHome = join(tmpdir(), `siltpoke-ss-multihost-home-${Date.now()}`);
    mkdirSync(dir, { recursive: true });
    mkdirSync(join(tmpHome, ".codex"), { recursive: true });

    const hooksPath = join(tmpHome, ".codex", "hooks.json");
    const seed = JSON.stringify({
      hooks: { Stop: [{ hooks: [{ type: "command", command: "bun /repo/src/hooks/codex-stop.ts" }] }] },
    });
    writeFileSync(hooksPath, seed);

    // Step 1: a plain (non-codex) SessionStart — e.g. this same machine also
    // runs Claude Code or Qoder, and that host's SessionStart fires FIRST.
    await handleSessionStart({ cwd: dir, session_id: "s1-noncodex", env: { HOME: tmpHome } });
    expect(readFileSync(hooksPath, "utf8")).toBe(seed); // codex hooks.json untouched
    expect(existsSync(join(tmpHome, ".siltpoke", ".codex-migrated"))).toBe(false); // codex marker NOT pre-consumed
    expect(existsSync(join(tmpHome, ".siltpoke", ".ccfork-migrated"))).toBe(true); // cc-fork marker independently written

    // Step 2: LATER, a genuine Codex SessionStart on the SAME machine.
    await handleSessionStart({
      cwd: dir,
      session_id: "s2-codex",
      env: { HOME: tmpHome, SILTPOKE_HOST: "codex" },
    });
    const after = JSON.parse(readFileSync(hooksPath, "utf8"));
    expect(JSON.stringify(after)).not.toContain("codex-stop.ts"); // the sweep DID fire this time
    expect(existsSync(join(tmpHome, ".siltpoke", ".codex-migrated"))).toBe(true); // codex marker now written

    rmSync(dir, { recursive: true });
    rmSync(tmpHome, { recursive: true });
  });

  test("second SessionStart after migration → once-marker short-circuits, no further hooks.json writes", async () => {
    const dir = join(tmpdir(), `siltpoke-ss-migonce-${Date.now()}`);
    const tmpHome = join(tmpdir(), `siltpoke-ss-migonce-home-${Date.now()}`);
    mkdirSync(dir, { recursive: true });
    mkdirSync(join(tmpHome, ".codex"), { recursive: true });

    const hooksPath = join(tmpHome, ".codex", "hooks.json");
    writeFileSync(
      hooksPath,
      JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: "command", command: "bun /repo/src/hooks/codex-stop.ts" }] }] } }),
    );

    await handleSessionStart({ cwd: dir, session_id: "s1", env: { HOME: tmpHome, SILTPOKE_HOST: "codex" } });
    const afterFirst = readFileSync(hooksPath, "utf8");
    expect(afterFirst).not.toContain("codex-stop.ts");

    // Re-seed a legacy entry to prove a second run does NOT strip it again —
    // the once-marker must short-circuit before removeCodexLegacyHooks runs.
    writeFileSync(
      hooksPath,
      JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: "command", command: "bun /repo/src/hooks/codex-stop.ts" }] }] } }),
    );
    await handleSessionStart({ cwd: dir, session_id: "s2", env: { HOME: tmpHome, SILTPOKE_HOST: "codex" } });
    const afterSecond = JSON.parse(readFileSync(hooksPath, "utf8"));
    expect(JSON.stringify(afterSecond)).toContain("codex-stop.ts");

    rmSync(dir, { recursive: true });
    rmSync(tmpHome, { recursive: true });
  });

  test("CC-fork sweep (qoder/codebuddy) fires on a non-codex SessionStart (SILTPOKE_HOST unset), then its OWN once-marker short-circuits it too", async () => {
    // Remaining-hosts track, Task 2 (post-review fixes): removeCcForkLegacyHooks
    // is NOT gated on SILTPOKE_HOST — this is the scenario that actually
    // matters for its target hosts, since the shared hooks/session-start.sh
    // wrapper qoder/codebuddy use never sets that env var. Proves (a) the
    // fork sweep strips the legacy qoder/codebuddy settings.json entries on
    // an ordinary (host-unset) SessionStart, leaving foreign hooks and
    // ~/.codex/hooks.json untouched, and (b) its OWN independent
    // `.ccfork-migrated` once-marker gates a SECOND run from re-sweeping a
    // re-seeded legacy entry (review #1: this marker is independent of
    // `.codex-migrated`, so it can't defeat, or be defeated by, the codex
    // sweep — see the "multi-host order" test above).
    const dir = join(tmpdir(), `siltpoke-ss-ccforkmig-${Date.now()}`);
    const tmpHome = join(tmpdir(), `siltpoke-ss-ccforkmig-home-${Date.now()}`);
    mkdirSync(dir, { recursive: true });
    mkdirSync(join(tmpHome, ".qoder"), { recursive: true });
    mkdirSync(join(tmpHome, ".codebuddy"), { recursive: true });
    mkdirSync(join(tmpHome, ".codex"), { recursive: true });

    const qoderSettingsPath = join(tmpHome, ".qoder", "settings.json");
    const codebuddySettingsPath = join(tmpHome, ".codebuddy", "settings.json");
    const codexHooksPath = join(tmpHome, ".codex", "hooks.json");
    const seed = () =>
      JSON.stringify({
        hooks: {
          Stop: [
            { hooks: [{ type: "command", command: "bun /repo/src/hooks/on-stop.ts" }] },
            { hooks: [{ type: "command", command: "some-other-tool" }] },
          ],
        },
      });
    writeFileSync(qoderSettingsPath, seed());
    writeFileSync(codebuddySettingsPath, seed());
    // Codex's own hooks.json, seeded with a legacy entry too — since
    // SILTPOKE_HOST is unset below, this must stay untouched (the
    // codex-specific sweep must remain host-gated even though the CC-fork
    // sweep no longer is).
    const codexSeed = JSON.stringify({
      hooks: { Stop: [{ hooks: [{ type: "command", command: "bun /repo/src/hooks/codex-stop.ts" }] }] },
    });
    writeFileSync(codexHooksPath, codexSeed);

    await handleSessionStart({
      cwd: dir,
      session_id: "test-ccforkmig",
      env: { HOME: tmpHome }, // no SILTPOKE_HOST — the real qoder/codebuddy shape
    });

    const afterQoder = JSON.stringify(JSON.parse(readFileSync(qoderSettingsPath, "utf8")));
    const afterCodebuddy = JSON.stringify(JSON.parse(readFileSync(codebuddySettingsPath, "utf8")));
    expect(afterQoder).not.toContain("on-stop.ts");
    expect(afterQoder).toContain("some-other-tool"); // foreign entry survives
    expect(afterCodebuddy).not.toContain("on-stop.ts");
    expect(afterCodebuddy).toContain("some-other-tool");
    expect(readFileSync(codexHooksPath, "utf8")).toBe(codexSeed); // codex sweep stayed gated
    expect(existsSync(join(tmpHome, ".siltpoke", ".codex-migrated"))).toBe(false); // codex marker NOT written (host unset)
    expect(existsSync(join(tmpHome, ".siltpoke", ".ccfork-migrated"))).toBe(true); // cc-fork's OWN marker written

    // Re-seed a legacy entry to prove a second SessionStart does NOT
    // re-sweep it — the CC-fork sweep's own `.ccfork-migrated` marker must
    // short-circuit before removeCcForkLegacyHooks runs again.
    writeFileSync(qoderSettingsPath, seed());
    await handleSessionStart({
      cwd: dir,
      session_id: "test-ccforkmig-2",
      env: { HOME: tmpHome },
    });
    const afterSecond = JSON.stringify(JSON.parse(readFileSync(qoderSettingsPath, "utf8")));
    expect(afterSecond).toContain("on-stop.ts");

    rmSync(dir, { recursive: true });
    rmSync(tmpHome, { recursive: true });
  });

  test("agy sweep fires host-independently (SILTPOKE_HOST unset), strips only siltpoke-review, keeps foreign hooks, writes its OWN .agy-migrated marker, and does NOT pre-consume the codex or cc-fork markers", async () => {
    // Task 7: removeAgyLegacyHooks (src/installer/agy-migration.ts) is a
    // THIRD sweep, independent of both the codex sweep (host-gated) and the
    // CC-fork sweep (host-independent) — same "own marker only" contract
    // review #2 established for the codex/cc-fork pair. agy's plugin-native
    // Stop hook never sets SILTPOKE_HOST=codex either, so this sweep must
    // fire on an ordinary (host-unset) SessionStart, exactly like the
    // CC-fork sweep above.
    const dir = join(tmpdir(), `siltpoke-ss-agymig-${Date.now()}`);
    const tmpHome = join(tmpdir(), `siltpoke-ss-agymig-home-${Date.now()}`);
    mkdirSync(dir, { recursive: true });
    mkdirSync(join(tmpHome, ".gemini", "config"), { recursive: true });
    mkdirSync(join(tmpHome, ".codex"), { recursive: true });

    const agyHooksPath = join(tmpHome, ".gemini", "config", "hooks.json");
    const seed = () =>
      JSON.stringify({
        "siltpoke-review": {
          Stop: [{ type: "command", command: "bun /repo/src/hooks/agy-stop.ts", timeout: 30 }],
        },
        "other-tool": { Stop: [{ type: "command", command: "x", timeout: 10 }] },
      });
    writeFileSync(agyHooksPath, seed());

    // Codex's own hooks.json, seeded with a legacy entry too — since
    // SILTPOKE_HOST is unset below, this must stay untouched (the
    // codex-specific sweep must remain host-gated even though the agy
    // sweep, like the CC-fork sweep, is not).
    const codexHooksPath = join(tmpHome, ".codex", "hooks.json");
    const codexSeed = JSON.stringify({
      hooks: { Stop: [{ hooks: [{ type: "command", command: "bun /repo/src/hooks/codex-stop.ts" }] }] },
    });
    writeFileSync(codexHooksPath, codexSeed);

    await handleSessionStart({
      cwd: dir,
      session_id: "test-agymig",
      env: { HOME: tmpHome }, // no SILTPOKE_HOST — the real agy plugin-native shape
    });

    const afterAgy = JSON.parse(readFileSync(agyHooksPath, "utf8"));
    expect(afterAgy["siltpoke-review"]).toBeUndefined();
    expect(afterAgy["other-tool"]).toBeDefined(); // foreign entry survives
    expect(readFileSync(codexHooksPath, "utf8")).toBe(codexSeed); // codex sweep stayed gated
    expect(existsSync(join(tmpHome, ".siltpoke", ".codex-migrated"))).toBe(false); // codex marker NOT written (host unset)
    expect(existsSync(join(tmpHome, ".siltpoke", ".ccfork-migrated"))).toBe(true); // cc-fork's OWN marker written (also host-independent)
    expect(existsSync(join(tmpHome, ".siltpoke", ".agy-migrated"))).toBe(true); // agy's OWN marker written

    // Re-seed a legacy entry to prove a second SessionStart does NOT
    // re-sweep it — the agy sweep's own `.agy-migrated` marker must
    // short-circuit before removeAgyLegacyHooks runs again.
    writeFileSync(agyHooksPath, seed());
    await handleSessionStart({
      cwd: dir,
      session_id: "test-agymig-2",
      env: { HOME: tmpHome },
    });
    const afterSecond = JSON.parse(readFileSync(agyHooksPath, "utf8"));
    expect(afterSecond["siltpoke-review"]).toBeDefined(); // NOT swept again — marker short-circuited

    rmSync(dir, { recursive: true });
    rmSync(tmpHome, { recursive: true });
  });

  test("pre-existing .codex-migrated and .ccfork-migrated markers do not pre-consume the agy sweep, and the agy marker does not retroactively touch either", async () => {
    // Direct regression proof mirroring the "multi-host order" test above,
    // for the third marker: seed the OTHER TWO markers as already-done
    // before the agy sweep ever runs, then confirm the agy sweep still
    // fires (its own marker was absent) and neither pre-seeded marker is
    // rewritten or otherwise disturbed by it.
    const dir = join(tmpdir(), `siltpoke-ss-agyindep-${Date.now()}`);
    const tmpHome = join(tmpdir(), `siltpoke-ss-agyindep-home-${Date.now()}`);
    mkdirSync(dir, { recursive: true });
    mkdirSync(join(tmpHome, ".gemini", "config"), { recursive: true });
    mkdirSync(join(tmpHome, ".siltpoke"), { recursive: true });

    const codexMarkerPath = join(tmpHome, ".siltpoke", ".codex-migrated");
    const ccForkMarkerPath = join(tmpHome, ".siltpoke", ".ccfork-migrated");
    writeFileSync(codexMarkerPath, "");
    writeFileSync(ccForkMarkerPath, "");
    const codexMarkerMtime = statSync(codexMarkerPath).mtimeMs;
    const ccForkMarkerMtime = statSync(ccForkMarkerPath).mtimeMs;

    const agyHooksPath = join(tmpHome, ".gemini", "config", "hooks.json");
    writeFileSync(
      agyHooksPath,
      JSON.stringify({
        "siltpoke-review": {
          Stop: [{ type: "command", command: "bun /repo/src/hooks/agy-stop.ts", timeout: 30 }],
        },
      }),
    );

    await handleSessionStart({
      cwd: dir,
      session_id: "test-agyindep",
      env: { HOME: tmpHome }, // no SILTPOKE_HOST
    });

    // The agy sweep DID fire despite the other two markers already present.
    const afterAgy = JSON.parse(readFileSync(agyHooksPath, "utf8"));
    expect(afterAgy["siltpoke-review"]).toBeUndefined();
    expect(existsSync(join(tmpHome, ".siltpoke", ".agy-migrated"))).toBe(true);

    // Neither pre-seeded marker was rewritten (mtime unchanged) — the agy
    // sweep's own try/catch block never reads or writes them.
    expect(statSync(codexMarkerPath).mtimeMs).toBe(codexMarkerMtime);
    expect(statSync(ccForkMarkerPath).mtimeMs).toBe(ccForkMarkerMtime);

    rmSync(dir, { recursive: true });
    rmSync(tmpHome, { recursive: true });
  });
});
