import { test, expect } from "bun:test";
import { guardCritique, hasUngroundedExternalClaim } from "../../src/critic/evidence-guard";
import type { BrainOutput } from "../../src/brain/schema";
import type { WebSource } from "../../src/brain/schema-v2";

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
const fileInCorpus = "src/baz.ts"; // in corpus but NOT in changedFiles

// ---------------------------------------------------------------------------
// PASSIVE_BUBBLE mode
// ---------------------------------------------------------------------------

test("PASSIVE_BUBBLE: always accepts with empty evidence", () => {
  const result = guardCritique(baseBrainOutput, "PASSIVE_BUBBLE", evidenceCorpus, changedFiles);
  expect(result.accept).toBe(true);
});

test("PASSIVE_BUBBLE: always accepts even when evidence would fail checks", () => {
  const out: BrainOutput = {
    ...baseBrainOutput,
    evidence: [
      { tool: "tsc", file: "phantom.ts", snippet: "completely fabricated snippet that doesn't exist" },
    ],
  };
  const result = guardCritique(out, "PASSIVE_BUBBLE", evidenceCorpus, changedFiles);
  expect(result.accept).toBe(true);
});

// ---------------------------------------------------------------------------
// HARD_SUPPRESS mode (defensive — caller shouldn't invoke us but accept is safe)
// ---------------------------------------------------------------------------

test("HARD_SUPPRESS: always accepts (defensive no-op)", () => {
  const result = guardCritique(baseBrainOutput, "HARD_SUPPRESS", evidenceCorpus, changedFiles);
  expect(result.accept).toBe(true);
});

// ---------------------------------------------------------------------------
// NORMAL mode — empty evidence
// ---------------------------------------------------------------------------

test("NORMAL: rejects when evidence array is empty", () => {
  const result = guardCritique(baseBrainOutput, "NORMAL", evidenceCorpus, changedFiles);
  expect(result.accept).toBe(false);
  if (!result.accept) {
    expect(result.reason).toMatch(/empty/i);
  }
});

// ---------------------------------------------------------------------------
// NORMAL mode — snippet checks
// ---------------------------------------------------------------------------

test("NORMAL: accepts when snippet is in corpus", () => {
  const out: BrainOutput = {
    ...baseBrainOutput,
    evidence: [
      { tool: "tsc", file: "src/foo.ts", snippet: snippetInCorpus },
    ],
  };
  const result = guardCritique(out, "NORMAL", evidenceCorpus, changedFiles);
  expect(result.accept).toBe(true);
});

test("NORMAL: rejects when snippet is NOT in corpus", () => {
  const fabricated = "completely fabricated snippet that is definitely not in corpus";
  const out: BrainOutput = {
    ...baseBrainOutput,
    evidence: [
      { tool: "tsc", file: "src/foo.ts", snippet: fabricated },
    ],
  };
  const result = guardCritique(out, "NORMAL", evidenceCorpus, changedFiles);
  expect(result.accept).toBe(false);
  if (!result.accept) {
    // Reason must mention the snippet truncated to 60 chars
    expect(result.reason).toContain(fabricated.slice(0, 60));
  }
});

// ---------------------------------------------------------------------------
// NORMAL mode — file checks
// ---------------------------------------------------------------------------

test("NORMAL: accepts when file is in changedFiles", () => {
  const out: BrainOutput = {
    ...baseBrainOutput,
    evidence: [
      { tool: "tsc", file: "src/foo.ts", snippet: snippetInCorpus },
    ],
  };
  const result = guardCritique(out, "NORMAL", evidenceCorpus, changedFiles);
  expect(result.accept).toBe(true);
});

test("NORMAL: accepts when file is NOT in changedFiles but IS in corpus", () => {
  const out: BrainOutput = {
    ...baseBrainOutput,
    evidence: [
      // fileInCorpus = "src/baz.ts" — in corpus, not in changedFiles
      { tool: "eslint", file: fileInCorpus, snippet: "src/baz.ts: some eslint warning here" },
    ],
  };
  const result = guardCritique(out, "NORMAL", evidenceCorpus, changedFiles);
  expect(result.accept).toBe(true);
});

test("NORMAL: rejects when file is in NEITHER changedFiles NOR corpus", () => {
  const out: BrainOutput = {
    ...baseBrainOutput,
    evidence: [
      { tool: "tsc", file: "phantom.ts", snippet: snippetInCorpus },
    ],
  };
  const result = guardCritique(out, "NORMAL", evidenceCorpus, changedFiles);
  expect(result.accept).toBe(false);
  if (!result.accept) {
    expect(result.reason).toMatch(/file/i);
    expect(result.reason).toContain("phantom.ts");
  }
});

