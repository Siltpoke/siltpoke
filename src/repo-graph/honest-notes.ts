// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Copyright (c) 2026 Jiaqi Duan
/**
 * The single physically-isolated home for the honest-subset disclaimers.
 *
 * This is the ONE file the zero-name grep guard EXCLUDES (by exact path), because
 * these sentences must use words like "API" / "route" precisely to DENY that the
 * structural tool can produce them. Denying a semantic is the opposite of
 * asserting one. Nothing else — no counting logic, no badge label — may live
 * here, and no forbidden word may live anywhere else.
 */
export const HONEST_NOTES = {
  /** Shown with the honest-subset view: the two-layer admission. */
  structural:
    "Counts are literal file/symbol patterns from this repo's own structure. Semantic names come from the generated model — generate the architecture to interpret them.",
  /** Shown where a container has functions but the count cannot mean endpoints. */
  apiRoute:
    "A true API/route count isn't structural — route registration isn't in the index. That needs route extraction (a separate capability).",
} as const;
