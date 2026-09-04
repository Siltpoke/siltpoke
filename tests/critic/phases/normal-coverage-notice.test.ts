// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
// Copyright (c) 2026 Jiaqi Duan
/**
 * The partial-coverage notice must reach the Brain's prompt and must NOT reach
 * the evidence-guard's citation corpus.
 *
 * WHY THIS EXISTS. The guard's whole test is "does this snippet appear
 * verbatim in the corpus" (`evidence-guard.ts` `reasonItemFails`). Every other
 * byte of the tool section is tool-derived — diff bodies, diagnostics, matched
 * lines — so passing that test means a tool really said it. The coverage
 * notice is the one part siltpoke writes itself, in prose, and it is quotable
 * at snippet length. Left in the corpus, a critique could cite
 * `everything past the budget was CUT` against a real changed file and be
 * stamped `verified` while saying nothing about the code — the fix for one
 * honesty defect opening another.
 *
 * WHY IT DRIVES `runCritic` AND NOT `buildToolOutputSection`. A unit test on
 * the formatter can only assert that the two variants differ; it cannot see
 * which one `phases/normal.ts` hands the guard. Modeled on
 * `normal-reverse-deps.test.ts`, this drives the shared `runCritic()` entry so
 * the assertion walks the wiring a real Stop-hook call takes — swapping
 * `citationSection` back to `section` in `normal.ts` turns this red.
 */
import { describe, expect, test } from "bun:test";
import type { BrainCallResult, CallBrainOptions } from "../../../src/brain/brain";
import type { BrainOutput } from "../../../src/brain/schema";
import type { ProjectCapabilities } from "../../../src/critic/capabilities";
import { type RunCriticDeps, type RunCriticOpts, runCritic } from "../../../src/critic/run-critic";
import type { GitDiffHunk, ToolName, ToolResult } from "../../../src/critic/tools/types";

// A sentence from the notice that does not depend on the hunk counts.
const NOTICE_PHRASE = "everything past the budget was CUT";
// A line that really is in the rendered diff.
const REAL_DIFF_LINE = "+new-src/critic/run-critic.ts-1";

function makeCaps(): ProjectCapabilities {
  return {
    cwd: "/r",
    hasGit: true,
    hasTsc: false,
    hasEslint: false,
    hasRipgrep: false,
    tsconfigPaths: [],
    eslintConfigPaths: [],
    detectedAt: Date.now(),
    configMtimes: {},
  };
}

function makeOpts(): RunCriticOpts {
  return {
    source: "stop-hook",
    cwd: "/r",
    changedFiles: ["src/a/foo.ts"],
    caps: makeCaps(),
    brainContext: {
      personalitySystemPrompt: "You are Siltpoke.",
      memory: null,
      recent: [],
      sessionId: "sess-cov",
      cwd: "/r",
      stateBase: "/r/.siltpoke",
    },
  };
}

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

/** 25 generated + 5 source hunks = over the 20 budget, so the notice fires. */
function overBudgetHunks(): GitDiffHunk[] {
  return [
    ...Array.from({ length: 25 }, (_, i) => hunk("dist/siltpoke-cli.js", i + 1)),
    ...Array.from({ length: 5 }, (_, i) => hunk("src/critic/run-critic.ts", i + 1)),
  ];
}

function makeTools(): Record<ToolName, ToolResult> & {
  securityFindings: never[];
  owaspHints: never[];
  webSearchSources: never[];
} {
  return {
    tsc: {
      tool: "tsc",
      status: "ok",
      parsed: [
        {
          file: "src/a/foo.ts",
          line: 10,
          col: 5,
          severity: "error",
          code: "TS2322",
          message: "Type 'number' is not assignable to type 'string'.",
        },
      ],
      raw: "src/a/foo.ts(10,5): error TS2322: Type 'number' is not assignable.",
    },
    eslint: { tool: "eslint", status: "not_applicable", parsed: [], raw: "" },
    "git-diff": {
      tool: "git-diff",
      status: "ok",
      parsed: overBudgetHunks(),
      raw: rawDiffWithAnOmittedFile(),
    },
    ripgrep: { tool: "ripgrep", status: "ok", parsed: [], raw: "" },
    securityFindings: [],
    owaspHints: [],
    webSearchSources: [],
  };
}

function makeBrainOutput(snippet: string): BrainOutput {
  return {
    mood: "annoyed",
    pose: "arms_crossed",
    bubble_short: "Found a type error",
    bubble_long: "You have a type mismatch in foo.ts.",
    critique_for_claude: "src/a/foo.ts line 10 has a type error.",
    severity: "medium",
    confidence: "high",
    xp_earned_events: [],
    // file is a changed file, so the file-check always passes and the SNIPPET
    // check is the only thing under test.
    evidence: [{ tool: "git-diff", file: "src/a/foo.ts", line: 1, snippet }],
  };
}

