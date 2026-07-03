/**
 * Tests for src/brain/prompt-tools.ts
 */
import { test, expect, describe } from "bun:test";
import {
  buildToolOutputSection,
  buildPassiveBubblePrompt,
} from "../../src/brain/prompt-tools";
import type { ToolName, ToolResult } from "../../src/critic/tools/types";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeTscResult(
  overrides: Partial<Extract<ToolResult, { tool: "tsc" }>> = {},
): Extract<ToolResult, { tool: "tsc" }> {
  return {
    tool: "tsc",
    status: "ok",
    parsed: [],
    raw: "",
    ...overrides,
  };
}

function makeEslintResult(
  overrides: Partial<Extract<ToolResult, { tool: "eslint" }>> = {},
): Extract<ToolResult, { tool: "eslint" }> {
  return {
    tool: "eslint",
    status: "ok",
    parsed: [],
    raw: "",
    ...overrides,
  };
}

function makeGitDiffResult(
  overrides: Partial<Extract<ToolResult, { tool: "git-diff" }>> = {},
): Extract<ToolResult, { tool: "git-diff" }> {
  return {
    tool: "git-diff",
    status: "ok",
    parsed: [],
    raw: "",
    ...overrides,
  };
}

function makeRipgrepResult(
  overrides: Partial<Extract<ToolResult, { tool: "ripgrep" }>> = {},
): Extract<ToolResult, { tool: "ripgrep" }> {
  return {
    tool: "ripgrep",
    status: "ok",
    parsed: [],
    raw: "",
    ...overrides,
  };
}

function makeAllResults(
  overrides: {
    tsc?: Partial<Extract<ToolResult, { tool: "tsc" }>>;
    eslint?: Partial<Extract<ToolResult, { tool: "eslint" }>>;
    "git-diff"?: Partial<Extract<ToolResult, { tool: "git-diff" }>>;
    ripgrep?: Partial<Extract<ToolResult, { tool: "ripgrep" }>>;
  } = {},
): Record<string, ToolResult> {
  return {
    tsc: makeTscResult(overrides.tsc),
    eslint: makeEslintResult(overrides.eslint),
    "git-diff": makeGitDiffResult(overrides["git-diff"]),
    ripgrep: makeRipgrepResult(overrides.ripgrep),
  };
}

// ---------------------------------------------------------------------------
// Test 1: Happy path — all 4 tools ok with findings
// ---------------------------------------------------------------------------

test("all 4 tools ok with findings: section has 4 blocks, corpus has all raws", () => {
  const results = makeAllResults({
    tsc: {
      raw: "tsc-raw-output",
      parsed: [
        {
          file: "src/foo.ts",
          line: 42,
          col: 5,
          severity: "error",
          code: "TS2345",
          message: "Argument mismatch",
        },
      ],
    },
    eslint: {
      raw: "eslint-raw-output",
      parsed: [
        {
          file: "src/bar.ts",
          line: 10,
          col: 1,
          severity: "error",
          ruleId: "no-unused-vars",
          message: "x is defined but never used",
        },
      ],
    },
    "git-diff": {
      raw: "git-diff-raw-output",
      parsed: [
        {
          file: "src/foo.ts",
          oldStart: 1,
          oldLines: 3,
          newStart: 1,
          newLines: 3,
          header: "@@ -1,3 +1,3 @@",
          body: "-const x = 1;\n+const x: number = 1;",
        },
      ],
    },
    ripgrep: {
      raw: "ripgrep-raw-output",
      parsed: [
        { file: "src/util.ts", line: 101, text: "// TODO: handle edge case", pattern: "TODO" },
      ],
    },
  });

  const { section, evidenceCorpus } = buildToolOutputSection(results);

  // Section has all 4 tool blocks
  expect(section).toContain("### tsc");
  expect(section).toContain("### eslint");
  expect(section).toContain("### git diff");
  expect(section).toContain("### ripgrep");

  // Section contains finding details
  expect(section).toContain("src/foo.ts");
  expect(section).toContain("TS2345");
  expect(section).toContain("no-unused-vars");
  expect(section).toContain("TODO");

  // Corpus contains all 4 raws
  expect(evidenceCorpus).toContain("tsc-raw-output");
  expect(evidenceCorpus).toContain("eslint-raw-output");
  expect(evidenceCorpus).toContain("git-diff-raw-output");
  expect(evidenceCorpus).toContain("ripgrep-raw-output");
});

// ---------------------------------------------------------------------------
// Test 2: tsc only — other tools not_applicable or ok+empty
// ---------------------------------------------------------------------------

