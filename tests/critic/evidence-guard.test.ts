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
  findings: [],
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
    findings: [],
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
    findings: [],
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
    findings: [],
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
    findings: [],
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
    findings: [],
    evidence: [{ tool: "ripgrep", file: "src/foo.ts", snippet: multilineSnippet }],
  };
  const result = guardCritique(out, "NORMAL", corpusWithNewlines, new Set(["src/foo.ts"]));
  expect(result.label).toBe("verified");
});

test("NORMAL: snippet with newlines NOT contiguous in corpus — dropped", () => {
  // Corpus has the lines but not adjacent (newline normalization would incorrectly accept)
  const multilineSnippet = "line one of diagnostic\nline two of diagnostic";
  // The corpus must NAME the file, because a real one does: ripgrep runs with
  // `--json` (path per match), eslint with `--format json` (filePath), tsc
  // prints `src/foo.ts(12,5):`, and git diff prints `a/src/foo.ts`. Without the
  // name this fixture describes a corpus that holds a file's content while
  // never mentioning it, which no tool produces — and it now routes to
  // `not_checked` (nothing to check against) instead of exercising the
  // non-contiguous-snippet path this test is about.
  const corpusWithoutSequence =
    "src/foo.ts: line one of diagnostic\nsome other line\nline two of diagnostic";
  const out: BrainOutput = {
    ...baseBrainOutput,
    findings: [],
    evidence: [{ tool: "ripgrep", file: "src/foo.ts", snippet: multilineSnippet }],
  };
  const result = guardCritique(out, "NORMAL", corpusWithoutSequence, new Set(["src/foo.ts"]));
  expect(result.label).toBe("none_verified");
  expect(result.unverified).toHaveLength(1);
});

test("NORMAL: empty corpus with non-empty evidence → not_checked (was none_verified)", () => {
  // CHANGED 2026-09-04, and this test is the clearest statement of why. An
  // empty corpus is the degenerate form of the c-dd21 defect: every snippet
  // check fails instantly, and the old answer — `none_verified` — reported that
  // as a verdict on the reviewer. Nothing was checked; there was nothing to
  // check against. The items pass through as cited-but-unexamined.
  const out: BrainOutput = {
    ...baseBrainOutput,
    findings: [],
    evidence: [{ tool: "tsc", file: "src/foo.ts", snippet: "TS2345: Argument of type 'string'" }],
  };
  const result = guardCritique(out, "NORMAL", "", new Set(["src/foo.ts"]));
  expect(result.label).toBe("not_checked");
  expect(result.verified).toHaveLength(1);
  expect(result.unverified).toHaveLength(0);
});

