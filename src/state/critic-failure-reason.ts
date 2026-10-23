// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
// Copyright (c) 2026 Jiaqi Duan
/**
 * Which `HARD_SUPPRESS` reasons mean "the review did not run because something
 * broke" (defect `[58]`, audit §61 / §77) as opposed to "the review was
 * deliberately skipped".
 *
 * The writer (`handleHardSuppress`) now stamps `error_message` on a failure row
 * from `RunCriticResult.brainFailed`. This module exists for the rows already
 * on disk, which carry only `m112_reason`: the two prefixes below are the ones
 * `runCritic` builds on its `brainFailed` returns (run-critic.ts `runTools
 * threw`, phases/normal.ts + phases/passive-bubble.ts `Brain call failed in …`).
 * Deliberate skips are NOT listed and must stay as they were:
 * "no tools produced usable output — abstaining", "all tools clean, no diff
 * hunks", "defensive suppression — no actionable signal identified".
 */
const FAILURE_REASON_PREFIXES: readonly string[] = [
  "Brain call failed in ",
  "runTools threw unexpectedly",
];

export function failureReasonOf(reason: unknown): string | null {
  if (typeof reason !== "string") return null;
  return FAILURE_REASON_PREFIXES.some((p) => reason.startsWith(p)) ? reason : null;
}
