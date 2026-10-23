/**
 * The critic prompt must fit in one argv string.
 *
 * Every non-Windows reviewer gets the whole critic prompt as ONE argument
 * (`systemPromptArgs`, `src/brain/system-prompt-file.ts`). macOS refuses an
 * argv over 1 MiB in total; Linux refuses any SINGLE argument over 128 KiB.
 * Over the limit the spawn fails with `E2BIG: argument list too long`, the
 * breaker latches, and reviews stop.
 *
 * Measured 2026-10-15 on `~/.siltpoke/brain-calls.jsonl`: every review whose
 * tool output passed ~900 KB failed that way (qoder 51 times, codebuddy 3).
 * The cause was the git-diff block: `public/static/index.js` is a minified
 * bundle whose longest line is 184,428 characters, and every cap in the path
 * counted lines or hunks — never bytes. A handful of lines carried a megabyte.
 *
 * The rest of the prompt (rules, memory, few-shot) peaked at ~21 KB over 2,234
 * recorded reviews, so the tool output has to stay under ~100 KB for the whole
 * prompt to clear Linux's 128 KiB.
 */
import { describe, expect, test } from "bun:test";
import { describeCoverage, selectHunksForBudget } from "../../src/brain/hunk-selection";
import { buildToolOutputSection } from "../../src/brain/prompt-tools";
import type { GitDiffHunk, ToolName, ToolResult } from "../../src/critic/tools/types";

/** Linux's per-argument limit, minus the ~21 KB the rest of the prompt has used. */
const TOOL_OUTPUT_CEILING = 100_000;
const LINE_MAX = 500;

const bytes = (s: string): number => Buffer.byteLength(s, "utf8");

function hunk(file: string, n: number, body: string): GitDiffHunk {
  return {
    file,
    oldStart: n,
    oldLines: 1,
    newStart: n,
    newLines: 1,
    header: `@@ -${n},1 +${n},1 @@`,
    body,
  };
}

function results(parsed: GitDiffHunk[], extra: Partial<Record<ToolName, ToolResult>> = {}) {
  return {
    tsc: { tool: "tsc", status: "ok", parsed: [], raw: "" },
    eslint: { tool: "eslint", status: "ok", parsed: [], raw: "" },
    "git-diff": { tool: "git-diff", status: "ok", parsed, raw: "" },
    ripgrep: { tool: "ripgrep", status: "ok", parsed: [], raw: "" },
    ...extra,
  } as Record<ToolName, ToolResult>;
}

/** The shape of the real failure: a minified bundle, one enormous line per hunk. */
function minifiedLine(seed: number): string {
  return `+${`var a${seed}=function(){return ${seed}};`.repeat(5_000)}`.slice(0, 184_428);
}

