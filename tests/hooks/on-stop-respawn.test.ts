// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
// Copyright (c) 2026 Jiaqi Duan
import { beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runHook } from "../../src/hooks/on-stop";

function makeStopJson(sessionId: string, ts: number): string {
  return JSON.stringify({
    hook_event_name: "Stop",
    session_id: sessionId,
    stop_event_timestamp_ms: ts,
    transcript_path: "/dev/null",
    cwd: "/tmp",
    stop_hook_active: false,
  });
}

interface SpawnFake {
  calls: string[][];
  unrefCalls: number;
  fn: (cmd: string[], opts: { stdio: ["ignore", "ignore", "ignore"] }) => { unref(): void };
}

function makeSpawnFake(): SpawnFake {
  const fake: SpawnFake = {
    calls: [],
    unrefCalls: 0,
    fn: (cmd) => {
      fake.calls.push(cmd);
      return {
        unref() {
          fake.unrefCalls += 1;
        },
      };
    },
  };
  return fake;
}

describe("on-stop daemon respawn (AC9)", () => {
  let spawnFake: SpawnFake;
  let legacyEnv: NodeJS.ProcessEnv;
  let suppressionEnv: NodeJS.ProcessEnv;

  beforeEach(() => {
    spawnFake = makeSpawnFake();
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
    legacyEnv = {
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
    suppressionEnv = {
      ...legacyEnv,
      SILTPOKE_SUPPRESSION_ENABLED: "1",
      SILTPOKE_MARKER_DIR: mkdtempSync(join(tmpdir(), "respawn-markers-")),
    };
  });

  test("legacy path (SILTPOKE_SUPPRESSION_ENABLED=0) + daemon down → respawns detached with unref", async () => {
    await runHook({
      rawJson: makeStopJson("s-legacy", 1000),
      env: legacyEnv,
      brainFn: async () => ({}) as never,
      spawnFn: spawnFake.fn,
    });
    expect(spawnFake.calls.length).toBe(1);
    expect(spawnFake.calls[0]?.[0]).toBe("bun");
    expect(spawnFake.calls[0]?.[2]).toBe("start");
    expect(spawnFake.unrefCalls).toBe(1);

    // argv[1] — the script path — used to be stepped over by this file: it
    // asserted [0] and [2] and never looked at what was actually being run.
    // The path was the only part that was wrong (it resolved above the repo
    // root once bundled), so respawn was broken on every built install with
    // this test green. Assert the spawned target is a real file.
    const script = spawnFake.calls[0]?.[1];
    expect(script).toBeDefined();
    expect(existsSync(script!)).toBe(true);
  });

  test("legacy path + SILTPOKE_DISABLE_RESPAWN=1 → no respawn", async () => {
    await runHook({
      rawJson: makeStopJson("s-legacy-off", 1100),
      env: { ...legacyEnv, SILTPOKE_DISABLE_RESPAWN: "1" },
      brainFn: async () => ({}) as never,
      spawnFn: spawnFake.fn,
    });
    expect(spawnFake.calls.length).toBe(0);
  });

  test("legacy path + old alias SILTPOKE_SUPPRESSION_DISABLE_RESPAWN=1 → no respawn", async () => {
    await runHook({
      rawJson: makeStopJson("s-legacy-alias", 1200),
      env: { ...legacyEnv, SILTPOKE_SUPPRESSION_DISABLE_RESPAWN: "1" },
      brainFn: async () => ({}) as never,
      spawnFn: spawnFake.fn,
    });
    expect(spawnFake.calls.length).toBe(0);
  });

  test("suppression path + daemon down → respawns with unref", async () => {
    await runHook({
      rawJson: makeStopJson("s-supp", 2000),
      env: suppressionEnv,
      brainFn: async () => ({}) as never,
      spawnFn: spawnFake.fn,
    });
    expect(spawnFake.calls.length).toBe(1);
    expect(spawnFake.unrefCalls).toBe(1);
  });

  test("suppression path + SILTPOKE_DISABLE_RESPAWN=1 → no respawn", async () => {
    await runHook({
      rawJson: makeStopJson("s-supp-off", 2100),
      env: { ...suppressionEnv, SILTPOKE_DISABLE_RESPAWN: "1" },
      brainFn: async () => ({}) as never,
      spawnFn: spawnFake.fn,
    });
    expect(spawnFake.calls.length).toBe(0);
  });

  test("suppression path + old env still blocks respawn", async () => {
    await runHook({
      rawJson: makeStopJson("s-supp-alias", 2200),
      env: { ...suppressionEnv, SILTPOKE_SUPPRESSION_DISABLE_RESPAWN: "1" },
      brainFn: async () => ({}) as never,
      spawnFn: spawnFake.fn,
    });
    expect(spawnFake.calls.length).toBe(0);
  });

  test("daemon alive → probe passes, no respawn (both paths)", async () => {
    const server = Bun.serve({
      port: 0,
      fetch: () => new Response("ok"),
    });
    try {
      const alivePort = String(server.port);
      await runHook({
        rawJson: makeStopJson("s-alive-legacy", 3000),
        env: { ...legacyEnv, SILTPOKE_DAEMON_PORT: alivePort },
        brainFn: async () => ({}) as never,
        spawnFn: spawnFake.fn,
      });
      await runHook({
        rawJson: makeStopJson("s-alive-supp", 3100),
        env: { ...suppressionEnv, SILTPOKE_DAEMON_PORT: alivePort },
        brainFn: async () => ({}) as never,
        spawnFn: spawnFake.fn,
      });
      expect(spawnFake.calls.length).toBe(0);
    } finally {
      server.stop(true);
    }
  });

  test("spawn throwing never breaks the hook (fail-soft)", async () => {
    await runHook({
      rawJson: makeStopJson("s-throw", 4000),
      env: legacyEnv,
      brainFn: async () => ({}) as never,
      spawnFn: () => {
        throw new Error("spawn exploded");
      },
    });
    // Reaching here without a throw is the assertion.
    expect(true).toBe(true);
  });

  test("exploding brainFn still triggers the respawn (finally guarantee)", async () => {
    // handleStopHook is deliberately fail-soft (brain errors are logged, not
    // thrown), so this can't force runHook to reject — but it exercises the
    // deepest error path and pins that the finally-respawn survives it.
    await runHook({
      rawJson: makeStopJson("s-brain-throw", 5000),
      env: legacyEnv,
      brainFn: (async () => {
        throw new Error("brain exploded");
      }) as never,
      spawnFn: spawnFake.fn,
    });
    expect(spawnFake.calls.length).toBe(1);
    expect(spawnFake.unrefCalls).toBe(1);
  });
});
