import { test, expect } from "bun:test";
import { guardCritique, hasUngroundedExternalClaim } from "../../src/critic/evidence-guard";
import type { BrainOutput } from "../../src/brain/schema";
import type { WebSource } from "../../src/brain/schema-v2";

/**
 * These tests were rewritten on 2026-08-19, when the guard stopped deleting.
 *
 * The old suite asserted `accept === false` on every failure path. Every one of
 * those assertions has a successor here, and each successor asserts something
 * strictly stronger: not "the review died", but WHICH item was refused, which
 * survived, and what the review is now labelled. `accept` was one bit; a
 * dropped item, a kept item and a label are three, and only the three can tell
 * "one bad citation out of two" apart from "both bad" — a distinction the old
 * contract could not express and the new UI depends on.
 */

/** Minimal valid BrainOutput — evidence overridden per-test. */
const baseBrainOutput: BrainOutput = {
  mood: "annoyed",
  pose: "arms_crossed",
  bubble_short: "something looks off",
  bubble_long: "details here",
  critique_for_claude: "fix this",
  severity: "medium",
  confidence: "high",
  xp_earned_events: [],
  evidence: [],
};

const evidenceCorpus =
  "src/foo.ts(12,5): error TS2345: Argument of type 'string' is not assignable to parameter of type 'number'.\n" +
  "src/bar.ts(30,3): error TS2304: Cannot find name 'missingVar'.\n" +
  "src/baz.ts: some eslint warning here\n";

const changedFiles = new Set(["src/foo.ts", "src/bar.ts"]);

const snippetInCorpus = "TS2345: Argument of type 'string' is not assignable to parameter of type 'number'.";
const secondSnippetInCorpus = "TS2304: Cannot find name 'missingVar'.";
const fileInCorpus = "src/baz.ts"; // in corpus but NOT in changedFiles

// ---------------------------------------------------------------------------
// PASSIVE_BUBBLE mode
// ---------------------------------------------------------------------------

test("PASSIVE_BUBBLE: not checked, empty evidence", () => {
  const result = guardCritique(baseBrainOutput, "PASSIVE_BUBBLE", evidenceCorpus, changedFiles);
  expect(result.label).toBe("not_checked");
  expect(result.unverified).toEqual([]);
});

test("PASSIVE_BUBBLE: passes evidence through UNFILTERED and says it did not check", () => {
  const fabricated = {
    tool: "tsc" as const,
    file: "phantom.ts",
    snippet: "completely fabricated snippet that doesn't exist",
  };
  const out: BrainOutput = { ...baseBrainOutput, evidence: [fabricated] };
  const result = guardCritique(out, "PASSIVE_BUBBLE", evidenceCorpus, changedFiles);
  // The label is the whole point: reporting "verified" here would claim a check
  // that never ran. The item survives BECAUSE nothing looked at it.
  expect(result.label).toBe("not_checked");
  expect(result.verified).toEqual([fabricated]);
  expect(result.unverified).toEqual([]);
});

// ---------------------------------------------------------------------------
// HARD_SUPPRESS mode (defensive — caller shouldn't invoke us but pass-through is safe)
// ---------------------------------------------------------------------------

test("HARD_SUPPRESS: not checked (defensive no-op)", () => {
  const result = guardCritique(baseBrainOutput, "HARD_SUPPRESS", evidenceCorpus, changedFiles);
  expect(result.label).toBe("not_checked");
});

// ---------------------------------------------------------------------------
// NORMAL mode — empty evidence
// ---------------------------------------------------------------------------

test("NORMAL: empty evidence is labelled, NOT refused", () => {
  const result = guardCritique(baseBrainOutput, "NORMAL", evidenceCorpus, changedFiles);
  expect(result.label).toBe("no_evidence");
  expect(result.verified).toEqual([]);
  // Nothing was cited, so nothing can have been refused. `no_evidence` and
  // `none_verified` are different facts and must not collapse into each other.
  expect(result.unverified).toEqual([]);
});

