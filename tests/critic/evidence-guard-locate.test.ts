// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
// Copyright (c) 2026 Jiaqi Duan
/**
 * The quote locator: which side of the diff a finding's quote came from, and
 * what line of the file it sits on.
 *
 * Every assertion here is written so that deleting the rule it covers turns it
 * red. Three are load-bearing enough to say which mutation was actually run:
 *
 *   - the removed-side rule (swap `after` for `before` in `locateQuote`)
 *   - the same-file rule (drop `h.file === finding.file`)
 *   - the hint strip (return the finding unchanged from `withFindingIds`)
 *
 * The removed-side and weak-tier tests PIN THE TIER FIRST. A fixture whose
 * quote happens to appear on both sides would pass either way, and the test
 * would print green having proved nothing.
 */
import { describe, expect, test } from "bun:test";
import { guardCritique } from "../../src/critic/evidence-guard";
import { parseBrainOutput } from "../../src/brain/schema";

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

/** One file block as git writes it. */
const block = (oldPath: string, newPath: string, ...body: string[]) =>
  [
    `diff --git a/${oldPath === "/dev/null" ? newPath : oldPath} b/${newPath === "/dev/null" ? oldPath : newPath}`,
    oldPath === "/dev/null" ? "--- /dev/null" : `--- a/${oldPath}`,
    newPath === "/dev/null" ? "+++ /dev/null" : `+++ b/${newPath}`,
    ...body,
  ].join("\n");

const MODIFIED = block(
  "src/pay.ts",
  "src/pay.ts",
  "@@ -10,2 +10,3 @@",
  " const rate = 0.05;",
  "+const total = subtotal * rate;",
  " return total;",
);

const guard = (corpus: string, findings: unknown[], anchored = true) =>
  guardCritique(
    parseBrainOutput({ ...base, evidence: [], findings }),
    "NORMAL",
    corpus,
    new Set(["src/pay.ts", "src/gone.ts", "src/other.ts"]),
    new Set(),
    anchored,
  );

describe("the tier says which side of the change the quote came from", () => {
  test("a quote of an ADDED line is strong, and carries the line it is on", () => {
    const v = guard(MODIFIED, [finding()]);
    expect(v.verifiedFindings).toHaveLength(1);
    const f = v.verifiedFindings[0]!;
    expect(f.quote_tier).toBe("strong");
    expect(f.range_source).toBe("hunk");
    // Hunk starts at 10: line 10 is the context line, 11 is the added one.
    expect(f.start_line).toBe(11);
    expect(f.end_line).toBe(11);
  });

  test("a multi-line quote ends where it ends, not where the hunk does", () => {
    const v = guard(MODIFIED, [
      finding({ quote: "const total = subtotal * rate;\nreturn total;" }),
    ]);
    const f = v.verifiedFindings[0]!;
    expect(f.start_line).toBe(11);
    expect(f.end_line).toBe(12);
  });

  /**
   * MUTATION RUN: swapping `after` for `before` in `locateQuote` makes this
   * finding `strong`, and the first assertion goes red. The tier is pinned
   * BEFORE anything else is checked, because a fixture whose quote also sat on
   * the added side would pass under the mutation and prove nothing.
   */
  test("a quote that exists ONLY on the removed side is not strong", () => {
    const corpus = block(
      "src/pay.ts",
      "src/pay.ts",
      "@@ -10,2 +10,1 @@",
      "-const total = subtotal * rate;",
      " return total;",
    );
    const v = guard(corpus, [finding()]);
    expect(v.verifiedFindings).toHaveLength(1);
    const f = v.verifiedFindings[0]!;
    expect(f.quote_tier).toBe("weak");
    expect(f.range_source).toBe("not_located");
    expect(f.start_line).toBeUndefined();
  });

  /**
   * MUTATION RUN: dropping `h.file === finding.file` from the filter makes this
   * `strong` with a line number belonging to a different file. This is the one
   * rule in the slice that goes beyond the locked wording of Q4, so it carries
   * its own evidence rather than inheriting any.
   */
  test("a quote found in ANOTHER file's hunk is not strong for this file", () => {
    const corpus = block(
      "src/other.ts",
      "src/other.ts",
      "@@ -50,1 +50,2 @@",
      " unrelated();",
      "+const total = subtotal * rate;",
    );
    const v = guard(corpus, [finding()]);
    const f = v.verifiedFindings[0]!;
    expect(f.quote_tier).toBe("weak");
    expect(f.start_line).toBeUndefined();
  });

  test("a quote of a DELETED file's content is not strong", () => {
    const corpus = block(
      "src/gone.ts",
      "/dev/null",
      "@@ -1,2 +0,0 @@",
      "-const total = subtotal * rate;",
      "-return total;",
    );
    const v = guard(corpus, [finding({ file: "src/gone.ts" })]);
    const f = v.verifiedFindings[0]!;
    expect(f.quote_tier).toBe("weak");
  });
});

