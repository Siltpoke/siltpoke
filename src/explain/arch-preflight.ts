// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
// Copyright (c) 2026 Jiaqi Duan
/**
 * Arch View pre-flight truncation predicate. Split out of `arch-generate.ts`
 * (2026-09-26) to keep that file under its length pin — this half has no
 * dependency on anything else in that file (it takes the `ArchEstimate` shape
 * it needs structurally, not by importing the type, so there is no cycle back
 * to `arch-generate.ts`). Re-exported from there so existing import sites are
 * unaffected.
 */

/** The model's output cap. `EST_OUTPUT_TOKENS = 31_000` (in `arch-generate.ts`)
 * is the assumed output; the real `claude -p` run is capped at 32K and
 * big-repo runs PEG it (the recalibration comment on EST_OUTPUT_TOKENS records
 * 30,824-32,858 observed output on budget-capped contexts). So
 * EST_OUTPUT_TOKENS sitting hard against this cap IS the "near the ceiling"
 * anchor — no second magic number (Contingency 3): the predicate reuses it
 * rather than inventing a threshold. */
export const ARCH_OUTPUT_CAP_TOKENS = 32_000;

/**
 * Pre-flight truncation predicate — PURE, repo-size-sensitive.
 *
 * Honest-signal grounding: `EST_OUTPUT_TOKENS` is a FLAT constant
 * and cannot tell a large repo from a small one. The only repo-size-sensitive
 * signal the pre-flight produces is on the INPUT side: `arch-context.ts`'s
 * budget-sharder reports `truncatedSubdirCount > 0` exactly when it had to
 * compress/shard subdir content to fit the 200K window. A budget-capped context
 * is *why* the model pegs its output cap (`EST_OUTPUT_TOKENS` lands hard against
 * `ARCH_OUTPUT_CAP_TOKENS`) → truncation risk. So budget pressure ⇒ warn.
 *
 * Conservative by design (spec: accept false negatives over false-positive nag):
 * a repo whose whole context fit comfortably (`truncatedSubdirCount === 0`)
 * never warns — matching the byte-identical no-regress path in `arch-context.ts`.
 *
 * Advisory only — the caller surfaces a heads-up line; it NEVER blocks.
 */
export function archGenerateMayTruncate(est: { truncatedSubdirCount: number }): boolean {
  return est.truncatedSubdirCount > 0;
}
