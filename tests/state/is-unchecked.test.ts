// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
// Copyright (c) 2026 Jiaqi Duan
/**
 * The predicate that keeps a second "nothing was examined" label from being
 * read as a checked review.
 *
 * Why it exists rather than `=== "not_checked"` at each site: both labels are
 * members of one union, so every hard-coded comparison keeps COMPILING when a
 * second one is added and simply stops being true. TypeScript cannot flag it —
 * there is no narrowing to break, no missing case in a switch. The failure is
 * silent by construction, which is the same shape the label itself was written
 * to fix one layer up.
 *
 * Enumerated, not sampled: a third unchecked label added without updating this
 * list is the exact regression these tests are for, and a sampled test would
 * pass through it.
 */
import { test, expect, describe } from "bun:test";
import { isUnchecked } from "../../src/state/critique";
import type { EvidenceLabel } from "../../src/critic/evidence-guard";

/** Every label that means "nothing was examined". */
const UNCHECKED: EvidenceLabel[] = ["not_checked", "not_checked_budget"];

/** Every label that means the guard DID run and reached a result. */
const EXAMINED: EvidenceLabel[] = ["verified", "partly_unverified", "none_verified", "no_evidence"];

describe("isUnchecked", () => {
  test("true for every unchecked label", () => {
    for (const l of UNCHECKED) expect(isUnchecked(l)).toBe(true);
  });

  test("false for every label the guard actually produced a result for", () => {
    // `no_evidence` belongs here on purpose: the guard ran and found the review
    // cited nothing. That is a finding about the reviewer, not an absence of
    // checking, and conflating the two would excuse a review that pointed at
    // no code at all.
    for (const l of EXAMINED) expect(isUnchecked(l)).toBe(false);
  });

  test("false for an absent label", () => {
    // A row with no recorded answer is not a claim that nothing was checked.
    expect(isUnchecked(null)).toBe(false);
  });

  test("the two lists together cover the whole union", () => {
    // The anti-drift assertion. If a label is added to EvidenceLabel and to
    // neither list, this fails — which is the reminder to decide which side it
    // belongs on rather than letting it default to "examined" everywhere.
    const all: EvidenceLabel[] = [...UNCHECKED, ...EXAMINED];
    const seen = new Set(all);
    expect(seen.size).toBe(all.length); // no duplicates between the lists
    // A compile-time exhaustiveness check: if EvidenceLabel gains a member,
    // this object literal stops type-checking until it is listed.
    const exhaustive: Record<EvidenceLabel, true> = {
      not_checked: true,
      not_checked_budget: true,
      verified: true,
      partly_unverified: true,
      none_verified: true,
      no_evidence: true,
    };
    expect(Object.keys(exhaustive).sort()).toEqual([...all].sort());
  });
});
