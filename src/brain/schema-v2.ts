// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Copyright (c) 2026 Jiaqi Duan
import { z } from "zod";
import { moodEnum, poseEnum, severityEnum, confidenceEnum } from "./schema";

export const intentEnum = z.enum(["bugfix", "refactor", "feature", "exploration", "chore"]);
export const categoryEnum = z.enum([
  "correctness", "security", "design", "tests", "readability", "performance", "consistency",
]);
export const signalSourceEnum = z.enum([
  "tsc", "eslint", "git-diff", "ripgrep",
  "rubric-tier1", "rubric-tier2", "brain-semantic", "web-search",
  "secrets-scan", "taint-scan",
]);

export const evidenceItemV2Schema = z.object({
  rule_id: z.string().min(1),
  tier: z.union([z.literal(1), z.literal(2), z.literal(3)]),
  file: z.string().min(1),
  line: z.number().int().positive(),
  snippet: z.string().min(10).max(240),
  signal_source: signalSourceEnum,
});

export const webSourceSchema = z.object({
  url: z.string().url(),
  title: z.string().min(1).max(200),
  snippet: z.string().max(500),
  query: z.string().min(1).max(200),
});

export type WebSource = z.infer<typeof webSourceSchema>;

// Field ORDER matters — Zod preserves declaration order in inferred types.
// Reasoning fields come BEFORE verdict fields (bias mitigation).
export const brainOutputV2Schema = z.object({
  schema_version: z.literal(2),
  intent: z.object({ classification: intentEnum, confidence: z.number().min(0).max(1) }),
  evidence: z.array(evidenceItemV2Schema).max(8),
  web_sources: z.array(webSourceSchema).max(5).default([]),
  reasoning: z.string().min(1).max(800),
  category: categoryEnum,
  severity: severityEnum,
  confidence: confidenceEnum,
  critique_for_claude: z.string(),
  suggested_fix: z.string().max(200).optional(),
  mood: moodEnum,
  pose: poseEnum,
  bubble_short: z.string().min(1).max(200),
  bubble_long: z.string().max(2000),
  xp_earned_events: z.array(z.object({ type: z.string(), amount: z.number().int().nonnegative() })),
});

export type BrainOutputV2 = z.infer<typeof brainOutputV2Schema>;

export function parseBrainOutputV2(raw: unknown): BrainOutputV2 {
  return brainOutputV2Schema.parse(raw);
}
