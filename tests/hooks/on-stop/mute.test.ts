/**
 * Integration tests — mute gate short-circuits Stop hook BEFORE
 * any other gate (including wake bypass).
 */
import { test, expect, beforeEach, afterEach } from "bun:test";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
  existsSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runHook } from "../../../src/hooks/on-stop";
import { writeMute, MUTE_FILENAME, type MuteFile } from "../../../src/state/mute";
import { runWake } from "../../../src/cli/wake";
import { eventWithProj, noopUsage, fakeBrainOutput } from "./_shared";

let tmpHome: string;
let homeBase: string;

beforeEach(() => {
  tmpHome = mkdtempSync(join(tmpdir(), "siltpoke-mute-hook-"));
  homeBase = join(tmpHome, ".siltpoke");
  mkdirSync(homeBase, { recursive: true });
});

afterEach(() => {
  rmSync(tmpHome, { recursive: true, force: true });
});

function timedMute(homeBase: string, offsetMs: number): void {
  const m: MuteFile = {
    schemaVersion: 1,
    until_ms: Date.now() + offsetMs,
    indefinite: false,
    set_at: new Date().toISOString(),
  };
  writeMute(homeBase, m);
}

test("active mute → hook short-circuits, brain not called, log records skipped=muted", async () => {
  timedMute(homeBase, 60 * 60_000); // 1h
  const ev = eventWithProj(tmpHome, "mute-active");
  let brainCalled = 0;
  await runHook({
    rawJson: JSON.stringify(ev),
    env: { HOME: tmpHome, SILTPOKE_TOOL_AUGMENTED: "0" },
    brainFn: async () => {
      brainCalled++;
      return { output: fakeBrainOutput, usage: noopUsage };
    },
  });
  expect(brainCalled).toBe(0);
  const log = readFileSync(join(homeBase, "brain-calls.jsonl"), "utf8");
  expect(log).toContain('"skipped":"muted"');
});

test("expired mute → hook fires normally (router auto-handles forgot-to-unmute)", async () => {
  timedMute(homeBase, -60_000); // 1min in past
  const ev = eventWithProj(tmpHome, "mute-expired");
  let brainCalled = 0;
  await runHook({
    rawJson: JSON.stringify(ev),
    env: { HOME: tmpHome, SILTPOKE_TOOL_AUGMENTED: "0" },
    brainFn: async () => {
      brainCalled++;
      return { output: fakeBrainOutput, usage: noopUsage };
    },
  });
  expect(brainCalled).toBe(1);
  // mute file lingers (auto-cleanup deferred)
  expect(existsSync(join(homeBase, MUTE_FILENAME))).toBe(true);
});

test("indefinite mute → hook short-circuits", async () => {
  const m: MuteFile = {
    schemaVersion: 1,
    until_ms: null,
    indefinite: true,
    set_at: new Date().toISOString(),
  };
  writeMute(homeBase, m);
  const ev = eventWithProj(tmpHome, "mute-indef");
  let brainCalled = 0;
  await runHook({
    rawJson: JSON.stringify(ev),
    env: { HOME: tmpHome, SILTPOKE_TOOL_AUGMENTED: "0" },
    brainFn: async () => {
      brainCalled++;
      return { output: fakeBrainOutput, usage: noopUsage };
    },
  });
  expect(brainCalled).toBe(0);
  const log = readFileSync(join(homeBase, "brain-calls.jsonl"), "utf8");
  expect(log).toContain('"skipped":"muted"');
});

test("mute beats wake — wake marker survives a muted Stop hook (mute short-circuits BEFORE consumeWake)", async () => {
  // Plant a wake marker that would otherwise short-circuit budget/quiet gates.
  await runWake({ homeBase, now: () => new Date() });
  expect(existsSync(join(homeBase, "wake.json"))).toBe(true);

  // Mute supersedes wake.
  timedMute(homeBase, 60 * 60_000);

  const ev = eventWithProj(tmpHome, "mute-wake");
  let brainCalled = 0;
  await runHook({
    rawJson: JSON.stringify(ev),
    env: { HOME: tmpHome, SILTPOKE_TOOL_AUGMENTED: "0" },
    brainFn: async () => {
      brainCalled++;
      return { output: fakeBrainOutput, usage: noopUsage };
    },
  });
  expect(brainCalled).toBe(0);
  // Wake marker must NOT be consumed — mute returned BEFORE consumeWake ran.
  expect(existsSync(join(homeBase, "wake.json"))).toBe(true);
});

test("corrupt mute.json → fail-open (hook runs normally)", async () => {
  writeFileSync(join(homeBase, MUTE_FILENAME), "{ broken json");
  const ev = eventWithProj(tmpHome, "mute-corrupt");
  let brainCalled = 0;
  await runHook({
    rawJson: JSON.stringify(ev),
    env: { HOME: tmpHome, SILTPOKE_TOOL_AUGMENTED: "0" },
    brainFn: async () => {
      brainCalled++;
      return { output: fakeBrainOutput, usage: noopUsage };
    },
  });
  expect(brainCalled).toBe(1);
});

test("no mute file → hook fires normally", async () => {
  const ev = eventWithProj(tmpHome, "no-mute");
  let brainCalled = 0;
  await runHook({
    rawJson: JSON.stringify(ev),
    env: { HOME: tmpHome, SILTPOKE_TOOL_AUGMENTED: "0" },
    brainFn: async () => {
      brainCalled++;
      return { output: fakeBrainOutput, usage: noopUsage };
    },
  });
  expect(brainCalled).toBe(1);
});
