// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
// Copyright (c) 2026 Jiaqi Duan
import { beforeEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { runHook } from "../../src/hooks/on-stop";
import {
  freshRespawnFixture,
  makeStopJson,
  type SpawnFake,
} from "./respawn-fixture";

describe("on-stop daemon respawn (AC9)", () => {
  let spawnFake: SpawnFake;
  let legacyEnv: NodeJS.ProcessEnv;
  let suppressionEnv: NodeJS.ProcessEnv;

  beforeEach(() => {
    ({ spawnFake, legacyEnv, suppressionEnv } = freshRespawnFixture());
  });

  test("legacy path (SILTPOKE_SUPPRESSION_ENABLED=0) + daemon down → respawns detached with unref", async () => {
    await runHook({
      rawJson: makeStopJson("s-legacy", 1000),
      env: legacyEnv,
      brainFn: async () => ({}) as never,
      spawnFn: spawnFake.fn,
    });
    expect(spawnFake.calls.length).toBe(1);
    // `process.execPath`, not a bare "bun". A hook runs in a non-login shell on
    // Unix and in no shell at all on Windows, where `where.exe bun` finds
    // nothing even when bun is installed — so a bare "bun" here is a command
    // that cannot start. This assertion used to say "bun" and was the reason
    // that shape looked intentional.
    expect(spawnFake.calls[0]?.[0]).toBe(process.execPath);
    expect(spawnFake.calls[0]?.[2]).toBe("start");
    expect(spawnFake.unrefCalls).toBe(1);
    // The half this test's NAME always claimed and never checked.
    expect(spawnFake.opts[0]?.detached).toBe(true);

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

});
