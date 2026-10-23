// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
// Copyright (c) 2026 Jiaqi Duan
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export function makeStopJson(sessionId: string, ts: number): string {
  return JSON.stringify({
    hook_event_name: "Stop",
    session_id: sessionId,
    stop_event_timestamp_ms: ts,
    transcript_path: "/dev/null",
    cwd: "/tmp",
    stop_hook_active: false,
  });
}

export interface SpawnFake {
  calls: string[][];
  /**
   * The options each spawn was given.
   *
   * Recorded because this suite's own test name has said "respawns DETACHED
   * with unref" since it was written, while it asserted only `unref` — and the
   * spawn was not detached. `unref()` frees the parent's event loop; it says
   * nothing about the child's process group, and the process group is what
   * decides whether the child dies with its parent. On Unix that gap is
   * invisible; on Windows it killed the daemon seconds after launch.
   */
  opts: Array<{ stdio: ["ignore", "ignore", "ignore"]; detached: true }>;
  unrefCalls: number;
  fn: (
    cmd: string[],
    opts: { stdio: ["ignore", "ignore", "ignore"]; detached: true },
  ) => { unref(): void };
}

export function makeSpawnFake(): SpawnFake {
  const fake: SpawnFake = {
    calls: [],
    opts: [],
    unrefCalls: 0,
    fn: (cmd, opts) => {
      fake.calls.push(cmd);
      fake.opts.push(opts);
      return {
        unref() {
          fake.unrefCalls += 1;
        },
      };
    },
  };
  return fake;
}

/**
 * A fresh home, a fresh spawn double, and the two env shapes these suites use.
 *
 * Extracted when the original describe hit the 50-LOC function cap, so both
 * halves share one definition of "a clean respawn fixture" instead of drifting.
 */
export function freshRespawnFixture(): {
  spawnFake: SpawnFake;
  legacyEnv: NodeJS.ProcessEnv;
  suppressionEnv: NodeJS.ProcessEnv;
} {
    const spawnFake = makeSpawnFake();
    const home = mkdtempSync(join(tmpdir(), "respawn-home-"));
    // This suite tests respawn mechanics specifically, so opt the daemon in —
    // Task 2 gated maybeRespawnDaemon behind daemon.enabled (default off),
    // and these tests assert the pre-gate respawn behavior still works when
    // a user has opted in. `daemon.enabled` lives in `<siltpokeRoot>/config.json`
    // (~/.siltpoke/config.json, see src/installer/paths.ts's siltpokeRoot()) —
    // NOT `<HOME>/config.json` directly (that path is never read; the
    // daemon-opt-in Task 4 slice fixed maybeRespawnDaemon's home resolution
    // to match).
    const siltpokeDir = join(home, ".siltpoke");
    mkdirSync(siltpokeDir, { recursive: true });
    writeFileSync(
      join(siltpokeDir, "config.json"),
      JSON.stringify({ daemon: { enabled: true } }),
    );
    const legacyEnv: NodeJS.ProcessEnv = {
      ...process.env,
      HOME: home,
      SILTPOKE_DAEMON_PORT: "65535", // unreachable — probe always fails
      // Task 7 flipped the marker-suppression default to ON — "no env" no
      // longer means legacy, so these "legacy path" cases opt out explicitly.
      SILTPOKE_SUPPRESSION_ENABLED: "0",
    };
    delete legacyEnv.SILTPOKE_DISABLE_RESPAWN;
    delete legacyEnv.SILTPOKE_SUPPRESSION_DISABLE_RESPAWN;
    // Other suites (e.g. tests/cli/demo-seed.test.ts) set process.env.SILTPOKE_HOME
    // at module load with no cleanup, which the `...process.env` spread above
    // would otherwise inherit — since maybeRespawnDaemon now resolves
    // daemon.enabled via siltpokeRoot(env) (respects SILTPOKE_HOME as an
    // override), a leaked value here would silently redirect the config.json
    // read away from `home` and break this suite depending on run order.
    // Force it unset so this suite is deterministic regardless of load order.
    delete legacyEnv.SILTPOKE_HOME;
    const suppressionEnv: NodeJS.ProcessEnv = {
      ...legacyEnv,
      SILTPOKE_SUPPRESSION_ENABLED: "1",
      SILTPOKE_MARKER_DIR: mkdtempSync(join(tmpdir(), "respawn-markers-")),
    };
  return { spawnFake, legacyEnv, suppressionEnv };
}
