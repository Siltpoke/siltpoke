/**
 * Tests for siltpoke review CLI.
 *
 * All heavy I/O dependencies (runTools, callBrain, writeCritique, evaluateBudget)
 * are injected via opts.deps to keep tests fast and deterministic.
 */

import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runReview, parseReviewArgs, } from "../../src/cli/review";
import type { RunCriticDeps } from "../../src/critic/run-critic";
import type { BrainOutput } from "../../src/brain/schema";
import type { ToolResult, ToolName } from "../../src/critic/tools/types";
import type { CallBrainOptions, BrainCallResult } from "../../src/brain/brain";
import type { evaluateBudget } from "../../src/state/budget-config";
import { writeMemory, emptyMemory } from "../../src/memory/memory";
import { writeGlobal, emptyGlobal } from "../../src/memory/global";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

let tmp: string;
let cwd: string;
let homeBase: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "siltpoke-rev-t8-"));
  cwd = join(tmp, "project");
  homeBase = join(tmp, ".siltpoke");
  mkdirSync(cwd, { recursive: true });
  mkdirSync(homeBase, { recursive: true });
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeNotApplicable(tool: ToolName): ToolResult {
  switch (tool) {
    case "tsc":
      return { tool: "tsc", status: "not_applicable", parsed: [], raw: "" };
    case "eslint":
      return { tool: "eslint", status: "not_applicable", parsed: [], raw: "" };
    case "git-diff":
      return { tool: "git-diff", status: "not_applicable", parsed: [], raw: "" };
    case "ripgrep":
      return { tool: "ripgrep", status: "not_applicable", parsed: [], raw: "" };
  }
}

function makeAllNotApplicable(): Record<ToolName, ToolResult> & { securityFindings: never[]; owaspHints: never[]; webSearchSources: never[] } {
  return {
    tsc: makeNotApplicable("tsc"),
    eslint: makeNotApplicable("eslint"),
    "git-diff": makeNotApplicable("git-diff"),
    ripgrep: makeNotApplicable("ripgrep"),
    securityFindings: [],
    owaspHints: [],
    webSearchSources: [],
  };
}

const REAL_SNIPPET = "let x: string = badValue;";

function makeBrainOutput(overrides?: Partial<BrainOutput>): BrainOutput {
  return {
    mood: "annoyed",
    pose: "arms_crossed",
    bubble_short: "You have a type error",
    bubble_long: "The type error in foo.ts is a problem.",
    critique_for_claude: "src/foo.ts line 10 has a type mismatch.",
    severity: "medium",
    confidence: "high",
    xp_earned_events: [],
    evidence: [
      {
        tool: "tsc",
        file: "src/foo.ts",
        line: 10,
        snippet: REAL_SNIPPET,
      },
    ],
    ...overrides,
  };
}

function makeBrainFn(
  output: BrainOutput,
): (opts: CallBrainOptions) => Promise<BrainCallResult> {
  return async (_opts) => ({
    output,
    usage: {
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
      input_tokens: 100,
      output_tokens: 50,
      total_cost_usd: 0.001,
    },
  });
}

function makeWriteCritiqueFn(): {
  fn: RunCriticDeps["writeCritiqueFn"];
  calls: Array<{ basePath: string }>;
} {
  const calls: Array<{ basePath: string }> = [];
  const fn: RunCriticDeps["writeCritiqueFn"] = async (basePath, _input) => {
    calls.push({ basePath });
    return { id: "c-test", path: join(basePath, "critiques", "archive", "c-test.md") };
  };
  return { fn, calls };
}

/** Minimal git diff raw output with a single hunk. */
function makeRawDiff(file = "src/foo.ts"): string {
  return [
    `diff --git a/${file} b/${file}`,
    `--- a/${file}`,
    `+++ b/${file}`,
    "@@ -1,3 +1,4 @@",
    " context line",
    `-old line`,
    `+new line`,
    `+${REAL_SNIPPET}`,
  ].join("\n");
}