describe("a line number is written only when it means something", () => {
  test("unanchored: the tier survives, the line number does not", () => {
    const v = guard(MODIFIED, [finding()], false);
    const f = v.verifiedFindings[0]!;
    expect(f.quote_tier).toBe("strong");
    expect(f.range_source).toBe("unanchored");
    expect(f.start_line).toBeUndefined();
    expect(f.end_line).toBeUndefined();
  });

  /**
   * The recent-commits shape: the same file in two blocks, newest first. A
   * quote that matches only the OLDER block is real code from a real change,
   * but its line numbers describe the file two commits ago.
   */
  test("a match in an older block of the same file gets no line number", () => {
    const corpus = [
      block("src/pay.ts", "src/pay.ts", "@@ -80,1 +80,2 @@", " newest();", "+added recently;"),
      block("src/pay.ts", "src/pay.ts", "@@ -10,1 +10,2 @@", " older();", "+const total = subtotal * rate;"),
    ].join("\n");
    const v = guard(corpus, [finding()]);
    const f = v.verifiedFindings[0]!;
    expect(f.quote_tier).toBe("strong");
    expect(f.range_source).toBe("stale_block");
    expect(f.start_line).toBeUndefined();
  });

  /**
   * The inverse, and the reason the rename test is not a bare `file !== oldFile`:
   * an ADDED file also has no old path, and added files are the dominant shape
   * in a diff. Testing the two the same way would suppress line numbers on the
   * most anchorable case there is.
   */
  test("an ADDED file is anchorable, not stale", () => {
    const corpus = block(
      "/dev/null",
      "src/pay.ts",
      "@@ -0,0 +1,2 @@",
      "+const rate = 0.05;",
      "+const total = subtotal * rate;",
    );
    const v = guard(corpus, [finding()]);
    const f = v.verifiedFindings[0]!;
    expect(f.range_source).toBe("hunk");
    expect(f.start_line).toBe(2);
  });

  test("a file whose newest block DELETES it gets no line number from an older one", () => {
    const corpus = [
      block("src/pay.ts", "/dev/null", "@@ -1,1 +0,0 @@", "-gone();"),
      block("src/pay.ts", "src/pay.ts", "@@ -10,1 +10,2 @@", " older();", "+const total = subtotal * rate;"),
    ].join("\n");
    const v = guard(corpus, [finding()]);
    expect(v.verifiedFindings[0]!.range_source).toBe("stale_block");
  });
});

describe("the model's own line numbers never leave the guard", () => {
  /**
   * MUTATION RUN: returning the finding unchanged from `withFindingIds` leaves
   * both keys on the object, and both assertions go red. Asserted on
   * `Object.keys` rather than on a rendered string, because the write path
   * serialises the whole object and a renderer that happens not to show a key
   * proves nothing about what is on disk.
   */
  test("a claimed range is dropped, however confidently it was given", () => {
    const v = guard(MODIFIED, [finding({ claimed_start_line: 999, claimed_end_line: 1000 })]);
    const keys = Object.keys(v.verifiedFindings[0]!);
    expect(keys).not.toContain("claimed_start_line");
    expect(keys).not.toContain("claimed_end_line");
    // And the code's own answer is the one that survived.
    expect(v.verifiedFindings[0]!.start_line).toBe(11);
  });

  /**
   * The unchecked branch is a separate `return`, so it needs its own assertion:
   * `evidence-reaches-disk` only exercises NORMAL and would not see a leak here.
   */
  test("the unchecked branch strips them too, and claims no tier", () => {
    const out = parseBrainOutput({
      ...base,
      evidence: [],
      findings: [finding({ claimed_start_line: 999 })],
    });
    const v = guardCritique(out, "PASSIVE_BUBBLE", MODIFIED, new Set(["src/pay.ts"]));
    const f = v.verifiedFindings[0]!;
    expect(Object.keys(f)).not.toContain("claimed_start_line");
    expect(f.range_source).toBe("unchecked");
    // Absent, not "weak": nothing looked at this finding.
    expect(f.quote_tier).toBeUndefined();
  });
});

/**
 * The first measurement in this project of whether the reviewer's own line
 * numbers are any good. The buckets have to be exhaustive or the baseline is a
 * fraction of an unknown denominator.
 */
