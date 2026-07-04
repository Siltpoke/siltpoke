// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
// Copyright (c) 2026 Jiaqi Duan
import { z } from "zod";

// Evidence item schema.
export const evidenceItemSchema = z.object({
  tool: z.enum(["tsc", "eslint", "git-diff", "ripgrep"]),
  file: z.string().min(1),
  line: z.number().int().positive().optional(),
  snippet: z.string().min(10).max(240),
});

export type EvidenceItem = z.infer<typeof evidenceItemSchema>;

export const moodEnum = z.enum([
  "happy",
  "annoyed",
  "concerned",
  "watching",
  "sleeping_quiet",
  "sleeping_broke",
  "idle",
  "excited",
  "tired",
]);

export const poseEnum = z.enum([
  "base",
  "peek",
  "blink",
  "arms_crossed",
  "shrug",
  "wave",
  "stretch",
  "zen",
]);

export const severityEnum = z.enum(["info", "low", "medium", "high"]);
export const confidenceEnum = z.enum(["low", "medium", "high"]);

export const brainOutputSchema = z.object({
  mood: moodEnum,
  pose: poseEnum,
  bubble_short: z.string().min(1).max(200),
  bubble_long: z.string().max(2000),
  critique_for_claude: z.string(),
  severity: severityEnum,
  confidence: confidenceEnum,
  xp_earned_events: z.array(
    z.object({
      type: z.string(),
      amount: z.number().int().nonnegative(),
    }),
  ),
  // Evidence array — additive, defaults to [] so existing critique files
  // without this field still parse correctly.
  // Zod 4 chain semantics: .max(5) constrains explicit input arrays; .default([])
  // fires only when the field is absent — orders are independent, both apply.
  evidence: z.array(evidenceItemSchema).max(5).default([]),
  // Brain explains WHY it chose this severity + whether it wrote a
  // critique. Surfaced on the /history expand panel so the user can see the
  // model's decision trace, not just the final bubble. Optional + bounded
  // so older entries (and test fixtures) without this field still parse.
  reasoning: z.string().max(800).optional(),
});

export type BrainOutput = z.infer<typeof brainOutputSchema>;

export function parseBrainOutput(raw: unknown): BrainOutput {
  return brainOutputSchema.parse(raw);
}