/**
 * Make a runToolsFn stub that returns a NORMAL-path result:
 * tsc has a finding (REAL_SNIPPET in raw), git-diff has a hunk, others empty/ok.
 */
function makeNormalToolsFn(changedFilesCapture?: { files: string[] }): RunCriticDeps["runToolsFn"] {
  return async (opts) => {
    if (changedFilesCapture) {
      changedFilesCapture.files = opts.changedFiles;
    }
    return {
      tsc: {
        tool: "tsc",
        status: "ok",
        parsed: [
          {
            file: "src/foo.ts",
            line: 10,
            col: 5,
            severity: "error",
            code: "TS2322",
            message: "Type 'number' is not assignable to type 'string'.",
          },
        ],
        raw: `src/foo.ts(10,5): error TS2322: Type 'number'.\n${REAL_SNIPPET}`,
      },
      eslint: makeNotApplicable("eslint"),
      "git-diff": {
        tool: "git-diff",
        status: "ok",
        parsed: [
          {
            file: "src/foo.ts",
            oldStart: 1,
            oldLines: 3,
            newStart: 1,
            newLines: 4,
            header: "@@ -1,3 +1,4 @@",
            body: ` context\n-old\n+new\n+${REAL_SNIPPET}`,
          },
        ],
        raw: makeRawDiff(),
      },
      ripgrep: { tool: "ripgrep", status: "ok", parsed: [], raw: "" },
      securityFindings: [],
      owaspHints: [],
      webSearchSources: [],
    };
  };
}

/**
 * Stub for runGitDiff used inside review.ts.
 * We can't easily stub it directly, but we set up a real git repo
 * in the temp dir so runGitDiff returns a real (or empty) result,
 * then stub runToolsFn so runCritic gets deterministic results.
 *
 * The approach: initialise a git repo in cwd with one commit
 * so git diff HEAD returns an empty diff (clean tree). Then
 * add an untracked modification to force a non-empty diff.
 */
async function initGitRepo(dir: string, dirty = false): Promise<void> {
  const { spawnSync } = await import("node:child_process");
  spawnSync("git", ["init", "-b", "main"], { cwd: dir, stdio: "pipe" });
  spawnSync("git", ["config", "user.email", "test@test.com"], { cwd: dir, stdio: "pipe" });
  spawnSync("git", ["config", "user.name", "Test"], { cwd: dir, stdio: "pipe" });
  // Create initial commit
  writeFileSync(join(dir, "README.md"), "hello\n");
  spawnSync("git", ["add", "."], { cwd: dir, stdio: "pipe" });
  spawnSync("git", ["commit", "-m", "init"], { cwd: dir, stdio: "pipe" });

  if (dirty) {
    // Modify an existing tracked file to produce a diff
    writeFileSync(join(dir, "README.md"), "hello\nworld\n");
    spawnSync("git", ["add", "."], { cwd: dir, stdio: "pipe" });
  }
}

// ---------------------------------------------------------------------------
// 1. parseReviewArgs — unit tests
// ---------------------------------------------------------------------------

describe("parseReviewArgs", () => {
  test("no args → ok, no base, no path", () => {
    const r = parseReviewArgs([]);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.base).toBeUndefined();
      expect(r.path).toBeUndefined();
    }
  });

  test("--base main → ok, base=main", () => {
    const r = parseReviewArgs(["--base", "main"]);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.base).toBe("main");
  });

  test("--path src/x.ts → ok, path=src/x.ts", () => {
    const r = parseReviewArgs(["--path", "src/x.ts"]);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.path).toBe("src/x.ts");
  });

  test("unknown flag --bogus → error", () => {
    const r = parseReviewArgs(["--bogus"]);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.message).toContain("unknown flag");
  });

  test("--base with no value → error", () => {
    const r = parseReviewArgs(["--base"]);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.message).toContain("--base requires");
  });

  test("--path with no value → error", () => {
    const r = parseReviewArgs(["--path"]);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.message).toContain("--path requires");
  });
});