function makeDeps(
  snippet: string,
  capture: { prompt: string },
): RunCriticDeps {
  return {
    runToolsFn: async () => makeTools(),
    callBrainFn: async (opts: CallBrainOptions): Promise<BrainCallResult> => {
      capture.prompt = opts.systemPrompt;
      return {
        output: makeBrainOutput(snippet),
        usage: {
          cache_creation_input_tokens: 0,
          cache_read_input_tokens: 0,
          input_tokens: 100,
          output_tokens: 50,
          total_cost_usd: 0,
        },
      };
    },
    writeCritiqueFn: async () => ({ id: "c-cov", path: "/r" }),
  };
}

/**
 * A raw diff whose SECOND file is guaranteed to be cut by the budget. The
 * first file alone fills every slot, so `omitted-only.ts` never reaches the
 * prompt — but its text was in `git diff`'s stdout, which is what the raw
 * evidence corpus carries.
 */
const OMITTED_ONLY_LINE = "+const neverShownToTheReviewer = 1;";
function rawDiffWithAnOmittedFile(): string {
  const shown = Array.from(
    { length: 25 },
    (_, i) =>
      `@@ -${i + 1},1 +${i + 1},1 @@\n-old-src/critic/run-critic.ts-${i + 1}\n+new-src/critic/run-critic.ts-${i + 1}`,
  ).join("\n");
  return [
    "diff --git a/src/critic/run-critic.ts b/src/critic/run-critic.ts",
    "--- a/src/critic/run-critic.ts",
    "+++ b/src/critic/run-critic.ts",
    shown,
    "diff --git a/src/omitted-only.ts b/src/omitted-only.ts",
    "--- a/src/omitted-only.ts",
    "+++ b/src/omitted-only.ts",
    "@@ -1,1 +1,1 @@",
    "-const gone = 0;",
    OMITTED_ONLY_LINE,
  ].join("\n");
}

describe("runCritic — partial-coverage notice vs the evidence guard", () => {
  test("POSITIVE CONTROL: a real diff line still verifies", async () => {
    // Without this, a passing negative case below would be indistinguishable
    // from "the diff never reached the corpus at all".
    const capture = { prompt: "" };
    const result = await runCritic(makeOpts(), makeDeps(REAL_DIFF_LINE, capture));

    expect(capture.prompt).toContain(REAL_DIFF_LINE);
    expect(result.decision).toBe("NORMAL");
    if (result.decision === "NORMAL") {
      expect(result.evidenceLabel).toBe("verified");
      expect(result.unverifiedCount).toBe(0);
    }
  });

  test("a file the budget cut is NOT citable, even though git printed it", async () => {
    // The other half of the notice's instruction ("do not assert a file is
    // correct that was never shown to you"). `evidenceCorpus` carries each
    // tool's untruncated stdout, so before this the FULL diff — every cut hunk
    // included — was verbatim-present and therefore verifiable. The notice
    // said one thing and the guard permitted the opposite.
    const capture = { prompt: "" };
    const result = await runCritic(makeOpts(), makeDeps(OMITTED_ONLY_LINE, capture));

    // The file's CONTENT really was cut. Its NAME still reaches the prompt via
    // the Haiku diff-summary pre-pass ("Key changes"), which lists every
    // changed file regardless of the hunk budget — so asserting the name is
    // absent would be asserting something false. What must be absent, and is,
    // is the changed line itself.
    expect(capture.prompt).not.toContain(OMITTED_ONLY_LINE);
    // …and citing its text is not accepted as evidence.
    expect(result.decision).toBe("NORMAL");
    if (result.decision === "NORMAL") {
      expect(result.evidenceLabel).toBe("none_verified");
      expect(result.unverifiedCount).toBe(1);
      expect(result.critique.evidence).toEqual([]);
    }
  });

  test("the notice is IN the prompt and OUT of the corpus — citing it is dropped", async () => {
    const capture = { prompt: "" };
    const result = await runCritic(makeOpts(), makeDeps(NOTICE_PHRASE, capture));

    // (a) The Brain really was shown the notice — otherwise the drop below
    //     would prove nothing.
    expect(capture.prompt).toContain(NOTICE_PHRASE);
    expect(capture.prompt).toContain("Partial diff");

    // (b) …and citing it back is not accepted as evidence.
    expect(result.decision).toBe("NORMAL");
    if (result.decision === "NORMAL") {
      expect(result.evidenceLabel).toBe("none_verified");
      expect(result.unverifiedCount).toBe(1);
      expect(result.critique.evidence).toEqual([]);
    }
  });
});
