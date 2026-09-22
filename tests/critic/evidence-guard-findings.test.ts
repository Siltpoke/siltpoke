// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
// Copyright (c) 2026 Jiaqi Duan
/**
 * Until this shipped, `guardCritique` read `out.evidence` and nothing else — so
 * a quote living in the new `findings` array was invisible to every check in
 * that file, and an invented one reached the reader as an ordinary finding.
 *
 * Two of these tests exist to make the guard FIREABLE rather than merely
 * present: "a fabricated quote is refused" goes green if the check is deleted
 * only when the deletion also breaks it, so it asserts the finding is GONE, not
 * that some count changed. And the empty-evidence case is here because the
 * evidence path returns early on an empty array — checking findings after that
 * return would leave exactly the review that carries findings and no evidence
 * unchecked.
 */
import { describe, expect, test } from "bun:test";
import { guardCritique, withFindingIds } from "../../src/critic/evidence-guard";
import { parseBrainOutput } from "../../src/brain/schema";

const CORPUS = [
  "## Tool output",
  "### git diff",
  "diff --git a/src/pay.ts b/src/pay.ts",
  "@@ -10,3 +10,4 @@",
  " const rate = 0.05;",
  "+const total = subtotal * rate;",
  " return total;",
].join("\n");

const CHANGED = new Set(["src/pay.ts"]);

const base = {
  mood: "concerned",
  pose: "base",
  bubble_short: "one thing",
  bubble_long: "",
  critique_for_claude: "prose that stands on its own",
  severity: "medium",
  confidence: "high",
  xp_earned_events: [],
};

const finding = (over: Record<string, unknown> = {}) => ({
  title: "rate applied before tax",
  body: "subtotal is pre-tax here, so the rate lands on the wrong base",
  severity: "medium" as const,
  file: "src/pay.ts",
  quote: "const total = subtotal * rate;",
  ...over,
});

describe("the guard checks findings, not only evidence", () => {
  test("a quote that really is in the corpus survives", () => {
    const out = parseBrainOutput({ ...base, evidence: [], findings: [finding()] });
    const verdict = guardCritique(out, "NORMAL", CORPUS, CHANGED);
    expect(verdict.verifiedFindings).toHaveLength(1);
    expect(verdict.unverifiedFindings).toHaveLength(0);
  });

  test("a fabricated quote is refused, and the finding does not reach the reader", () => {
    const out = parseBrainOutput({
      ...base,
      evidence: [],
      findings: [finding({ quote: "const total = subtotal * TAX_RATE_2026;" })],
    });
    const verdict = guardCritique(out, "NORMAL", CORPUS, CHANGED);
    // The assertion that makes this a real guard: the finding is GONE.
    expect(verdict.verifiedFindings).toHaveLength(0);
    expect(verdict.unverifiedFindings).toHaveLength(1);
    expect(verdict.unverifiedFindings[0]?.reason).toContain("not in evidence_corpus");
  });

  test("a real quote attributed to a file nothing touched is refused too", () => {
    const out = parseBrainOutput({
      ...base,
      evidence: [],
      findings: [finding({ file: "src/never-touched.ts" })],
    });
    const verdict = guardCritique(out, "NORMAL", CORPUS, CHANGED);
    expect(verdict.verifiedFindings).toHaveLength(0);
    expect(verdict.unverifiedFindings[0]?.reason).toContain("not in changed-files or corpus");
  });

  test("one bad finding costs only itself — the good one still arrives", () => {
    const out = parseBrainOutput({
      ...base,
      evidence: [],
      findings: [finding({ quote: "entirely invented line of code here" }), finding()],
    });
    const verdict = guardCritique(out, "NORMAL", CORPUS, CHANGED);
    expect(verdict.verifiedFindings).toHaveLength(1);
    expect(verdict.unverifiedFindings).toHaveLength(1);
  });

  test("refusing every finding never takes the review down with it", () => {
    const out = parseBrainOutput({
      ...base,
      evidence: [],
      findings: [finding({ quote: "invented, every word of it, no match" })],
    });
    const verdict = guardCritique(out, "NORMAL", CORPUS, CHANGED);
    expect(verdict.verifiedFindings).toHaveLength(0);
    // "It labels; it no longer deletes." The prose is the caller's to surface
    // and this verdict says nothing that would stop it.
    expect(out.critique_for_claude).toBe(base.critique_for_claude);
    expect(out.bubble_short).toBe(base.bubble_short);
  });

  test("findings are checked even when evidence is empty — the early return must not skip them", () => {
    // This is the sibling-path hole: `evidence: []` returns `no_evidence`
    // before the item loop, and a findings check written after it would never
    // run for exactly the shape this slice makes common.
    const out = parseBrainOutput({
      ...base,
      evidence: [],
      findings: [finding({ quote: "nothing here matches the corpus at all" })],
    });
    const verdict = guardCritique(out, "NORMAL", CORPUS, CHANGED);
    expect(verdict.label).toBe("no_evidence");
    expect(verdict.unverifiedFindings).toHaveLength(1);
  });

  test("ids are numbered over what survived, not over what the model sent", () => {
    const out = parseBrainOutput({
      ...base,
      evidence: [],
      findings: [finding({ quote: "invented first item, refused" }), finding(), finding()],
    });
    const verdict = guardCritique(out, "NORMAL", CORPUS, CHANGED);
    const ids = withFindingIds(verdict.verifiedFindings).map((f) => f.id);
    // Not f2/f3 — numbering the model's original positions would leave a hole
    // where the refused finding was and point at a slot nobody can see.
    expect(ids).toEqual(["f1", "f2"]);
  });
});