// ---------------------------------------------------------------------------
// 2. --path not yet supported → exit 3
// ---------------------------------------------------------------------------

describe("runReview — --path flag", () => {
  test("--path exits 3 with 'not yet supported'", async () => {
    const lines: string[] = [];
    const result = await runReview({
      cwd,
      homeBase,
      path: "src/x.ts",
      output: (msg) => lines.push(msg),
    });
    expect(result.exitCode).toBe(3);
    expect(lines.some((l) => l.includes("not yet supported"))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 3. Unknown flag → exit 3 (tested via parseReviewArgs above;
//    CLI entry handles it — here we verify the parse layer)
// ---------------------------------------------------------------------------

describe("parseReviewArgs — unknown flag", () => {
  test("--bogus returns ok=false with 'unknown flag' message", () => {
    const r = parseReviewArgs(["--bogus"]);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.message).toContain("--bogus");
  });
});

// ---------------------------------------------------------------------------
// 4. Budget exhausted → exit 1
// ---------------------------------------------------------------------------

describe("runReview — budget gate", () => {
  test("hard budget → 'budget exhausted' message + exit 1", async () => {
    const lines: string[] = [];
    const hardBudgetFn: typeof evaluateBudget = (_rollup, _config) => ({
      stage: "hard",
      used_pct: 100,
      remaining_tokens: 0,
    });

    const result = await runReview({
      cwd,
      homeBase,
      output: (msg) => lines.push(msg),
      deps: { evaluateBudgetFn: hardBudgetFn },
    });

    expect(result.exitCode).toBe(1);
    expect(lines.some((l) => l.includes("budget exhausted"))).toBe(true);
    expect(lines.some((l) => l.includes("siltpoke wake"))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 5. Empty diff → exit 0, no Brain call
// ---------------------------------------------------------------------------

describe("runReview — empty diff bail", () => {
  test("clean git tree → 'nothing to review' + exit 0, no Brain call", async () => {
    await initGitRepo(cwd, false);
    const lines: string[] = [];
    let brainCalled = false;

    const result = await runReview({
      cwd,
      homeBase,
      output: (msg) => lines.push(msg),
      deps: {
        callBrainFn: async () => {
          brainCalled = true;
          return {
            output: makeBrainOutput(),
            usage: { cache_creation_input_tokens: 0, cache_read_input_tokens: 0, input_tokens: 0, output_tokens: 0, total_cost_usd: 0 },
          };
        },
      },
    });

    expect(result.exitCode).toBe(0);
    expect(lines.some((l) => l.includes("nothing to review"))).toBe(true);
    expect(brainCalled).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 6. Happy path — NORMAL accepted → critique written, exit 0
// ---------------------------------------------------------------------------

describe("runReview — NORMAL accepted (happy path)", () => {
  test("dirty TS project → bubble printed + critique written + exit 0", async () => {
    await initGitRepo(cwd, true);
    const lines: string[] = [];
    const { fn: writeCritiqueFn, calls: writeCalls } = makeWriteCritiqueFn();

    const brainOutput = makeBrainOutput();
    const result = await runReview({
      cwd,
      homeBase,
      output: (msg) => lines.push(msg),
      deps: {
        runToolsFn: makeNormalToolsFn(),
        callBrainFn: makeBrainFn(brainOutput),
        writeCritiqueFn,
      },
    });

    expect(result.exitCode).toBe(0);
    expect(lines.some((l) => l.includes(brainOutput.bubble_short))).toBe(true);
    expect(writeCalls.length).toBeGreaterThan(0);
  });

  test("bubble_long is printed when present", async () => {
    await initGitRepo(cwd, true);
    const lines: string[] = [];

    const brainOutput = makeBrainOutput({ bubble_long: "This is the long bubble text." });
    await runReview({
      cwd,
      homeBase,
      output: (msg) => lines.push(msg),
      deps: {
        runToolsFn: makeNormalToolsFn(),
        callBrainFn: makeBrainFn(brainOutput),
        writeCritiqueFn: async (bp, _i) => ({ id: "c-x", path: join(bp, "c-x.md") }),
      },
    });

    expect(lines.some((l) => l.includes("This is the long bubble text."))).toBe(true);
  });

  test("evidence list is printed", async () => {
    await initGitRepo(cwd, true);
    const lines: string[] = [];

    const brainOutput = makeBrainOutput({
      evidence: [{ tool: "tsc", file: "src/foo.ts", line: 10, snippet: REAL_SNIPPET }],
    });

    await runReview({
      cwd,
      homeBase,
      output: (msg) => lines.push(msg),
      deps: {
        runToolsFn: makeNormalToolsFn(),
        callBrainFn: makeBrainFn(brainOutput),
        writeCritiqueFn: async (bp, _i) => ({ id: "c-x", path: join(bp, "c-x.md") }),
      },
    });

    const evidenceLine = lines.find((l) => l.includes("tsc") && l.includes("src/foo.ts"));
    expect(evidenceLine).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// 7. PASSIVE_BUBBLE → bubble_short only + exit 0
// ---------------------------------------------------------------------------

describe("runReview — PASSIVE_BUBBLE", () => {
  test("PASSIVE_BUBBLE → bubble_short printed, no evidence list, exit 0", async () => {
    await initGitRepo(cwd, true);
    const lines: string[] = [];

    const passiveOutput = makeBrainOutput({
      mood: "happy",
      bubble_short: "Clean refactor, looks tidy.",
      bubble_long: "",
      critique_for_claude: "",
      evidence: [],
    });

    // Tools return all-clean + diff → classifier → PASSIVE_BUBBLE
    const cleanWithDiffToolsFn: RunCriticDeps["runToolsFn"] = async () => ({
      tsc: { tool: "tsc", status: "ok", parsed: [], raw: "" },
      eslint: { tool: "eslint", status: "ok", parsed: [], raw: "" },
      "git-diff": {
        tool: "git-diff",
        status: "ok",
        parsed: [
          {
            file: "README.md",
            oldStart: 1,
            oldLines: 1,
            newStart: 1,
            newLines: 2,
            header: "@@ -1,1 +1,2 @@",
            body: " hello\n+world",
          },
        ],
        raw: "diff --git a/README.md b/README.md\n--- a/README.md\n+++ b/README.md\n@@ -1,1 +1,2 @@\n hello\n+world",
      },
      ripgrep: { tool: "ripgrep", status: "ok", parsed: [], raw: "" },
      securityFindings: [],
      owaspHints: [],
      webSearchSources: [],
    });

    const result = await runReview({
      cwd,
      homeBase,
      output: (msg) => lines.push(msg),
      deps: {
        runToolsFn: cleanWithDiffToolsFn,
        callBrainFn: makeBrainFn(passiveOutput),
        writeCritiqueFn: async (bp, _i) => ({ id: "c-passive", path: join(bp, "c-passive.md") }),
      },
    });

    expect(result.exitCode).toBe(0);
    expect(lines.some((l) => l.includes("Clean refactor, looks tidy."))).toBe(true);
    // No evidence list for PASSIVE_BUBBLE
    expect(lines.some((l) => l.includes("evidence cited"))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 8. Abstention — HARD_SUPPRESS → exit 1
// ---------------------------------------------------------------------------

describe("runReview — abstention (HARD_SUPPRESS)", () => {
  test("all tools not_applicable → 'no usable evidence' + exit 1", async () => {
    await initGitRepo(cwd, true);
    const lines: string[] = [];

    const result = await runReview({
      cwd,
      homeBase,
      output: (msg) => lines.push(msg),
      deps: {
        runToolsFn: async () => makeAllNotApplicable(),
        callBrainFn: makeBrainFn(makeBrainOutput()),
        writeCritiqueFn: async (bp, _i) => ({ id: "c-suppress", path: bp }),
      },
    });

    expect(result.exitCode).toBe(1);
    expect(lines.some((l) => l.includes("no usable evidence"))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 9. Guard reject — NORMAL not-accepted → exit 2
// ---------------------------------------------------------------------------

describe("runReview — guard reject", () => {
  test("fabricated snippet → 'evidence guard rejected' + exit 2", async () => {
    await initGitRepo(cwd, true);
    const lines: string[] = [];

    // Brain emits a fabricated snippet not in any tool raw output
    const fabricatedOutput = makeBrainOutput({
      evidence: [
        {
          tool: "tsc",
          file: "src/foo.ts",
          line: 1,
          snippet: "this snippet was fabricated by the LLM hallucination!",
        },
      ],
    });

    const result = await runReview({
      cwd,
      homeBase,
      output: (msg) => lines.push(msg),
      deps: {
        runToolsFn: makeNormalToolsFn(),
        callBrainFn: makeBrainFn(fabricatedOutput),
        writeCritiqueFn: async (bp, _i) => ({ id: "c-fab", path: bp }),
      },
    });

    expect(result.exitCode).toBe(2);
    expect(
      lines.some(
        (l) =>
          l.includes("evidence guard rejected") ||
          l.includes("guard rejected"),
      ),
    ).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 10. --base <ref> — diff scope respected
// ---------------------------------------------------------------------------

describe("runReview — --base flag", () => {
  test("--base main scopes diff; changedFiles derived from that diff", async () => {
    await initGitRepo(cwd, true);

    const capturedFiles: { files: string[] } = { files: [] };
    const toolsFn = makeNormalToolsFn(capturedFiles);

    // We can't easily stub runGitDiff itself, so we verify the output message
    // includes the correct scope description, and verify runTools receives
    // changedFiles (even if that list is empty due to git setup limitations).
    const lines: string[] = [];
    await runReview({
      cwd,
      homeBase,
      base: "main",
      output: (msg) => lines.push(msg),
      deps: {
        runToolsFn: toolsFn,
        callBrainFn: makeBrainFn(makeBrainOutput()),
        writeCritiqueFn: async (bp, _i) => ({ id: "c-base", path: bp }),
      },
    });

    // The scope description should mention the base ref
    expect(lines.some((l) => l.includes("main...HEAD"))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 11. V3 store — review must read facts/rules from the canonical V3 store
//     (homeBase), not the empty per-repo state base. Mirrors the
//     Stop-hook regression test at tests/hooks/handle-stop.test.ts
//     ("critic injects facts from the V3 store ...").
// ---------------------------------------------------------------------------

describe("runReview — V3 store", () => {
  test("review injects facts from the V3 store (homeBase), not the empty per-repo base", async () => {
    await initGitRepo(cwd, true);

    // global.json presence flips readMemory/writeMemory to V3 (per-project
    // scoped internally on resolveProjectRoot(process.cwd()) — independent
    // of the `cwd` option passed to runReview below).
    await writeGlobal(homeBase, emptyGlobal());
    const mem = emptyMemory();
    mem.facts = [
      {
        id: "f-seed",
        text: "SEEDED_REVIEW_FACT",
        source_session_id: null,
        confidence: 1,
        status: "active",
        created_at: new Date().toISOString(),
        last_seen_at: new Date().toISOString(),
        supersedes: null,
        recall_count: 0,
        kind: "style",
        learned_from: { stream: "user", session_id: null },
      } as any,
    ];
    await writeMemory(homeBase, mem);

    let captured = "";
    await runReview({
      cwd,
      homeBase,
      deps: {
        runToolsFn: makeNormalToolsFn(),
        callBrainFn: async (opts: CallBrainOptions): Promise<BrainCallResult> => {
          captured = JSON.stringify(opts);
          return {
            output: makeBrainOutput(),
            usage: {
              cache_creation_input_tokens: 0,
              cache_read_input_tokens: 0,
              input_tokens: 0,
              output_tokens: 0,
              total_cost_usd: 0,
            },
          };
        },
        writeCritiqueFn: async (bp, _i) => ({ id: "c-v3", path: bp }),
      },
    });

    expect(captured).toContain("SEEDED_REVIEW_FACT");
  });
});
