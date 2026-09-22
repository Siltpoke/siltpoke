// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
// Copyright (c) 2026 Jiaqi Duan
/**
 * Every registered rubric rule must have had its snippet provenance DECIDED.
 *
 * `snippet_is_source` is optional and absent-means-refused, which is the safe
 * direction — but it makes "nobody looked at this rule" and "we decided this rule's
 * snippet is not source" indistinguishable in the code. #732 marked ten rules and
 * missed two, because those two live in `src/repo-memory/` rather than
 * `src/critic/rubric/tier1` and `tier2`, and every review of that change — mine, a same-family
 * reviewer's, and a cross-family reviewer's — looked only where the rules obviously
 * live. The replay harness found them, by rule id, in the recorded traces.
 *
 * So the completeness check reads the REGISTRY, not a directory: a rule added anywhere
 * fails here until someone states which side it is on and why. That is the only
 * property a directory-shaped scan cannot give.
 */
import { describe, expect, test } from "bun:test";
import { ALL_RUBRIC_RULES } from "../../../src/critic/rubric/rules";

/**
 * The decision, one line per rule, with the reason in the value. `true` = the rule's
 * snippet is bytes read out of the file it names; `false` = the rule composes it.
 *
 * Adding a rule to `ALL_RUBRIC_RULES` without adding it here fails the test below —
 * which is the entire point. Do not "fix" such a failure by deleting the assertion.
 */
const SNIPPET_IS_SOURCE: Record<string, { source: boolean; why: string }> = {
  "god-file": { source: true, why: "src.slice(0, 200) — real bytes (multi-line, so refused on shape)" },
  "test-gap": { source: false, why: "composes `+N lines added to <file>` — an accounting sentence" },
  "god-function": { source: true, why: "the declaration line at startLine" },
  "deep-nesting": { source: true, why: "sourceLines[line]" },
  "long-param-list": { source: true, why: "lines[startLine]" },
  "defensive-overreach": { source: true, why: "lines[line]" },
  "sprawling-abstraction": { source: true, why: "decl.snippetLine" },
  "narrating-comment": { source: true, why: "sourceLines[line]" },
  "magic-number": { source: true, why: "sourceLines[line]" },
  "boolean-param": { source: true, why: "sourceLines[line]" },
  "commented-out-code": { source: true, why: "lines[startLine]" },
  "repo-memory-inconsistency": { source: true, why: "source.slice(0, 200) — real bytes (multi-line, so refused on shape)" },
  "repo-memory-convention": { source: false, why: "the FILE NAME, not a line from inside the file" },
};

describe("rubric snippet provenance is decided for every registered rule", () => {
  test("every rule in ALL_RUBRIC_RULES has a stated decision", () => {
    const registered = ALL_RUBRIC_RULES.map((r) => r.id).sort();
    const decided = Object.keys(SNIPPET_IS_SOURCE).sort();
    // Both directions: an undecided rule AND a decision for a rule that no longer
    // exists are each a drift worth failing on.
    expect(registered.filter((id) => !(id in SNIPPET_IS_SOURCE))).toEqual([]);
    expect(decided.filter((id) => !registered.includes(id))).toEqual([]);
  });

  test("every stated reason is non-empty — a decision without one is not a decision", () => {
    for (const [id, d] of Object.entries(SNIPPET_IS_SOURCE)) {
      expect(d.why.length, `${id} has no stated reason`).toBeGreaterThan(10);
    }
  });

  test("the registry is not empty and the two halves are both populated", () => {
    // Guards against the shape where an empty or all-one-way table passes the
    // completeness check while asserting nothing — see the empty-set trap.
    const vals = Object.values(SNIPPET_IS_SOURCE);
    expect(ALL_RUBRIC_RULES.length).toBeGreaterThan(0);
    expect(vals.filter((v) => v.source).length).toBeGreaterThan(0);
    expect(vals.filter((v) => !v.source).length).toBeGreaterThan(0);
  });
});
