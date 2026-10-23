// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
// Copyright (c) 2026 Jiaqi Duan
//
// Split out of on-stop-respawn.test.ts when it hit the 50-LOC function cap.
// The seam is real rather than arbitrary: that file covers the ENV GATES that
// decide whether a respawn is attempted at all; this one covers what the
// liveness probe sees, and what happens when the machinery around it breaks.
import { beforeEach, describe, expect, test } from "bun:test";
import { runHook } from "../../src/hooks/on-stop";
import {
  freshRespawnFixture,
  makeStopJson,
  type SpawnFake,
} from "./respawn-fixture";

describe("on-stop daemon respawn — the probe, and failing softly", () => {
  let spawnFake: SpawnFake;
  let legacyEnv: NodeJS.ProcessEnv;
  let suppressionEnv: NodeJS.ProcessEnv;

  beforeEach(() => {
    ({ spawnFake, legacyEnv, suppressionEnv } = freshRespawnFixture());
  });

  test("daemon alive → probe passes, no respawn (both paths)", async () => {
    // The body matters: the probe identifies the responder, so a server that
    // just says "ok" is a stranger, not the daemon (audit defect `[5b]`). This
    // fixture used to serve exactly that and still assert "no respawn" — it
    // was asserting the bug.
    const server = Bun.serve({
      port: 0,
      fetch: () =>
        Response.json({ service: "siltpoked", ok: true, mode: "global", pid: 1 }),
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

  test("a stranger on the port does NOT count as alive — the daemon is respawned", async () => {
    // Without this, a dev server holding the port silently suppresses the
    // self-healing respawn at every Stop, and nothing is ever surfaced.
    const stranger = Bun.serve({
      port: 0,
      fetch: () => new Response("<!doctype html><title>not siltpoke</title>"),
    });
    try {
      await runHook({
        rawJson: makeStopJson("s-stranger", 3200),
        env: { ...legacyEnv, SILTPOKE_DAEMON_PORT: String(stranger.port) },
        brainFn: async () => ({}) as never,
        spawnFn: spawnFake.fn,
      });
      expect(spawnFake.calls.length).toBe(1);
    } finally {
      stranger.stop(true);
    }
  });

});

// Failing soft is its own concern from what the probe sees: these two assert
// that the respawn machinery can break in any way at all and the hook's real
// job still completes.
describe("on-stop daemon respawn — failing soft", () => {
  let spawnFake: SpawnFake;
  let legacyEnv: NodeJS.ProcessEnv;

  beforeEach(() => {
    ({ spawnFake, legacyEnv } = freshRespawnFixture());
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