// ---------------------------------------------------------------------------
// NORMAL mode — snippet checks
// ---------------------------------------------------------------------------

test("NORMAL: snippet in corpus → verified", () => {
  const item = { tool: "tsc" as const, file: "src/foo.ts", snippet: snippetInCorpus };
  const result = guardCritique({ ...baseBrainOutput, evidence: [item] }, "NORMAL", evidenceCorpus, changedFiles);
  expect(result.label).toBe("verified");
  expect(result.verified).toEqual([item]);
  expect(result.unverified).toEqual([]);
});

test("NORMAL: snippet NOT in corpus → that item is dropped, review is labelled none_verified", () => {
  const fabricated = "completely fabricated snippet that is definitely not in corpus";
  const out: BrainOutput = {
    ...baseBrainOutput,
    evidence: [{ tool: "tsc", file: "src/foo.ts", snippet: fabricated }],
  };
  const result = guardCritique(out, "NORMAL", evidenceCorpus, changedFiles);
  expect(result.label).toBe("none_verified");
  // The fabricated citation still never travels on — that invariant did not
  // change when the guard stopped killing whole reviews.
  expect(result.verified).toEqual([]);
  expect(result.unverified).toHaveLength(1);
  expect(result.unverified[0]?.index).toBe(0);
  expect(result.unverified[0]?.reason).toContain(fabricated.slice(0, 60));
});

// ---------------------------------------------------------------------------
// NORMAL mode — file checks
// ---------------------------------------------------------------------------

test("NORMAL: file in changedFiles → verified", () => {
  const item = { tool: "tsc" as const, file: "src/foo.ts", snippet: snippetInCorpus };
  const result = guardCritique({ ...baseBrainOutput, evidence: [item] }, "NORMAL", evidenceCorpus, changedFiles);
  expect(result.label).toBe("verified");
  expect(result.verified).toEqual([item]);
});

test("NORMAL: file NOT in changedFiles but IS in corpus → verified", () => {
  // fileInCorpus = "src/baz.ts" — in corpus, not in changedFiles
  const item = {
    tool: "eslint" as const,
    file: fileInCorpus,
    snippet: "src/baz.ts: some eslint warning here",
  };
  const result = guardCritique({ ...baseBrainOutput, evidence: [item] }, "NORMAL", evidenceCorpus, changedFiles);
  expect(result.label).toBe("verified");
  expect(result.verified).toEqual([item]);
});

test("NORMAL: file in NEITHER changedFiles NOR corpus → dropped, reason names the file", () => {
  const out: BrainOutput = {
    ...baseBrainOutput,
    evidence: [{ tool: "tsc", file: "phantom.ts", snippet: snippetInCorpus }],
  };
  const result = guardCritique(out, "NORMAL", evidenceCorpus, changedFiles);
  expect(result.label).toBe("none_verified");
  expect(result.verified).toEqual([]);
  expect(result.unverified).toHaveLength(1);
  expect(result.unverified[0]?.reason).toMatch(/file/i);
  expect(result.unverified[0]?.reason).toContain("phantom.ts");
});

// ---------------------------------------------------------------------------
// NORMAL mode — multiple evidence items
// ---------------------------------------------------------------------------

test("NORMAL: one bad item out of two drops ONLY that item", () => {
  const good = { tool: "tsc" as const, file: "src/foo.ts", snippet: snippetInCorpus };
  const bad = {
    tool: "eslint" as const,
    file: "src/bar.ts",
    snippet: "this snippet is not in the corpus at all",
  };
  const result = guardCritique({ ...baseBrainOutput, evidence: [good, bad] }, "NORMAL", evidenceCorpus, changedFiles);
  expect(result.label).toBe("partly_unverified");
  expect(result.verified).toEqual([good]);
  expect(result.unverified).toHaveLength(1);
  expect(result.unverified[0]?.index).toBe(1);
});

