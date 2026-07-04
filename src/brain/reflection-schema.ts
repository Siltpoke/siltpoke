// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
// Copyright (c) 2026 Jiaqi Duan
import { z } from "zod";

export const reflectionOutputSchema = z.object({
  reflection: z.string().min(1),
  learned_rule: z.string().min(1),
  rule_category: z
    .string()
    .min(1)
    .regex(/^[a-z0-9][a-z0-9_-]*$/, "rule_category must be kebab/snake case"),
  confidence: z.enum(["high", "medium", "low"]),
  applies_to_file_types: z.array(z.string()).default([]),
});

export type ReflectionOutput = z.infer<typeof reflectionOutputSchema>;

export function parseReflectionOutput(raw: unknown): ReflectionOutput {
  return reflectionOutputSchema.parse(raw);
}