test("NORMAL: reason string does NOT append ellipsis when snippet ≤60 chars", () => {
  const shortSnippet = "exactly ten"; // 11 chars — under the 60-char truncation threshold
  const out: BrainOutput = {
    ...baseBrainOutput,
    findings: [],
    evidence: [{ tool: "tsc", file: "src/foo.ts", snippet: shortSnippet }],
  };
  // Names the file for the same reason as the non-contiguous test above: a
  // corpus that covers a file always mentions it, and one that does not is the
  // not_checked case rather than the refused-citation case this test is about.
  const result = guardCritique(
    out,
    "NORMAL",
    "src/foo.ts: corpus with no matching snippet here",
    new Set(["src/foo.ts"]),
  );
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

// ---------------------------------------------------------------------------
// Empty corpus is not a verdict — the c-dd21 shape
// ---------------------------------------------------------------------------
//
// Reproduced from a real review (2026-09-04): the reviewed file was UNTRACKED,
// so `git diff HEAD` contributed none of its bytes to the corpus while
// `changedFiles` — read from the host transcript — still carried it. The
// reviewer therefore had the file and cited real lines; the verifier had
// nothing to compare them against. All four citations were refused and the
// review shipped `confidence: high` beside `Confirmed (none)`.
//
// The distinction these pin: "I checked and none survived" versus "there was
// nothing to check against". The corpus below deliberately never mentions
// `src/new-file.ts`.

/** A file the agent just wrote: in changedFiles, absent from tool output. */
const untrackedFile = "src/new-file.ts";

test("all citations from a file the corpus never saw → not_checked, not none_verified", () => {
  const out: BrainOutput = {
    ...baseBrainOutput,
    findings: [],
    evidence: [
      { tool: "ripgrep", file: untrackedFile, line: 119, snippet: "def _hook(event, args):" },
      { tool: "ripgrep", file: untrackedFile, line: 60, snippet: "except TypeError: return None" },
    ],
  };
  const v = guardCritique(out, "NORMAL", evidenceCorpus, new Set([untrackedFile]));

  expect(v.label).toBe("not_checked");
  // The items pass through as cited-but-unexamined, NOT under "Refused" —
  // which renders as "the guard looked at these and rejected them".
  expect(v.verified).toHaveLength(2);
  expect(v.unverified).toHaveLength(0);
});

test("a budget-cut file behaves identically to an untracked one", () => {
  // The common cause, and none of the tests above exercised it — every one was
  // framed around "untracked" while this repo's own measurement puts 39.1% of
  // source-carrying diffs over the 20-hunk review budget
  // (src/brain/hunk-selection.ts). When `selectHunksForBudget` cuts every hunk
  // of a file, `scopeDiffRawToFiles` drops its raw bytes too, so the corpus
  // holds nothing about a file that IS tracked and IS changed.
  //
  // It gets its OWN label, because the sentence a user reads is not the same:
  // "this change was too large to read in full" is siltpoke's limit and is
  // actionable; "could not read these files" is not. Saying the first as the
  // second is a false statement about the more common case.
  const budgetCutFile = "src/big-refactor.ts";
  const out: BrainOutput = {
    ...baseBrainOutput,
    findings: [],
    evidence: [
      { tool: "git-diff", file: budgetCutFile, line: 940, snippet: "const x = compute(y);" },
    ],
  };
  const v = guardCritique(
    out,
    "NORMAL",
    evidenceCorpus,
    new Set([budgetCutFile]),
    new Set([budgetCutFile]),
  );

  expect(v.label).toBe("not_checked_budget");
  expect(v.verified).toHaveLength(1);
  expect(v.unverified).toHaveLength(0);
});

test("without the cut-file set, a budget-cut file degrades to plain not_checked", () => {
  // The parameter is optional so every existing caller keeps working. An
  // omitted set must mean "nothing known to be cut" — the plainer label, which
  // is true but less specific — and never an exception or a wrong claim.
  const budgetCutFile = "src/big-refactor.ts";
  const out: BrainOutput = {
    ...baseBrainOutput,
    findings: [],
    evidence: [
      { tool: "git-diff", file: budgetCutFile, line: 940, snippet: "const x = compute(y);" },
    ],
  };
  const v = guardCritique(out, "NORMAL", evidenceCorpus, new Set([budgetCutFile]));
  expect(v.label).toBe("not_checked");
});

test("a cut file mixed with an unreadable one gets the plainer label", () => {
  // "Too big to read" would be only half the reason, and the half that is
  // wrong for the other file. ALL of them, not any.
  const cut = "src/big-refactor.ts";
  const out: BrainOutput = {
    ...baseBrainOutput,
    findings: [],
    evidence: [
      { tool: "git-diff", file: cut, line: 940, snippet: "const x = compute(y);" },
      { tool: "ripgrep", file: untrackedFile, line: 119, snippet: "def _hook(event, args):" },
    ],
  };
  const v = guardCritique(
    out,
    "NORMAL",
    evidenceCorpus,
    new Set([cut, untrackedFile]),
    new Set([cut]), // only the first was cut; the second was never there
  );
  expect(v.label).toBe("not_checked");
});

test("a corpus-covered file failing its snippet is still none_verified", () => {
  // The control. Same zero-survivors outcome, different cause: the corpus DOES
  // hold this file, so the check ran and the citation genuinely did not match.
  // Without this, routing everything to not_checked would look identical.
  const out: BrainOutput = {
    ...baseBrainOutput,
    findings: [],
    evidence: [{ tool: "tsc", file: "src/foo.ts", line: 12, snippet: "a line the corpus does not contain" }],
  };
  const v = guardCritique(out, "NORMAL", evidenceCorpus, changedFiles);

  expect(v.label).toBe("none_verified");
  expect(v.unverified).toHaveLength(1);
});

test("one covered file and one uncovered file → partly_unverified, not not_checked", () => {
  // Deliberately narrow: part of this review really was checked, so the label
  // must not claim the whole of it went unexamined.
  const out: BrainOutput = {
    ...baseBrainOutput,
    findings: [],
    evidence: [
      { tool: "tsc", file: "src/foo.ts", line: 12, snippet: snippetInCorpus },
      { tool: "ripgrep", file: untrackedFile, line: 119, snippet: "def _hook(event, args):" },
    ],
  };
  const v = guardCritique(out, "NORMAL", evidenceCorpus, new Set(["src/foo.ts", untrackedFile]));

  expect(v.label).toBe("partly_unverified");
  expect(v.verified).toHaveLength(1);
  expect(v.unverified).toHaveLength(1);
});

test("zero survivors from MIXED causes is none_verified, not not_checked", () => {
  // The case `every` exists for, and the only one that can distinguish it from
  // `some`: nothing verified, but the failures have different reasons — one
  // file the corpus never held, one it did hold whose snippet simply did not
  // match. `some` would call the whole review unexamined and bury a citation
  // that WAS checked and refused.
  //
  // Found by mutation: swapping `every` for `some` left all previous tests
  // green, because each of them either had a survivor (so the
  // `verified.length === 0` clause already decided it) or had a single cause.
  const out: BrainOutput = {
    ...baseBrainOutput,
    findings: [],
    evidence: [
      // corpus has no bytes for this file at all
      { tool: "ripgrep", file: untrackedFile, line: 119, snippet: "def _hook(event, args):" },
      // corpus DOES cover this file; the snippet is simply not in it
      { tool: "tsc", file: "src/foo.ts", line: 12, snippet: "a line the corpus does not contain" },
    ],
  };
  const v = guardCritique(out, "NORMAL", evidenceCorpus, new Set([untrackedFile, "src/foo.ts"]));

  expect(v.label).toBe("none_verified");
  expect(v.unverified).toHaveLength(2);
});

test("an uncovered file NOT in changedFiles stays none_verified", () => {
  // The narrowing that keeps this from excusing any citation at all: the file
  // must be one the reviewer legitimately had. A citation naming a path nobody
  // touched is not a corpus gap — it is a citation about the wrong thing.
  const out: BrainOutput = {
    ...baseBrainOutput,
    findings: [],
    evidence: [{ tool: "tsc", file: "src/never-touched.ts", line: 1, snippet: "whatever" }],
  };
  const v = guardCritique(out, "NORMAL", evidenceCorpus, changedFiles);

  expect(v.label).toBe("none_verified");
});

test("a covered file that verifies is unaffected", () => {
  // Anti-vacuous: the change must not make the ordinary success path unreachable.
  const out: BrainOutput = {
    ...baseBrainOutput,
    findings: [],
    evidence: [{ tool: "tsc", file: "src/foo.ts", line: 12, snippet: snippetInCorpus }],
  };
  const v = guardCritique(out, "NORMAL", evidenceCorpus, changedFiles);

  expect(v.label).toBe("verified");
  expect(v.verified).toHaveLength(1);
});