describe("tool output fits in one argv string", () => {
  test("a minified bundle in the diff no longer produces a megabyte of prompt", () => {
    const parsed = [
      hunk("src/app.ts", 1, "-const a = 1;\n+const a = 2;"),
      ...Array.from({ length: 6 }, (_, i) => hunk("public/static/index.js", i + 1, minifiedLine(i))),
    ];
    const { section, citationSection } = buildToolOutputSection(results(parsed));

    expect(bytes(section)).toBeLessThan(TOOL_OUTPUT_CEILING);
    expect(bytes(citationSection)).toBeLessThan(TOOL_OUTPUT_CEILING);
    // The hand-written source still reached the reviewer.
    expect(section).toContain("+const a = 2;");
  });

  test("a long line is shortened, and the prompt says so", () => {
    const long = `+${"x".repeat(2_000)}`;
    const { section } = buildToolOutputSection(results([hunk("src/a.ts", 1, long)]));

    for (const line of section.split("\n")) {
      expect(line.length).toBeLessThanOrEqual(LINE_MAX + 80);
    }
    expect(section).toContain(`+${"x".repeat(LINE_MAX - 1)}`);
    expect(section).toContain("[line cut: 2001 chars]");
  });

  test("the cut marker is siltpoke's prose, so it is not citable", () => {
    const long = `+${"y".repeat(2_000)}`;
    const { citationSection } = buildToolOutputSection(results([hunk("src/a.ts", 1, long)]));

    expect(citationSection).not.toContain("line cut");
    // The part the reviewer DID see stays citable.
    expect(citationSection).toContain(`+${"y".repeat(LINE_MAX - 1)}`);
    // The part it did not see is not in the section corpus.
    expect(citationSection).not.toContain("y".repeat(LINE_MAX + 1));
  });

  test("hunks past the byte budget are cut and counted, not silently dropped", () => {
    // 20 hunks of ~12 KB each: inside the 20-hunk budget, far past any byte budget.
    const body = Array.from({ length: 30 }, (_, i) => `+${String(i).repeat(400)}`.slice(0, 401)).join("\n");
    const parsed = Array.from({ length: 20 }, (_, i) => hunk(`src/f${i}.ts`, 1, body));
    const out = buildToolOutputSection(results(parsed));

    expect(bytes(out.section)).toBeLessThan(TOOL_OUTPUT_CEILING);
    expect(out.diffCoverage).not.toBeNull();
    expect(out.diffCoverage!.total).toBe(20);
    expect(out.diffCoverage!.shown).toBeGreaterThan(0);
    expect(out.diffCoverage!.shown).toBeLessThan(20);
    expect(out.section).toContain("Partial diff");
    // A file that lost every hunk is reported as budget-cut, so the guard can
    // tell "siltpoke dropped it" from "siltpoke never had it".
    expect(out.budgetCutFiles.has("src/f19.ts")).toBe(true);
    expect(out.budgetCutFiles.has("src/f0.ts")).toBe(false);
    // A cut file's text is not citable.
    expect(out.citationSection).not.toContain("#### src/f19.ts");
  });

  test("a small diff is untouched", () => {
    const parsed = [hunk("src/a.ts", 1, "-a\n+b"), hunk("src/b.ts", 1, "-c\n+d")];
    const out = buildToolOutputSection(results(parsed));

    expect(out.diffCoverage).toBeNull();
    expect(out.section).not.toContain("line cut");
    expect(out.section).toContain("-a\n+b");
  });

  test("a long tsc message is shortened too", () => {
    const tsc: ToolResult = {
      tool: "tsc",
      status: "ok",
      raw: "",
      parsed: [
        { file: "src/a.ts", line: 1, col: 1, code: "TS2322", severity: "error", message: "z".repeat(5_000) },
      ],
    } as ToolResult;
    const { section, citationSection } = buildToolOutputSection(results([], { tsc }));

    expect(section).toContain("[line cut:");
    expect(section).not.toContain("z".repeat(LINE_MAX + 1));
    expect(citationSection).not.toContain("line cut");
  });

  test("a long eslint message is shortened too", () => {
    const eslint: ToolResult = {
      tool: "eslint",
      status: "ok",
      raw: "",
      parsed: [
        { file: "src/a.ts", line: 1, col: 1, ruleId: "no-x", severity: "error", message: "e".repeat(5_000) },
      ],
    } as ToolResult;
    const { section, citationSection } = buildToolOutputSection(results([], { eslint }));

    expect(section).toContain("[line cut:");
    expect(section).not.toContain("e".repeat(LINE_MAX + 1));
    expect(citationSection).not.toContain("line cut");
    expect(citationSection).toContain("e".repeat(100));
  });

  test("the hidden tail of a cut line is not in the raw corpus either", () => {
    const long = `+${"y".repeat(2_000)}`;
    const raw = `diff --git a/src/a.ts b/src/a.ts\n--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1,1 +1,1 @@\n${long}`;
    const parsed = [hunk("src/a.ts", 1, long)];
    const { evidenceCorpus } = buildToolOutputSection(
      results(parsed, { "git-diff": { tool: "git-diff", status: "ok", parsed, raw } as ToolResult }),
    );

    expect(evidenceCorpus).toContain(`+${"y".repeat(LINE_MAX - 1)}`);
    expect(evidenceCorpus).not.toContain("y".repeat(LINE_MAX + 1));
    expect(evidenceCorpus).not.toContain("line cut");
  });

  test("once a hunk does not fit, every lower-ranked hunk is cut too", () => {
    // ~35 KB each: the first fits, the second does not. The third is tiny and
    // WOULD fit, but it ranks below the misfit, so keeping it would put a
    // lower-ranked hunk in front of a higher-ranked one.
    const big = Array.from({ length: 70 }, () => `+${"b".repeat(498)}`).join("\n");
    const parsed = [hunk("src/big1.ts", 1, big), hunk("src/big2.ts", 1, big), hunk("src/small.ts", 1, "+s")];
    const out = buildToolOutputSection(results(parsed));

    expect(out.diffCoverage!.shown).toBe(1);
    expect(out.budgetCutFiles.has("src/big2.ts")).toBe(true);
    expect(out.budgetCutFiles.has("src/small.ts")).toBe(true);
  });

  test("the coverage count sees the whole diff when a bundle is split by the cut", () => {
    // src (~30 KB) fits; the bundle's long-line hunk fits once cut to 500
    // chars; its short-line hunk (~35 KB) does not. Judged alone, that cut hunk
    // has no long line — only the whole diff shows the file is a bundle.
    const src = Array.from({ length: 60 }, () => `+${"a".repeat(498)}`).join("\n");
    const shortLines = Array.from({ length: 70 }, () => `+${"c".repeat(498)}`).join("\n");
    const parsed = [
      hunk("src/a.ts", 1, src),
      hunk("lib/bundle.js", 1, `+${"m".repeat(20_000)}`),
      hunk("lib/bundle.js", 2, shortLines),
    ];
    const out = buildToolOutputSection(results(parsed));

    expect(out.diffCoverage!.shown).toBe(2);
    expect(out.diffCoverage!.omitted).toEqual([{ tier: "generated", count: 1 }]);
  });
});