test("NORMAL: a bad FIRST item does not stop later items being read", () => {
  // The regression this pins: the old loop `return`ed on the first failure, so
  // an item after a bad one was never examined at all. Order-swapped twin of
  // the test above — same two items, and the good one must still survive.
  const bad = {
    tool: "eslint" as const,
    file: "src/bar.ts",
    snippet: "this snippet is not in the corpus at all",
  };
  const good = { tool: "tsc" as const, file: "src/foo.ts", snippet: snippetInCorpus };
  const result = guardCritique({ ...baseBrainOutput, evidence: [bad, good] }, "NORMAL", evidenceCorpus, changedFiles);
  expect(result.label).toBe("partly_unverified");
  expect(result.verified).toEqual([good]);
  expect(result.unverified.map((u) => u.index)).toEqual([0]);
});

test("NORMAL: every item bad → none_verified, and EVERY one is reported", () => {
  // The old contract could only ever name one. Two bad items must produce two
  // entries, or the count the UI prints is wrong in the direction that flatters.
  const out: BrainOutput = {
    ...baseBrainOutput,
    evidence: [
      { tool: "tsc", file: "src/foo.ts", snippet: "first fabricated snippet not present" },
      { tool: "tsc", file: "src/bar.ts", snippet: "second fabricated snippet not present" },
    ],
  };
  const result = guardCritique(out, "NORMAL", evidenceCorpus, changedFiles);
  expect(result.label).toBe("none_verified");
  expect(result.verified).toEqual([]);
  expect(result.unverified.map((u) => u.index)).toEqual([0, 1]);
});

test("NORMAL: all multiple items valid → verified, all kept in order", () => {
  const a = { tool: "tsc" as const, file: "src/foo.ts", snippet: snippetInCorpus };
  const b = { tool: "tsc" as const, file: "src/bar.ts", snippet: secondSnippetInCorpus };
  const result = guardCritique({ ...baseBrainOutput, evidence: [a, b] }, "NORMAL", evidenceCorpus, changedFiles);
  expect(result.label).toBe("verified");
  expect(result.verified).toEqual([a, b]);
  expect(result.unverified).toEqual([]);
});

// ---------------------------------------------------------------------------
// Edge cases
// ---------------------------------------------------------------------------

test("NORMAL: long snippet (200+ chars) at corpus position 0 verifies", () => {
  // Build a corpus that starts with a long snippet — no off-by-one if includes() is used
  const longSnippet = `${"A".repeat(50)}src/foo.ts: error TS2345 very long diagnostic ${"B".repeat(100)}`;
  const corpusWithLong = `${longSnippet}\nmore stuff here`;
  const out: BrainOutput = {
    ...baseBrainOutput,
    evidence: [{ tool: "tsc", file: "src/foo.ts", snippet: longSnippet }],
  };
  const result = guardCritique(out, "NORMAL", corpusWithLong, new Set(["src/foo.ts"]));
  expect(result.label).toBe("verified");
});

test("NORMAL: snippet with newlines — substring check honors newlines (no normalization)", () => {
  const multilineSnippet = "line one of diagnostic\nline two of diagnostic";
  const corpusWithNewlines = `preamble\n${multilineSnippet}\npostamble`;
  const out: BrainOutput = {
    ...baseBrainOutput,
    evidence: [{ tool: "ripgrep", file: "src/foo.ts", snippet: multilineSnippet }],
  };
  const result = guardCritique(out, "NORMAL", corpusWithNewlines, new Set(["src/foo.ts"]));
  expect(result.label).toBe("verified");
});

