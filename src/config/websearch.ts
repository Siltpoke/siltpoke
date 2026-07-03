// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Copyright (c) 2026 Jiaqi Duan
import { z } from "zod";

export const webSearchConfigSchema = z.object({
  mode: z.enum(["off", "gated", "always"]).default("gated"),
  dailyCap: z.number().int().positive().default(20),
});

export type WebSearchConfig = z.infer<typeof webSearchConfigSchema>;

const EXTERNAL_REF_PATTERN = /\b(api|library|package|npm|sdk|webhook|http|endpoint|oauth)\b/i;

export interface GateInput {
  config: WebSearchConfig;
  promptOrCritique: string;
  confidence: "low" | "med" | "high";
  dailyUsageCount: number;
}

/**
 * Determines whether a web search should be invoked given the gate conditions.
 *
 * - mode "off": never invoke
 * - mode "always": invoke if under daily cap
 * - mode "gated": invoke only when under cap, confidence < high, and
 *   the text references an external API/library keyword
 */
export function shouldInvokeWebSearch(input: GateInput): boolean {
  if (input.config.mode === "off") return false;
  if (input.config.mode === "always") return input.dailyUsageCount < input.config.dailyCap;
  // gated
  if (input.dailyUsageCount >= input.config.dailyCap) return false;
  if (input.confidence === "high") return false;
  return EXTERNAL_REF_PATTERN.test(input.promptOrCritique);
}
