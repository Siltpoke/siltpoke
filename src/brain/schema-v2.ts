// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
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

/**
 * DELIBERATELY UNCOERCED, unlike `parseBrainOutput` in `schema.ts` — and this is a
 * decision, not an oversight, so it is written down where the next person will hit it.
 *
 * v1 gained `coerceBrainOutputLengths` on 2026-08-31 because a hard cap was discarding
 * whole reviews: seven planted defects failed 3/3 on `evidence: too_big`, twice, four
 * weeks apart, and the findings that were lost lived in a field that never overflowed.
 * This schema declares the same class of caps — `evidence.max(8)`, `web_sources.max(5)`,
 * `reasoning.max(800)`, `bubble_short.max(200)`, `bubble_long.max(2000)`,
 * `suggested_fix.max(200)`, `snippet.max(240)`.
 *
 * It is not coerced because its only non-test caller is `auditSchemaValidity`
 * (`src/eval/critic-output/audit.ts:31`), a K1 hard gate whose entire job is to catch
 * records that do not satisfy the schema. THERE, REJECTION IS THE SIGNAL — coercing
 * would make that gate report clean on exactly the records it exists to find.
 *
 * ⚠️ THE MOMENT THIS PARSES LIVE MODEL OUTPUT, IT NEEDS COERCION. `callBrainFind`
 * (`src/critic/pipeline/runner.ts`) is already typed to return `BrainOutputV2` and has no
 * implementation yet; wiring it without coercion reproduces the v1 bug exactly. Note the
 * trap in the cap values: v2's evidence ceiling is 8 against v1's 5, so it bites LESS
 * often — which makes it likelier to pass testing and fail on a thorough review in
 * production, not safer. The fix is a caps table shared with `schema.ts`, applied on the
 * live path only, leaving the audit gate parsing raw.
 *
 * SINCE 2026-09-01 THAT IS TWO PASSES, NOT ONE. `schema.ts` also repairs SHAPE
 * (`coerceBrainOutputShape`): a malformed evidence item is dropped rather than
 * rejecting the answer, and a cosmetic field out of range falls back. v2's
 * `evidenceItemV2Schema` is STRICTER than v1's — `line` is required here and
 * optional there — so the same class of reply fails it more often, not less.
 * Whatever wires the live path owes both passes, and the audit gate still owes
 * neither.
 */
export function parseBrainOutputV2(raw: unknown): BrainOutputV2 {
  return brainOutputV2Schema.parse(raw);
}
