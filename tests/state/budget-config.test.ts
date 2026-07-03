import { test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  loadBudgetConfig,
  evaluateBudget,
  DEFAULT_BUDGET_CONFIG,
} from "../../src/state/budget-config";
import type { DailyRollup } from "../../src/state/usage";

let tmp: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "siltpoke-budget-"));
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

function rollup(used: number): DailyRollup {
  return {
    schemaVersion: 1,
    day: "2026-05-14",
    total_input_tokens: used,
    total_output_tokens: 0,
    total_cache_tokens: 0,
    total_cost_usd: 0,
    brain_calls: 1,
    reflections: 0,
    computed_at_ms: 0,
  };
}

test("loadBudgetConfig: returns defaults when config.json missing", async () => {
  const cfg = await loadBudgetConfig(tmp);
  expect(cfg.dailyTokenLimit).toBe(DEFAULT_BUDGET_CONFIG.dailyTokenLimit);
  expect(cfg.softWarnAtPercent).toBe(80);
  expect(cfg.hardStopAtPercent).toBe(100);
});

test("loadBudgetConfig: parses resetAt HH:MM into minutes", async () => {
  writeFileSync(
    join(tmp, "config.json"),
    JSON.stringify({ budget: { resetAt: "06:30" } }),
  );
  const cfg = await loadBudgetConfig(tmp);
  expect(cfg.resetAtMinutes).toBe(6 * 60 + 30);
});

test("loadBudgetConfig: malformed config falls back to defaults", async () => {
  writeFileSync(join(tmp, "config.json"), "not json");
  const cfg = await loadBudgetConfig(tmp);
  expect(cfg.dailyTokenLimit).toBe(DEFAULT_BUDGET_CONFIG.dailyTokenLimit);
});

test("loadBudgetConfig: negative dailyTokenLimit falls back", async () => {
  writeFileSync(
    join(tmp, "config.json"),
    JSON.stringify({ budget: { dailyTokenLimit: -5 } }),
  );
  const cfg = await loadBudgetConfig(tmp);
  expect(cfg.dailyTokenLimit).toBe(DEFAULT_BUDGET_CONFIG.dailyTokenLimit);
});

test("evaluateBudget: ok stage when well under soft threshold", () => {
  const d = evaluateBudget(rollup(100), {
    ...DEFAULT_BUDGET_CONFIG,
    dailyTokenLimit: 1000,
  });
  expect(d.stage).toBe("ok");
  expect(d.remaining_tokens).toBe(900);
});

test("evaluateBudget: soft stage at exactly 80%", () => {
  const d = evaluateBudget(rollup(800), {
    ...DEFAULT_BUDGET_CONFIG,
    dailyTokenLimit: 1000,
  });
  expect(d.stage).toBe("soft");
});

test("evaluateBudget: hard stage at exactly 100%", () => {
  const d = evaluateBudget(rollup(1000), {
    ...DEFAULT_BUDGET_CONFIG,
    dailyTokenLimit: 1000,
  });
  expect(d.stage).toBe("hard");
});

test("evaluateBudget: hard stage over 100%", () => {
  const d = evaluateBudget(rollup(2000), {
    ...DEFAULT_BUDGET_CONFIG,
    dailyTokenLimit: 1000,
  });
  expect(d.stage).toBe("hard");
  expect(d.remaining_tokens).toBe(0);
});

test("evaluateBudget: dailyTokenLimit=0 disables budget (always ok)", () => {
  const d = evaluateBudget(rollup(999999), {
    ...DEFAULT_BUDGET_CONFIG,
    dailyTokenLimit: 0,
  });
  expect(d.stage).toBe("ok");
});

// cache_read tokens count at 10% weight (Anthropic API discount)
function rollupWithCache(
  input: number,
  output: number,
  cache: number,
): DailyRollup {
  return {
    schemaVersion: 1,
    day: "2026-05-14",
    total_input_tokens: input,
    total_output_tokens: output,
    total_cache_tokens: cache,
    total_cost_usd: 0,
    brain_calls: 1,
    reflections: 0,
    computed_at_ms: 0,
  };
}

test("evaluateBudget: cache tokens count at 10% weight (fix)", () => {
  // 100k cache tokens = 10k effective. 50k input+output + 10k cache = 60k used / 100k limit = 60% → ok stage.
  const d = evaluateBudget(rollupWithCache(40_000, 10_000, 100_000), {
    ...DEFAULT_BUDGET_CONFIG,
    dailyTokenLimit: 100_000,
  });
  expect(d.stage).toBe("ok");
  // 40k + 10k + (100k × 0.1) = 60k → 60.00%
  expect(d.used_pct).toBe(60);
});

test("evaluateBudget: full-weight cache would have hit soft, but discount keeps ok", () => {
  // Pre-fix behavior: 50 input + 50 output + 400k cache = 400.1k → 80.02% → soft
  // Post-fix:        50 + 50 + (400k × 0.1) = 40.1k → 8.02% → ok
  const d = evaluateBudget(rollupWithCache(50, 50, 400_000), {
    ...DEFAULT_BUDGET_CONFIG,
    dailyTokenLimit: 500_000,
  });
  expect(d.stage).toBe("ok");
  expect(d.used_pct).toBeLessThan(10);
});

test("evaluateBudget: enough cache (5M) still pushes to hard", () => {
  // 5M cache × 0.1 = 500k = 100% of 500k limit → hard
  const d = evaluateBudget(rollupWithCache(0, 0, 5_000_000), {
    ...DEFAULT_BUDGET_CONFIG,
    dailyTokenLimit: 500_000,
  });
  expect(d.stage).toBe("hard");
});

test("evaluateBudget: existing pure-input behavior unchanged (cache=0)", () => {
  // Regression-pin: when cache_tokens=0, math is identical to pre-fix.
  const d = evaluateBudget(rollupWithCache(800, 0, 0), {
    ...DEFAULT_BUDGET_CONFIG,
    dailyTokenLimit: 1000,
  });
  expect(d.stage).toBe("soft");
  expect(d.used_pct).toBe(80);
});
