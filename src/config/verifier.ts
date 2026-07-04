// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
// Copyright (c) 2026 Jiaqi Duan
import { z } from "zod";
import type { VerifierMode } from "../critic/pipeline/verify";

export const verifierConfigSchema = z.object({
  verifier: z.enum(["off", "conditional", "always"]).default("conditional"),
});

export type VerifierConfig = z.infer<typeof verifierConfigSchema>;

export const VERIFIER_DEFAULT: VerifierMode = "conditional";

/**
 * Parse an unknown config blob and return the verifier mode.
 * Falls back to "conditional" if the field is missing or invalid.
 */
export function parseVerifierMode(raw: unknown): VerifierMode {
  const result = verifierConfigSchema.safeParse(raw);
  if (result.success) return result.data.verifier;
  return VERIFIER_DEFAULT;
}
