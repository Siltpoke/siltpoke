// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
// Copyright (c) 2026 Jiaqi Duan
import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { DEFAULT_MAX_TRANSCRIPT_TURNS } from "../router/context";
import { DEFAULT_MAX_RULES } from "./rule-selector";
import { DEFAULT_RECENT_INJECTION_COUNT } from "./prompt-assembly";

export interface CostConfig {
  maxTranscriptTurns: number;
  maxRules: number;
  recentInjectionCount: number;
}

export const DEFAULT_COST_CONFIG: CostConfig = {
  maxTranscriptTurns: DEFAULT_MAX_TRANSCRIPT_TURNS,
  maxRules: DEFAULT_MAX_RULES,
  recentInjectionCount: DEFAULT_RECENT_INJECTION_COUNT,
};

function positiveInt(value: unknown, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 1) {
    return fallback;
  }
  return Math.floor(value);
}

export async function loadCostConfig(basePath: string): Promise<CostConfig> {
  const configPath = join(basePath, "config.json");
  if (!existsSync(configPath)) return DEFAULT_COST_CONFIG;
  try {
    const raw = await readFile(configPath, "utf8");
    const parsed = JSON.parse(raw) as {
      context?: { maxTranscriptTurns?: unknown };
      memory?: {
        maxRules?: unknown;
        recentFeedbackInjectionCount?: unknown;
      };
    };
    return {
      maxTranscriptTurns: positiveInt(
        parsed?.context?.maxTranscriptTurns,
        DEFAULT_COST_CONFIG.maxTranscriptTurns,
      ),
      maxRules: positiveInt(
        parsed?.memory?.maxRules,
        DEFAULT_COST_CONFIG.maxRules,
      ),
      recentInjectionCount: positiveInt(
        parsed?.memory?.recentFeedbackInjectionCount,
        DEFAULT_COST_CONFIG.recentInjectionCount,
      ),
    };
  } catch {
    return DEFAULT_COST_CONFIG;
  }
}
