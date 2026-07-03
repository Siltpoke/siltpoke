import { test, expect, beforeEach, afterEach } from "bun:test";
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  existsSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runHook } from "../../../src/hooks/on-stop";
import type { BrainOutput } from "../../../src/brain/schema";
import { eventWithProj, noopUsage, fakeBrainOutput } from "./_shared";

let tmpHome: string;

beforeEach(() => {
  tmpHome = mkdtempSync(join(tmpdir(), "siltpoke-hook-"));
});

afterEach(() => {
  rmSync(tmpHome, { recursive: true, force: true });
});

test("quiet hours: hook skips with sleeping_quiet state", async () => {
  const homeBase = join(tmpHome, ".siltpoke");
  const fs = await import("node:fs");
  fs.mkdirSync(homeBase, { recursive: true });
  fs.writeFileSync(
    join(homeBase, "config.json"),
    JSON.stringify({
      quietHours: { start: "00:00", end: "23:59", timezone: "local" },
    }),
  );

  const ev = eventWithProj(tmpHome, "qh", "sess-quiet");
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
  expect(log).toContain('"skipped":"quiet_hours"');

  const state = JSON.parse(
    readFileSync(join(ev.cwd, ".siltpoke", "state.json"), "utf8"),
  );
  expect(state.mood).toBe("sleeping_quiet");
  expect(state.bubble_short).toBe("");
});

test("budget hard stop: hook skips with sleeping_broke state", async () => {
  const homeBase = join(tmpHome, ".siltpoke");
  const fs = await import("node:fs");
  fs.mkdirSync(homeBase, { recursive: true });
  fs.writeFileSync(
    join(homeBase, "config.json"),
    JSON.stringify({
      budget: {
        dailyTokenLimit: 1000,
        softWarnAtPercent: 80,
        hardStopAtPercent: 100,
      },
    }),
  );
  // Pre-seed an event that exceeds the budget.
  fs.writeFileSync(
    join(homeBase, "usage-events.jsonl"),
    `${JSON.stringify({
      ts: new Date().toISOString(),
      kind: "main",
      session_id: "prev",
      input_tokens: 2000,
      output_tokens: 0,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
      total_cost_usd: 0.002,
    })}\n`,
  );

  const ev = eventWithProj(tmpHome, "hard", "sess-hard");
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
  expect(log).toContain('"skipped":"budget_hard_stop"');

  const state = JSON.parse(
    readFileSync(join(ev.cwd, ".siltpoke", "state.json"), "utf8"),
  );
  expect(state.mood).toBe("sleeping_broke");
});

test("budget soft threshold: hook short-circuits with degraded log", async () => {
  const homeBase = join(tmpHome, ".siltpoke");
  const fs = await import("node:fs");
  fs.mkdirSync(homeBase, { recursive: true });
  fs.writeFileSync(
    join(homeBase, "config.json"),
    JSON.stringify({
      budget: {
        dailyTokenLimit: 1000,
        softWarnAtPercent: 80,
        hardStopAtPercent: 100,
      },
    }),
  );
  fs.writeFileSync(
    join(homeBase, "usage-events.jsonl"),
    `${JSON.stringify({
      ts: new Date().toISOString(),
      kind: "main",
      session_id: "prev",
      input_tokens: 850,
      output_tokens: 0,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
      total_cost_usd: 0.001,
    })}\n`,
  );

  const ev = eventWithProj(tmpHome, "soft", "sess-soft");
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
  expect(log).toContain('"skipped":"soft_budget_on_demand"');
  expect(log).toContain('"degraded":"on_demand_soft"');
});

test("wake bypass overrides quiet + budget gates", async () => {
  const homeBase = join(tmpHome, ".siltpoke");
  const fs = await import("node:fs");
  fs.mkdirSync(homeBase, { recursive: true });
  fs.writeFileSync(
    join(homeBase, "config.json"),
    JSON.stringify({
      quietHours: { start: "00:00", end: "23:59", timezone: "local" },
      budget: { dailyTokenLimit: 1 }, // also blocks
    }),
  );
  // Write a fresh wake.json
  fs.writeFileSync(
    join(homeBase, "wake.json"),
    JSON.stringify({
      schemaVersion: 1,
      expires_at_ms: Date.now() + 60_000,
    }),
  );

  const ev = eventWithProj(tmpHome, "wake", "sess-wake");
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
  expect(existsSync(join(homeBase, "wake.json"))).toBe(false);
});

test("on_demand trigger mode without bypass: skips", async () => {
  const homeBase = join(tmpHome, ".siltpoke");
  const fs = await import("node:fs");
  fs.mkdirSync(homeBase, { recursive: true });
  fs.writeFileSync(
    join(homeBase, "config.json"),
    JSON.stringify({ triggerMode: "on_demand" }),
  );

  const ev = eventWithProj(tmpHome, "od", "sess-od");
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
  expect(log).toContain('"skipped":"on_demand_no_bypass"');
});