describe("the four agreement buckets are exclusive and account for everything", () => {
  test("a matching guess counts as agreement and nothing else", () => {
    const v = guard(MODIFIED, [finding({ claimed_start_line: 11 })]);
    expect(v.rangeAgreement).toEqual({ code_silent: 0, model_silent: 0, agree: 1, disagree: 0 });
  });

  test("a wrong guess counts as disagreement", () => {
    const v = guard(MODIFIED, [finding({ claimed_start_line: 99 })]);
    expect(v.rangeAgreement).toEqual({ code_silent: 0, model_silent: 0, agree: 0, disagree: 1 });
  });

  test("no guess, while the code had an answer, is the model's silence", () => {
    const v = guard(MODIFIED, [finding()]);
    expect(v.rangeAgreement).toEqual({ code_silent: 0, model_silent: 1, agree: 0, disagree: 0 });
  });

  /**
   * The code's silence wins over the model's, however confident the model was.
   * Counting this as `disagree` would blame the model for a range nothing
   * derived, which is the number this bucket exists to keep clean.
   */
  test("the code having no answer wins, however confident the guess", () => {
    const v = guard(MODIFIED, [finding({ claimed_start_line: 11 })], false);
    expect(v.rangeAgreement).toEqual({ code_silent: 1, model_silent: 0, agree: 0, disagree: 0 });
  });

  test("the buckets sum to the findings that survived, not to the findings sent", () => {
    const v = guard(MODIFIED, [
      finding({ claimed_start_line: 11 }),
      finding({ claimed_start_line: 99 }),
      finding(),
      // Refused: a quote that is in no corpus at all never reaches the tally.
      finding({ quote: "const nothing = fabricated(); // not in the corpus anywhere" }),
    ]);
    const a = v.rangeAgreement;
    const total = a.agree + a.disagree + a.model_silent + a.code_silent;
    expect(v.verifiedFindings).toHaveLength(3);
    expect(v.unverifiedFindings).toHaveLength(1);
    expect(total).toBe(3);
  });
});

/**
 * AC5 — a weak finding is still a finding.
 *
 * The 2026-08-19 header comment in `evidence-guard.ts` records a review this
 * project threw away that "cited a comment that really does exist in the file —
 * it just was not inside the 20 diff hunks the reviewer happened to be handed."
 * That review was TRUE, and under the tier rule it is exactly a weak one.
 * Introducing a tier without this test is how that silence comes back.
 *
 * MUTATION RUN: inserting `if (location.quote_tier !== "strong") return;`
 * immediately before `located.push(...)` in `guardCritique` reds every test
 * below. Filtering by tier is the natural thing to reach for once findings
 * carry one, which is why the guard is pinned against it rather than trusted.
 *
 * Each test PINS THE TIER FIRST. A fixture whose quote also sat on an added
 * line would be strong, survive any tier filter, and print green having proved
 * nothing.
 */
describe("a weak finding is not silently dropped", () => {
  /** Quoted code that is real, in the corpus, and in no hunk of this diff. */
  const SURROUNDING = [
    MODIFIED,
    "--- corpus separator ---",
    "### ripgrep",
    "src/pay.ts:200: const legacyRate = 0.07; // superseded, kept for the audit trail",
  ].join("\n");

  const WEAK_QUOTE = "const legacyRate = 0.07; // superseded, kept for the audit trail";

  test("it survives the guard, and is labelled weak rather than refused", () => {
    const v = guard(SURROUNDING, [finding({ quote: WEAK_QUOTE })]);
    expect(v.verifiedFindings[0]!.quote_tier).toBe("weak");
    expect(v.verifiedFindings).toHaveLength(1);
    expect(v.unverifiedFindings).toHaveLength(0);
  });

  test("a weak one beside a strong one: both come back, in order", () => {
    const v = guard(SURROUNDING, [finding({ quote: WEAK_QUOTE }), finding()]);
    expect(v.verifiedFindings.map((f) => f.quote_tier)).toEqual(["weak", "strong"]);
    expect(v.verifiedFindings.map((f) => f.id)).toEqual(["f1", "f2"]);
  });

  /**
   * The first draft of this test also asserted `label !== "none_verified"`,
   * which could not fail: every fixture here passes `evidence: []`, so the
   * label is always `"no_evidence"`. Replaced with the thing that can — that
   * nothing was refused, and the finding kept its text.
   */
  test("a review whose findings are ALL weak is still a review", () => {
    const v = guard(SURROUNDING, [finding({ quote: WEAK_QUOTE })]);
    expect(v.verifiedFindings).toHaveLength(1);
    expect(v.unverifiedFindings).toHaveLength(0);
    expect(v.verifiedFindings[0]!.quote).toBe(WEAK_QUOTE);
  });
});

/**
 * A file the newest commit moved off. The scan over hunks cannot see a pure
 * rename — it produces none — so a name whose newest fate is "renamed away"
 * would otherwise take its line number from an OLDER block, pointing into a
 * path the reader cannot open.
 */
describe("a path this diff moved off gets no line number", () => {
  test("a pure rename in the newest block makes the older block stale", () => {
    const corpus = [
      "diff --git a/src/pay.ts b/src/payment.ts",
      "similarity index 100%",
      "rename from src/pay.ts",
      "rename to src/payment.ts",
      block("src/pay.ts", "src/pay.ts", "@@ -10,1 +10,2 @@", " older();", "+const total = subtotal * rate;"),
    ].join("\n");
    const v = guard(corpus, [finding()]);
    const f = v.verifiedFindings[0]!;
    expect(f.quote_tier).toBe("strong");
    expect(f.range_source).toBe("stale_block");
    expect(f.start_line).toBeUndefined();
  });

  test("an ordinary modification is unaffected by the rule", () => {
    const v = guard(MODIFIED, [finding()]);
    expect(v.verifiedFindings[0]!.range_source).toBe("hunk");
  });
});