test("tsc only with findings: other tools omitted from section body", () => {
  const results = makeAllResults({
    tsc: {
      raw: "tsc-only-raw",
      parsed: [
        {
          file: "src/a.ts",
          line: 1,
          col: 1,
          severity: "error",
          code: "TS2304",
          message: "Cannot find name 'foo'",
        },
      ],
    },
    eslint: { status: "not_applicable", raw: "" },
    "git-diff": { status: "not_applicable", raw: "" },
    ripgrep: { status: "ok", parsed: [], raw: "" },
  });

  const { section } = buildToolOutputSection(results);

  // tsc block present
  expect(section).toContain("### tsc");
  expect(section).toContain("TS2304");

  // not_applicable tools should not have body blocks
  expect(section).not.toContain("### eslint diagnostics");
  expect(section).not.toContain("### git diff");

  // not_applicable eslint mentioned in skipped header
  expect(section).toContain("eslint");
  expect(section).toContain("not_applicable");
});

// ---------------------------------------------------------------------------
// Test 3: Skipped tools header — multiple non-ok statuses
// ---------------------------------------------------------------------------

test("skipped tools header lists each non-ok tool with status", () => {
  const results = makeAllResults({
    tsc: {
      raw: "tsc-raw",
      parsed: [
        {
          file: "src/x.ts",
          line: 5,
          col: 3,
          severity: "error",
          code: "TS2345",
          message: "type error",
        },
      ],
    },
    eslint: { status: "not_installed", raw: "" },
    "git-diff": { status: "ok", parsed: [], raw: "" },
    ripgrep: { status: "timeout", raw: "partial rg" },
  });

  const { section } = buildToolOutputSection(results);

  expect(section).toContain("eslint");
  expect(section).toContain("not_installed");
  expect(section).toContain("ripgrep");
  expect(section).toContain("timeout");
});

// ---------------------------------------------------------------------------
// Test 4: Empty results (status ok, empty parsed arrays)
// ---------------------------------------------------------------------------

test("ok tools with empty parsed arrays show clean one-liner per tool", () => {
  const results = makeAllResults({
    tsc: { status: "ok", parsed: [], raw: "" },
    eslint: { status: "ok", parsed: [], raw: "" },
    "git-diff": { status: "ok", parsed: [], raw: "" },
    ripgrep: { status: "ok", parsed: [], raw: "" },
  });

  const { section } = buildToolOutputSection(results);

  expect(section).toContain("clean (no findings)");
});

// ---------------------------------------------------------------------------
// Test 5: Budget cap — tsc 30 errors → only top 20 in section, all 30 in corpus
// ---------------------------------------------------------------------------

test("tsc budget cap: 30 errors → only top 20 in section, raw has all 30", () => {
  const thirtyErrors = Array.from({ length: 30 }, (_, i) => ({
    file: `src/file${String(i).padStart(2, "0")}.ts`,
    line: i + 1,
    col: 1,
    severity: "error" as const,
    code: `TS${2000 + i}`,
    message: `error message ${i}`,
  }));

  // Construct raw that includes all 30 error codes
  const rawWith30 = thirtyErrors.map((e) => `${e.file}(${e.line},${e.col}): ${e.code}`).join("\n");

  const results = makeAllResults({
    tsc: { status: "ok", parsed: thirtyErrors, raw: rawWith30 },
  });

  const { section, evidenceCorpus } = buildToolOutputSection(results);

  // Section has at most 20 items (check for 21st item absent)
  // TS2020 is the 21st (index 20)
  expect(section).toContain("TS2000"); // first item present
  expect(section).toContain("TS2019"); // 20th item present
  expect(section).not.toContain("TS2020"); // 21st item absent

  // Corpus has all 30
  expect(evidenceCorpus).toContain("TS2029"); // 30th item
});

// ---------------------------------------------------------------------------
// Test 6: git-diff hunk cap — 25 hunks → only first 20, "+5 more hunks omitted"
// ---------------------------------------------------------------------------

test("git-diff hunk cap: 25 hunks → first 20 shown, +5 more hunks omitted marker present", () => {
  const twentyFiveHunks = Array.from({ length: 25 }, (_, i) => ({
    file: `src/file${i}.ts`,
    oldStart: i * 10 + 1,
    oldLines: 5,
    newStart: i * 10 + 1,
    newLines: 5,
    header: `@@ -${i * 10 + 1},5 +${i * 10 + 1},5 @@`,
    body: `-old line ${i}\n+new line ${i}`,
  }));

  const results = makeAllResults({
    "git-diff": { status: "ok", parsed: twentyFiveHunks, raw: "git-diff-raw" },
  });

  const { section } = buildToolOutputSection(results);

  // Should mention omitted hunks
  expect(section).toMatch(/\+5 more hunk/i);
});

// ---------------------------------------------------------------------------
// Test 7: ripgrep cap — 60 matches → only top 50 in section
// ---------------------------------------------------------------------------

