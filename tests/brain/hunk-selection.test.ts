/**
 * Defect ③ — hunk selection under the 20-hunk budget.
 *
 * Before this suite, `formatGitDiffBlock` cut with `parsed.slice(0, 20)` — a
 * prefix cut with NO ranking, applied to a list git emits in path order. The
 * consequence was measured on 200 real critic snapshots
 * (an internal design note):
 * 30.9% of reviews saw ZERO changed source, 40 of them because `dist/` held the
 * slots. These tests pin the ranking that replaced it.
 *
 * They deliberately do NOT test that MORE hunks get through — the budget is
 * unchanged, and one test asserts it stays 20 (external ablation opposes
 * widening the window: `ref-2026-07-30-swe-agent-aci-ablation`).
 */
import { test, expect, describe } from "bun:test";
import { buildToolOutputSection } from "../../src/brain/prompt-tools";
import { selectHunksForBudget, GIT_DIFF_HUNK_BUDGET } from "../../src/brain/hunk-selection";
import type {
  GitDiffHunk,
  ToolName,
  ToolResult,
  EslintFinding,
  TscDiagnostic,
} from "../../src/critic/tools/types";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function hunk(file: string, n: number): GitDiffHunk {
  return {
    file,
    oldStart: n,
    oldLines: 1,
    newStart: n,
    newLines: 1,
    header: `@@ -${n},1 +${n},1 @@`,
    body: `-old-${file}-${n}\n+new-${file}-${n}`,
  };
}

/** Hunks in raw `git diff` order: git sorts by path, so `dist/` precedes `src/`. */
function hunksInGitOrder(spec: Array<[string, number]>): GitDiffHunk[] {
  return spec.flatMap(([file, count]) =>
    Array.from({ length: count }, (_, i) => hunk(file, i + 1)),
  );
}

function results(opts: {
  parsed: GitDiffHunk[];
  eslint?: EslintFinding[];
  tsc?: TscDiagnostic[];
}): Record<ToolName, ToolResult> {
  return {
    tsc: {
      tool: "tsc",
      status: "ok",
      parsed: opts.tsc ?? [],
      raw: opts.tsc === undefined ? "" : "tsc-raw",
    },
    eslint: {
      tool: "eslint",
      status: "ok",
      parsed: opts.eslint ?? [],
      raw: opts.eslint === undefined ? "" : "eslint-raw",
    },
    "git-diff": { tool: "git-diff", status: "ok", parsed: opts.parsed, raw: "git-diff-raw" },
    ripgrep: { tool: "ripgrep", status: "ok", parsed: [], raw: "" },
  };
}

// ---------------------------------------------------------------------------