// ---------------------------------------------------------------------------
// NORMAL mode — multiple evidence items
// ---------------------------------------------------------------------------

test("NORMAL: rejects on first failure when multiple items and one fails", () => {
  const out: BrainOutput = {
    ...baseBrainOutput,
    evidence: [
      // First item: valid
      { tool: "tsc", file: "src/foo.ts", snippet: snippetInCorpus },
      // Second item: fabricated snippet
      { tool: "eslint", file: "src/bar.ts", snippet: "this snippet is not in the corpus at all" },
    ],
  };
  const result = guardCritique(out, "NORMAL", evidenceCorpus, changedFiles);
  expect(result.accept).toBe(false);
});

test("NORMAL: accepts when all multiple items are valid", () => {
  const out: BrainOutput = {
    ...baseBrainOutput,
    evidence: [
      { tool: "tsc", file: "src/foo.ts", snippet: snippetInCorpus },
      { tool: "tsc", file: "src/bar.ts", snippet: "TS2304: Cannot find name 'missingVar'." },
    ],
  };
  const result = guardCritique(out, "NORMAL", evidenceCorpus, changedFiles);
  expect(result.accept).toBe(true);
});

// ---------------------------------------------------------------------------
// Edge cases
// ---------------------------------------------------------------------------

test("NORMAL: accepts long snippet (200+ chars) at corpus position 0", () => {
  // Build a corpus that starts with a long snippet — no off-by-one if includes() is used
  const longSnippet = `${"A".repeat(50)}src/foo.ts: error TS2345 very long diagnostic ${"B".repeat(100)}`;
  const corpusWithLong = `${longSnippet}\nmore stuff here`;
  const out: BrainOutput = {
    ...baseBrainOutput,
    evidence: [
      { tool: "tsc", file: "src/foo.ts", snippet: longSnippet },
    ],
  };
  const result = guardCritique(out, "NORMAL", corpusWithLong, new Set(["src/foo.ts"]));
  expect(result.accept).toBe(true);
});

test("NORMAL: snippet with newlines — substring check honors newlines (no normalization)", () => {
  const multilineSnippet = "line one of diagnostic\nline two of diagnostic";
  const corpusWithNewlines = `preamble\n${multilineSnippet}\npostamble`;
  const out: BrainOutput = {
    ...baseBrainOutput,
    evidence: [
      { tool: "ripgrep", file: "src/foo.ts", snippet: multilineSnippet },
    ],
  };
  const result = guardCritique(out, "NORMAL", corpusWithNewlines, new Set(["src/foo.ts"]));
  expect(result.accept).toBe(true);
});

test("NORMAL: snippet with newlines NOT in corpus — rejects", () => {
  // Corpus has the lines but not adjacent (newline normalization would incorrectly accept)
  const multilineSnippet = "line one of diagnostic\nline two of diagnostic";
  const corpusWithoutSequence = "line one of diagnostic\nsome other line\nline two of diagnostic";
  const out: BrainOutput = {
    ...baseBrainOutput,
    evidence: [
      { tool: "ripgrep", file: "src/foo.ts", snippet: multilineSnippet },
    ],
  };
  const result = guardCritique(out, "NORMAL", corpusWithoutSequence, new Set(["src/foo.ts"]));
  expect(result.accept).toBe(false);
});

test("NORMAL: rejects when corpus is empty string and evidence is non-empty", () => {
  // Degenerate case — every snippet check fails immediately against an empty corpus.
  const out: BrainOutput = {
    ...baseBrainOutput,
    evidence: [
      { tool: "tsc", file: "src/foo.ts", snippet: "TS2345: Argument of type 'string'" },
    ],
  };
  const result = guardCritique(out, "NORMAL", "", new Set(["src/foo.ts"]));
  expect(result.accept).toBe(false);
  if (!result.accept) {
    expect(result.reason).toContain("snippet not in evidence_corpus");
  }
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

test("NORMAL: reason string does NOT append ellipsis when snippet ≤60 chars", () => {
  const shortSnippet = "exactly ten"; // 11 chars — under the 60-char truncation threshold
  const out: BrainOutput = {
    ...baseBrainOutput,
    evidence: [
      { tool: "tsc", file: "src/foo.ts", snippet: shortSnippet },
    ],
  };
  const result = guardCritique(out, "NORMAL", "corpus with no matching snippet here", new Set(["src/foo.ts"]));
  expect(result.accept).toBe(false);
  if (!result.accept) {
    expect(result.reason).not.toContain("...");
    expect(result.reason).toContain(shortSnippet);
  }
});