test("ripgrep cap: 60 matches → only top 50 shown in section", () => {
  const sixtyMatches = Array.from({ length: 60 }, (_, i) => ({
    file: `src/file${String(i).padStart(2, "0")}.ts`,
    line: i + 1,
    text: `// TODO: item ${i}`,
    pattern: "TODO",
  }));

  const results = makeAllResults({
    ripgrep: { status: "ok", parsed: sixtyMatches, raw: "rg-raw" },
  });

  const { section } = buildToolOutputSection(results);

  // file00 through file49 should appear (first 50), file50..file59 should not
  expect(section).toContain("src/file00.ts");
  expect(section).toContain("src/file49.ts");
  expect(section).not.toContain("src/file50.ts");
});

// ---------------------------------------------------------------------------
// Test 8: evidenceCorpus — exact sum of non-empty raws with separator
// ---------------------------------------------------------------------------

test("evidenceCorpus is raw concatenation with corpus separator", () => {
  const results = makeAllResults({
    tsc: { raw: "tsc-raw-UNIQUE", parsed: [] },
    eslint: { raw: "eslint-raw-UNIQUE", parsed: [] },
    "git-diff": { raw: "git-diff-raw-UNIQUE", parsed: [] },
    ripgrep: { raw: "rg-raw-UNIQUE", parsed: [] },
  });

  const { evidenceCorpus } = buildToolOutputSection(results);

  expect(evidenceCorpus).toContain("tsc-raw-UNIQUE");
  expect(evidenceCorpus).toContain("eslint-raw-UNIQUE");
  expect(evidenceCorpus).toContain("git-diff-raw-UNIQUE");
  expect(evidenceCorpus).toContain("rg-raw-UNIQUE");
  expect(evidenceCorpus).toContain("--- corpus separator ---");

  // Each raw should be findable as a verbatim substring
  expect(evidenceCorpus.includes("tsc-raw-UNIQUE")).toBe(true);
  expect(evidenceCorpus.includes("eslint-raw-UNIQUE")).toBe(true);
});

// ---------------------------------------------------------------------------
// Test 9: Empty corpus — all non-ok tools with no raw
// ---------------------------------------------------------------------------

test("all non-ok tools with empty raw → evidenceCorpus is empty string", () => {
  const results = makeAllResults({
    tsc: { status: "not_installed", raw: "" },
    eslint: { status: "not_installed", raw: "" },
    "git-diff": { status: "error", raw: "" },
    ripgrep: { status: "timeout", raw: "" },
  });

  const { evidenceCorpus } = buildToolOutputSection(results);

  expect(evidenceCorpus).toBe("");
});

// ---------------------------------------------------------------------------
// Test 10: No normalization — corpus preserves \r\n
// ---------------------------------------------------------------------------

test("no normalization: corpus preserves \\r\\n in raw output", () => {
  const rawWithCRLF = "line1\r\nline2\r\nline3";
  const results = makeAllResults({
    tsc: { raw: rawWithCRLF, parsed: [] },
  });

  const { evidenceCorpus } = buildToolOutputSection(results);

  // Must find exact bytes including \r\n
  expect(evidenceCorpus.includes("line1\r\nline2\r\nline3")).toBe(true);
  // Must NOT have been normalized away
  expect(evidenceCorpus).toContain("\r\n");
});

// ---------------------------------------------------------------------------
// Test 11: buildPassiveBubblePrompt — 3 files, 5 hunks
// ---------------------------------------------------------------------------

test("buildPassiveBubblePrompt: mentions file count and hunk count", () => {
  const diff = makeGitDiffResult({
    status: "ok",
    parsed: [
      { file: "src/a.ts", oldStart: 1, oldLines: 2, newStart: 1, newLines: 2, header: "@@ -1,2 +1,2 @@", body: "-a\n+b" },
      { file: "src/a.ts", oldStart: 10, oldLines: 2, newStart: 10, newLines: 2, header: "@@ -10,2 +10,2 @@", body: "-c\n+d" },
      { file: "src/b.ts", oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, header: "@@ -1,1 +1,1 @@", body: "-e\n+f" },
      { file: "src/c.ts", oldStart: 5, oldLines: 3, newStart: 5, newLines: 3, header: "@@ -5,3 +5,3 @@", body: "-g\n+h" },
      { file: "src/c.ts", oldStart: 20, oldLines: 1, newStart: 20, newLines: 1, header: "@@ -20,1 +20,1 @@", body: "-i\n+j" },
    ],
    raw: "git-diff-raw",
  });

  const prompt = buildPassiveBubblePrompt(diff);

  // Should mention 3 distinct files and 5 hunks
  expect(prompt).toContain("3");
  expect(prompt).toContain("5");
  // Should contain file-related language
  expect(prompt.toLowerCase()).toMatch(/file/);
  expect(prompt.toLowerCase()).toMatch(/hunk/);
});