describe("a file with a minified line ranks as generated", () => {
  test("it no longer outranks hand-written docs", () => {
    const parsed = [
      hunk("public/static/index.js", 1, `+${"m".repeat(20_000)}`),
      hunk("docs/guide.md", 1, "+a doc line"),
    ];
    const { kept } = selectHunksForBudget(parsed, { budget: 1 });
    expect(kept.map((h) => h.file)).toEqual(["docs/guide.md"]);
  });

  test("ordinary lines leave an unknown path as source", () => {
    const parsed = [
      hunk("docs/guide.md", 1, "+a doc line"),
      hunk("public/static/app.js", 1, `+${"m".repeat(9_000)}`),
    ];
    const { kept } = selectHunksForBudget(parsed, { budget: 1 });
    expect(kept.map((h) => h.file)).toEqual(["public/static/app.js"]);
  });

  test("every hunk of the file moves together, even ones with short lines", () => {
    const parsed = [
      hunk("lib/bundle.js", 1, "+short"),
      hunk("src/a.ts", 1, "+a"),
      hunk("lib/bundle.js", 2, `+${"m".repeat(20_000)}`),
    ];
    const { kept } = selectHunksForBudget(parsed, { budget: 3 });
    expect(kept.map((h) => h.file)).toEqual(["src/a.ts", "lib/bundle.js", "lib/bundle.js"]);
  });

  test("the coverage count calls it generated", () => {
    const omitted = [hunk("public/static/index.js", 1, `+${"m".repeat(20_000)}`)];
    expect(describeCoverage(0, omitted).omitted).toEqual([{ tier: "generated", count: 1 }]);
  });

  test("a cut short-line hunk of a bundle still counts as generated", () => {
    const short = hunk("lib/bundle.js", 1, "+short");
    const long = hunk("lib/bundle.js", 2, `+${"m".repeat(20_000)}`);
    expect(describeCoverage(1, [short], [short, long]).omitted).toEqual([
      { tier: "generated", count: 1 },
    ]);
  });
});
