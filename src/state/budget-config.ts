// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
// Copyright (c) 2026 Jiaqi Duan
import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { DailyRollup } from "./usage";

export type SoftModeOverride = "on_demand" | "off";

export interface BudgetConfig {
  dailyTokenLimit: number;
  perCallMaxInputTokens: number;
  softWarnAtPercent: number;
  hardStopAtPercent: number;
  softModeOverride: SoftModeOverride;
  resetAtMinutes: number;
}

export const DEFAULT_BUDGET_CONFIG: BudgetConfig = {
  dailyTokenLimit: 500_000,
  perCallMaxInputTokens: 4_000,
  softWarnAtPercent: 80,
  hardStopAtPercent: 100,
  softModeOverride: "on_demand",
  resetAtMinutes: 0,
};

function clampPercent(v: unknown, fallback: number): number {
  if (typeof v !== "number" || !Number.isFinite(v) || v < 0 || v > 200) {
    return fallback;
  }
  return v;
}

function nonNegativeInt(v: unknown, fallback: number): number {
  if (typeof v !== "number" || !Number.isFinite(v) || v < 0) {
    return fallback;
  }
  return Math.floor(v);
}

function parseResetAt(value: unknown, fallback: number): number {
  if (typeof value !== "string") return fallback;
  const match = value.match(/^(\d{1,2}):(\d{2})$/);
  if (!match) return fallback;
  const h = parseInt(match[1]!, 10);
  const m = parseInt(match[2]!, 10);
  if (h < 0 || h > 23 || m < 0 || m > 59) return fallback;
  return h * 60 + m;
}

export async function loadBudgetConfig(basePath: string): Promise<BudgetConfig> {
  const configPath = join(basePath, "config.json");
  if (!existsSync(configPath)) return DEFAULT_BUDGET_CONFIG;
  try {
    const raw = await readFile(configPath, "utf8");
    const parsed = JSON.parse(raw) as { budget?: Record<string, unknown> };
    const b = parsed?.budget ?? {};
    const softOverride =
      b.softModeOverride === "on_demand" || b.softModeOverride === "off"
        ? b.softModeOverride
        : DEFAULT_BUDGET_CONFIG.softModeOverride;
    return {
      dailyTokenLimit: nonNegativeInt(
        b.dailyTokenLimit,
        DEFAULT_BUDGET_CONFIG.dailyTokenLimit,
      ),
      perCallMaxInputTokens: nonNegativeInt(
        b.perCallMaxInputTokens,
        DEFAULT_BUDGET_CONFIG.perCallMaxInputTokens,
      ),
      softWarnAtPercent: clampPercent(
        b.softWarnAtPercent,
        DEFAULT_BUDGET_CONFIG.softWarnAtPercent,
      ),
      hardStopAtPercent: clampPercent(
        b.hardStopAtPercent,
        DEFAULT_BUDGET_CONFIG.hardStopAtPercent,
      ),
      softModeOverride: softOverride,
      resetAtMinutes: parseResetAt(b.resetAt, DEFAULT_BUDGET_CONFIG.resetAtMinutes),
    };
  } catch {
    return DEFAULT_BUDGET_CONFIG;
  }
}

export type BudgetStage = "ok" | "soft" | "hard";

export interface BudgetDecision {
  stage: BudgetStage;
  used_pct: number;
  remaining_tokens: number;
}

export function evaluateBudget(
  rollup: DailyRollup,
  config: BudgetConfig,
): BudgetDecision {
  if (config.dailyTokenLimit === 0) {
    return { stage: "ok", used_pct: 0, remaining_tokens: 0 };
  }
  // Discount cache_read tokens to 10% weight. Cache reads cost
  // ~0.1× a fresh input token on Anthropic's API, so counting them at
  // full weight (the old conservative default) burned the daily budget
  // ~10× faster than real cost and silenced the critic via
  // soft_budget_on_demand within an hour or two of normal use.
  const CACHE_WEIGHT = 0.1;
  const used =
    rollup.total_input_tokens +
    rollup.total_output_tokens +
    Math.round(rollup.total_cache_tokens * CACHE_WEIGHT);
  const pct = (used / config.dailyTokenLimit) * 100;
  const remaining = Math.max(0, config.dailyTokenLimit - used);
  let stage: BudgetStage = "ok";
  if (pct >= config.hardStopAtPercent) stage = "hard";
  else if (pct >= config.softWarnAtPercent) stage = "soft";
  return {
    stage,
    used_pct: Math.round(pct * 100) / 100,
    remaining_tokens: remaining,
  };
}