// ---------------------------------------------------------------------------
// Test 12: buildPassiveBubblePrompt — singular forms
// ---------------------------------------------------------------------------

test("buildPassiveBubblePrompt: 1 file, 1 hunk — singular form (not plural)", () => {
  const diff = makeGitDiffResult({
    status: "ok",
    parsed: [
      { file: "src/single.ts", oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, header: "@@ -1,1 +1,1 @@", body: "-x\n+y" },
    ],
    raw: "diff-raw",
  });

  const prompt = buildPassiveBubblePrompt(diff);

  // Catch regression if ternary flips singular ↔ plural
  expect(prompt).toContain("1 file");
  expect(prompt).toContain("1 hunk");
  // The exact word "files" or "hunks" must NOT appear standalone for count=1
  // (allow as substring inside other words; use word-boundary check)
  expect(/\b1 files\b/.test(prompt)).toBe(false);
  expect(/\b1 hunks\b/.test(prompt)).toBe(false);
});

test("buildToolOutputSection: all 4 tools non-ok → section has skipped header, no body blocks", () => {
  // PASSIVE_BUBBLE / abstention paths never reach this function, but defensive
  // coverage of the "all-failed" branch ensures section shape doesn't accidentally
  // become a body-less skeleton (e.g. just "## Tool output\n" with no header).
  const results: Record<ToolName, ToolResult> = {
    tsc: makeTscResult({ status: "not_installed", parsed: [], raw: "" }),
    eslint: makeEslintResult({ status: "timeout", parsed: [], raw: "" }),
    "git-diff": makeGitDiffResult({ status: "error", parsed: [], raw: "git error" }),
    ripgrep: makeRipgrepResult({ status: "not_installed", parsed: [], raw: "" }),
  };

  const { section, evidenceCorpus } = buildToolOutputSection(results);

  expect(section).toContain("Tools skipped:");
  expect(section).not.toContain("Tools ran:");
  expect(section).not.toContain("### tsc");
  expect(section).not.toContain("### eslint");
  expect(section).not.toContain("### git diff");
  expect(section).not.toContain("### ripgrep");
  expect(section).not.toContain("clean (no findings)");
  // git-diff had non-empty raw → corpus is just that one block
  expect(evidenceCorpus).toBe("git error");
});

// ---------------------------------------------------------------------------
// Test 13: buildPassiveBubblePrompt — instructs LLM to emit null for critique_for_claude
// ---------------------------------------------------------------------------

test("buildPassiveBubblePrompt: instructs LLM to emit empty string for critique_for_claude", () => {
  const diff = makeGitDiffResult({
    status: "ok",
    parsed: [],
    raw: "",
  });

  const prompt = buildPassiveBubblePrompt(diff);

  expect(prompt).toContain('""');
  expect(prompt.toLowerCase()).toContain("critique_for_claude");
});

// ---------------------------------------------------------------------------
// Test 14: buildPassiveBubblePrompt — instructs empty evidence array
// ---------------------------------------------------------------------------

test("buildPassiveBubblePrompt: instructs LLM that evidence should be empty", () => {
  const diff = makeGitDiffResult({
    status: "ok",
    parsed: [],
    raw: "",
  });

  const prompt = buildPassiveBubblePrompt(diff);

  expect(prompt.toLowerCase()).toContain("evidence");
  expect(prompt.toLowerCase()).toMatch(/empty|empty array|\[\]/);
});

// ---------------------------------------------------------------------------
// buildPassiveBubblePrompt — intent-aware framing (anti-keyword guard)
// ---------------------------------------------------------------------------

describe("buildPassiveBubblePrompt — intent-aware", () => {
  test("intent=bugfix → no 'refactor' wording", () => {
    const prompt = buildPassiveBubblePrompt({
      files: 1, hunks: 1,
      intent: { classification: "bugfix", confidence: 0.9 },
    });
    expect(prompt.toLowerCase()).not.toContain("refactor");
    expect(prompt.toLowerCase()).toContain("change");
  });

  test("intent=refactor → 'refactor' wording allowed", () => {
    const prompt = buildPassiveBubblePrompt({
      files: 2, hunks: 5,
      intent: { classification: "refactor", confidence: 0.85 },
    });
    expect(prompt.toLowerCase()).toContain("refactor");
  });

  test("intent unknown → neutral 'change' wording", () => {
    const prompt = buildPassiveBubblePrompt({ files: 1, hunks: 1 });
    expect(prompt.toLowerCase()).not.toContain("refactor");
  });
});