describe("defect ③ — git-diff hunk selection", () => {
  test("source outranks dist/: 25 dist hunks ahead of 5 src hunks, src still reaches the prompt", () => {
    const parsed = hunksInGitOrder([
      ["dist/siltpoke-cli.js", 25],
      ["src/critic/run-critic.ts", 5],
    ]);
    const { section } = buildToolOutputSection(results({ parsed }));

    for (let i = 1; i <= 5; i++) {
      expect(section).toContain(`+new-src/critic/run-critic.ts-${i}`);
    }
  });

  test("docs are outranked too: 30 docs hunks ahead of 3 src hunks", () => {
    const parsed = hunksInGitOrder([
      ["docs/NOTES.md", 30],
      ["src/brain/prompt-tools.ts", 3],
    ]);
    const { section } = buildToolOutputSection(results({ parsed }));

    expect(section).toContain("+new-src/brain/prompt-tools.ts-1");
    expect(section).toContain("+new-src/brain/prompt-tools.ts-3");
  });

  test("an eslint-hit source file outranks a non-hit source file over budget", () => {
    // `src/a-first.ts` sorts first and would take every slot under a prefix cut.
    const parsed = hunksInGitOrder([
      ["src/a-first.ts", 20],
      ["src/z-last.ts", 6],
    ]);
    const { section } = buildToolOutputSection(
      results({
        parsed,
        eslint: [
          {
            file: "src/z-last.ts",
            line: 3,
            col: 1,
            severity: "error",
            ruleId: "no-unused-vars",
            message: "'x' is defined but never used",
          },
        ],
      }),
    );

    for (let i = 1; i <= 6; i++) {
      expect(section).toContain(`+new-src/z-last.ts-${i}`);
    }
  });

  test("a tsc-hit file counts as linter-hit as well", () => {
    const parsed = hunksInGitOrder([
      ["src/a-first.ts", 20],
      ["src/z-last.ts", 4],
    ]);
    const { section } = buildToolOutputSection(
      results({
        parsed,
        tsc: [
          {
            file: "src/z-last.ts",
            line: 9,
            col: 2,
            severity: "error",
            code: "TS2345",
            message: "Argument of type 'string' is not assignable",
          },
        ],
      }),
    );

    expect(section).toContain("+new-src/z-last.ts-4");
  });

  test("eslint's ABSOLUTE paths still match repo-relative diff paths", () => {
    // This is the shape the real runner produces: `run-eslint.ts` records
    // `fileResult.filePath`, which eslint reports absolute. An equality-only
    // match would silently never fire, and nothing downstream would say so.
    const parsed = hunksInGitOrder([
      ["src/a-first.ts", 20],
      ["src/z-last.ts", 5],
    ]);
    const { section } = buildToolOutputSection(
      results({
        parsed,
        eslint: [
          {
            file: "/Users/someone/Projects/siltpoke/src/z-last.ts",
            line: 3,
            col: 1,
            severity: "error",
            ruleId: "no-unused-vars",
            message: "'x' is defined but never used",
          },
        ],
      }),
    );

    for (let i = 1; i <= 5; i++) {
      expect(section).toContain(`+new-src/z-last.ts-${i}`);
    }
  });

  test("a linter path does NOT match a merely similar filename in another directory", () => {
    const parsed = hunksInGitOrder([
      ["src/a/index.ts", 20],
      ["src/b/index.ts", 5],
    ]);
    // Flags src/a/index.ts only. src/b/index.ts must not be promoted by
    // sharing a basename — that would make the ranking noise.
    const { kept } = selectHunksForBudget(parsed, { linterFiles: ["src/a/index.ts"] });
    expect(kept.every((h) => h.file === "src/a/index.ts")).toBe(true);
  });

  test("a BARE linter filename does not promote every file with that basename", () => {
    // `linterFiles` is caller-supplied on an exported function; nothing types
    // the entries as having directories. A bare `index.ts` must not make the
    // shorter-path arm degenerate into a basename match.
    // The fixture is ordered so the bug would CHANGE the answer: the two
    // `index.ts` files come LAST in git order, so they only reach the prompt
    // if something promoted them. A fixture where they already sorted first
    // would pass either way and prove nothing.
    const parsed = hunksInGitOrder([
      ["src/a-other.ts", 20],
      ["src/z1/index.ts", 5],
      ["src/z2/index.ts", 5],
    ]);
    const { kept } = selectHunksForBudget(parsed, { linterFiles: ["index.ts"] });
    expect(new Set(kept.map((h) => h.file))).toEqual(new Set(["src/a-other.ts"]));
  });

  test("a SHORTER linter path with a directory still matches (tsc emits tsconfig-relative)", () => {
    const parsed = hunksInGitOrder([
      ["packages/app/src/a-first.ts", 20],
      ["packages/app/src/z-last.ts", 5],
    ]);
    const { kept } = selectHunksForBudget(parsed, { linterFiles: ["src/z-last.ts"] });
    expect(kept.filter((h) => h.file === "packages/app/src/z-last.ts").length).toBe(5);
  });

  test("git's own order is the third key — it is preserved, not reversed", () => {
    // Without this, reversing `a.index - b.index` leaves the whole suite green
    // while changing WHICH 20 source hunks a still-partial diff shows.
    const parsed = hunksInGitOrder([["src/a.ts", 30]]);
    const { kept } = selectHunksForBudget(parsed);
    expect(kept.map((h) => h.newStart)).toEqual(Array.from({ length: 20 }, (_, i) => i + 1));
  });

  test("the antigravity plugin mirror is treated as generated output", () => {
    // The path must NOT also sit under `dist/`, or the `dist` alternative
    // catches it and this test passes with the `.antigravity-plugin` rule
    // deleted — measured, not assumed. `hooks/agy-stop.sh` is copied there by
    // `scripts/build-dist.ts`, so it is generated and nothing else matches it.
    const parsed = hunksInGitOrder([
      [".antigravity-plugin/hooks/agy-stop.sh", 25],
      ["src/critic/run-critic.ts", 4],
    ]);
    const { kept } = selectHunksForBudget(parsed);
    expect(kept.filter((h) => h.file === "src/critic/run-critic.ts").length).toBe(4);
    expect(kept.filter((h) => h.file === ".antigravity-plugin/hooks/agy-stop.sh").length).toBe(16);
  });

  test("a BARE DIFF path is not promoted by a linter hit on the same basename elsewhere", () => {
    // The mirror of the bare-linter-entry case, and it shipped unguarded in
    // #626: a repo-root file really does produce a bare diff path, and
    // `p.endsWith("/" + target)` had no anchor on `target`.
    const parsed = hunksInGitOrder([
      ["src/a-other.ts", 20],
      ["index.ts", 5],
    ]);
    const { kept } = selectHunksForBudget(parsed, { linterFiles: ["src/index.ts"] });
    expect(new Set(kept.map((h) => h.file))).toEqual(new Set(["src/a-other.ts"]));
  });

  test("the same holds for eslint's absolute paths", () => {
    const parsed = hunksInGitOrder([
      ["src/a-other.ts", 20],
      ["index.ts", 5],
    ]);
    const { kept } = selectHunksForBudget(parsed, {
      linterFiles: ["/Users/someone/repo/src/index.ts"],
    });
    expect(new Set(kept.map((h) => h.file))).toEqual(new Set(["src/a-other.ts"]));
  });

  test("agent config under .claude/ does not starve source", () => {
    // Named in #626's commit message as one of the three offenders and then
    // not demoted; most of `.claude/` is markdown, which hid the gap behind
    // DOC_PATH_RE. `settings.json` is the member that was not caught.
    const parsed = hunksInGitOrder([
      [".claude/settings.json", 20],
      ["src/foo.ts", 5],
    ]);
    const { kept } = selectHunksForBudget(parsed);
    expect(kept.filter((h) => h.file === "src/foo.ts").length).toBe(5);
  });

  test("`.claude-plugin/` is NOT demoted — in this repo it is shipped surface", () => {
    const parsed = hunksInGitOrder([
      [".claude-plugin/plugin.json", 20],
      ["src/foo.ts", 5],
    ]);
    const { kept } = selectHunksForBudget(parsed);
    // Same tier, so git's order decides and the plugin file keeps its slots.
    expect(kept.filter((h) => h.file === ".claude-plugin/plugin.json").length).toBe(20);
  });

  test("the source tier beats a linter hit: a linted dist/ file does not displace source", () => {
    const parsed = hunksInGitOrder([
      ["dist/siltpoke-cli.js", 25],
      ["src/critic/run-critic.ts", 4],
    ]);
    const { section } = buildToolOutputSection(
      results({
        parsed,
        eslint: [
          {
            file: "dist/siltpoke-cli.js",
            line: 1,
            col: 1,
            severity: "error",
            ruleId: "no-undef",
            message: "'x' is not defined",
          },
        ],
      }),
    );

    expect(section).toContain("+new-src/critic/run-critic.ts-4");
  });

  test("partial coverage is declared with real counts and the buckets that were cut", () => {
    const parsed = hunksInGitOrder([
      ["dist/siltpoke-cli.js", 25],
      ["src/critic/run-critic.ts", 5],
    ]);
    const { section } = buildToolOutputSection(results({ parsed }));

    expect(section).toMatch(/20 of 30 hunks/i);
    expect(section).toMatch(/generated/i);
    // The declaration must land in a field the schema always requires.
    expect(section).toContain("reasoning");
  });

  test("the coverage notice is kept OUT of the evidence-guard's citation corpus", () => {
    // The guard's only test is "does this snippet appear verbatim in the
    // corpus" (evidence-guard.ts reasonItemFails). Every other byte of the
    // section is tool-derived, so passing that test means a tool really said
    // it. The notice is siltpoke's own prose and is quotable at snippet
    // length, so leaving it in would let a critique cite `Not shown: 5
    // generated.` against real code and be stamped `verified`.
    const parsed = hunksInGitOrder([
      ["dist/siltpoke-cli.js", 25],
      ["src/critic/run-critic.ts", 5],
    ]);
    const { section, citationSection } = buildToolOutputSection(results({ parsed }));

    expect(section).toMatch(/Partial diff/);
    expect(citationSection).not.toMatch(/Partial diff/);
    expect(citationSection).not.toMatch(/Not shown:/);
    expect(citationSection).not.toMatch(/ranked source-first/);
    expect(citationSection).not.toMatch(/hunks omitted/);

    // …while everything a critique may legitimately cite is still there.
    expect(citationSection).toContain("+new-src/critic/run-critic.ts-1");
    expect(citationSection).toContain("#### src/critic/run-critic.ts");
    expect(citationSection).toContain("### git diff (changes)");
  });

  test("citationSection equals section when nothing was omitted", () => {
    const parsed = hunksInGitOrder([["src/critic/run-critic.ts", 4]]);
    const { section, citationSection } = buildToolOutputSection(results({ parsed }));
    expect(citationSection).toBe(section);
  });

  test("no coverage warning when everything fits", () => {
    const parsed = hunksInGitOrder([["src/critic/run-critic.ts", 4]]);
    const { section } = buildToolOutputSection(results({ parsed }));

    expect(section).not.toMatch(/partial diff/i);
    expect(section).not.toMatch(/hunks omitted/i);
  });

  test("the budget is NOT raised — 20 hunks reach the prompt, no more", () => {
    expect(GIT_DIFF_HUNK_BUDGET).toBe(20);
    const parsed = hunksInGitOrder([["src/critic/run-critic.ts", 50]]);
    const { kept, omitted } = selectHunksForBudget(parsed);
    expect(kept.length).toBe(20);
    expect(omitted.length).toBe(30);
  });

  test("selection is deterministic and source-first", () => {
    const parsed = hunksInGitOrder([
      ["docs/a.md", 5],
      ["dist/b.js", 5],
      ["src/c.ts", 5],
      ["tests/d.test.ts", 5],
    ]);
    const a = selectHunksForBudget(parsed).kept.map((h) => `${h.file}:${h.newStart}`);
    const b = selectHunksForBudget(parsed).kept.map((h) => `${h.file}:${h.newStart}`);
    expect(a).toEqual(b);
    expect(a.slice(0, 5).every((k) => k.startsWith("src/"))).toBe(true);
    expect(a.slice(5, 10).every((k) => k.startsWith("tests/"))).toBe(true);
  });

  test("hunks of one file stay contiguous under a single heading after ranking", () => {
    const parsed = hunksInGitOrder([
      ["src/a.ts", 2],
      ["dist/x.js", 2],
      ["src/b.ts", 2],
    ]);
    const { section } = buildToolOutputSection(results({ parsed }));
    const headings = [...section.matchAll(/^#### (.+)$/gm)].map((m) => m[1]);
    expect(headings).toEqual([...new Set(headings)]);
  });

  test("selectHunksForBudget does not mutate its input", () => {
    const parsed = hunksInGitOrder([
      ["dist/x.js", 3],
      ["src/a.ts", 3],
    ]);
    const before = parsed.map((h) => `${h.file}:${h.newStart}`);
    selectHunksForBudget(parsed);
    expect(parsed.map((h) => `${h.file}:${h.newStart}`)).toEqual(before);
  });
});