test("NORMAL: snippet with newlines NOT contiguous in corpus — dropped", () => {
  // Corpus has the lines but not adjacent (newline normalization would incorrectly accept)
  const multilineSnippet = "line one of diagnostic\nline two of diagnostic";
  const corpusWithoutSequence = "line one of diagnostic\nsome other line\nline two of diagnostic";
  const out: BrainOutput = {
    ...baseBrainOutput,
    evidence: [{ tool: "ripgrep", file: "src/foo.ts", snippet: multilineSnippet }],
  };
  const result = guardCritique(out, "NORMAL", corpusWithoutSequence, new Set(["src/foo.ts"]));
  expect(result.label).toBe("none_verified");
  expect(result.unverified).toHaveLength(1);
});

test("NORMAL: empty corpus with non-empty evidence → every item dropped", () => {
  // Degenerate case — every snippet check fails immediately against an empty corpus.
  const out: BrainOutput = {
    ...baseBrainOutput,
    evidence: [{ tool: "tsc", file: "src/foo.ts", snippet: "TS2345: Argument of type 'string'" }],
  };
  const result = guardCritique(out, "NORMAL", "", new Set(["src/foo.ts"]));
  expect(result.label).toBe("none_verified");
  expect(result.unverified[0]?.reason).toContain("snippet not in evidence_corpus");
});

test("NORMAL: reason string does NOT append ellipsis when snippet ≤60 chars", () => {
  const shortSnippet = "exactly ten"; // 11 chars — under the 60-char truncation threshold
  const out: BrainOutput = {
    ...baseBrainOutput,
    evidence: [{ tool: "tsc", file: "src/foo.ts", snippet: shortSnippet }],
  };
  const result = guardCritique(out, "NORMAL", "corpus with no matching snippet here", new Set(["src/foo.ts"]));
  expect(result.unverified[0]?.reason).not.toContain("...");
  expect(result.unverified[0]?.reason).toContain(shortSnippet);
});

// ---------------------------------------------------------------------------
// hasUngroundedExternalClaim
// ---------------------------------------------------------------------------

const webSource: WebSource = {
  url: "https://example.com",
  title: "Example",
  snippet: "example snippet",
  query: "example",
};

test("hasUngroundedExternalClaim: critique mentions API + empty web_sources → true (ungrounded)", () => {
  const result = hasUngroundedExternalClaim({
    critique_for_claude: "You should use the npm api for this",
    web_sources: [],
  });
  expect(result).toBe(true);
});

test("hasUngroundedExternalClaim: critique mentions API + non-empty web_sources → false (grounded)", () => {
  const result = hasUngroundedExternalClaim({
    critique_for_claude: "You should use the npm api for this",
    web_sources: [webSource],
  });
  expect(result).toBe(false);
});

test("hasUngroundedExternalClaim: critique mentions library + empty web_sources → true", () => {
  const result = hasUngroundedExternalClaim({
    critique_for_claude: "This library has a better approach",
    web_sources: [],
  });
  expect(result).toBe(true);
});

test("hasUngroundedExternalClaim: critique has no external mention + empty web_sources → false (grounded)", () => {
  const result = hasUngroundedExternalClaim({
    critique_for_claude: "The variable name should be more descriptive",
    web_sources: [],
  });
  expect(result).toBe(false);
});

test("hasUngroundedExternalClaim: critique has no external mention + non-empty web_sources → false", () => {
  const result = hasUngroundedExternalClaim({
    critique_for_claude: "Fix the indentation here",
    web_sources: [webSource],
  });
  expect(result).toBe(false);
});

test("hasUngroundedExternalClaim: critique mentions sdk keyword + empty web_sources → true", () => {
  const result = hasUngroundedExternalClaim({
    critique_for_claude: "Use the SDK to handle authentication",
    web_sources: [],
  });
  expect(result).toBe(true);
});

test("hasUngroundedExternalClaim: critique mentions webhook keyword + empty web_sources → true", () => {
  const result = hasUngroundedExternalClaim({
    critique_for_claude: "Set up the webhook endpoint correctly",
    web_sources: [],
  });
  expect(result).toBe(true);
});
