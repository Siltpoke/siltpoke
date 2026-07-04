// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
// Copyright (c) 2026 Jiaqi Duan
/**
 * Bug#4-C: rubric-noise detection for the consolidation signal.
 *
 * When the Brain emits no critique prose, the critic synthesizes a fallback
 * body from deterministic rubric triggers (god-file/god-function flags) and/or
 * the Haiku diff-summary pre-pass (see critic/phases/severity-promotion.ts).
 * These are machine-derived flags, NOT episodic signal about the user — feeding
 * them to the memory summarizer makes it manufacture junk facts out of noise.
 * Both fallback branches start with a fixed marker line; detect and exclude.
 */

const RUBRIC_NOISE_PREFIXES = [
  "Rubric flagged concerns the model didn't surface:",
  "Diff-summary risks (Haiku pre-pass):",
] as const;

export function isRubricNoiseCritique(body: string): boolean {
  const trimmed = body.trimStart();
  return RUBRIC_NOISE_PREFIXES.some((p) => trimmed.startsWith(p));
}
