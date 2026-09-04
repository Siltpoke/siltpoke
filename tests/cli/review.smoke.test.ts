/**
 * Automated smoke tests — Review CLI fixture-based smoke.
 *
 * Coverage:
 *   1. Happy path: temp TS project + tsc error + runReview() → exit 0, critique in archive, stdout has evidence
 *   2. --base main: branch with new commits + runReview --base main → scope respected (main...HEAD in output)
 *   3. Empty diff bail: clean tree → exit 0 with "nothing to review"
 *   4. Guard reject: Brain emits fabricated snippet → exit 2
 *
 * Same DI pattern as review.test.ts. Real git is used when available.
 * eslint/rg availability is not required — tool output is stubbed via runToolsFn.
 */

import { test, expect, beforeEach, afterEach, describe } from "bun:test";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnWithTimeout } from "../../src/critic/spawn";
import { runReview } from "../../src/cli/review";
import type { RunCriticDeps } from "../../src/critic/run-critic";
import type { BrainOutput } from "../../src/brain/schema";
import type { CallBrainOptions, BrainCallResult } from "../../src/brain/brain";
import type { ToolName, ToolResult } from "../../src/critic/tools/types";

// ---------------------------------------------------------------------------
// Tool availability probes
// ---------------------------------------------------------------------------

async function checkGitReachable(): Promise<boolean> {
  try {
    const r = await spawnWithTimeout({
      argv: ["git", "--version"],
      cwd: tmpdir(),
      timeoutMs: 3_000,
    });
    return !r.timedOut && r.exitCode === 0;
  } catch {
    return false;
  }
}

const gitReachable = await checkGitReachable();

// ---------------------------------------------------------------------------
// Git helpers
// ---------------------------------------------------------------------------

function spawnGitSync(args: string[], cwd: string): void {
  const { spawnSync } = require("node:child_process") as typeof import("child_process");
  spawnSync("git", args, { cwd, stdio: "pipe" });
}

async function initGitRepo(dir: string, dirty = false): Promise<void> {
  spawnGitSync(["init", "-b", "main"], dir);
  spawnGitSync(["config", "user.email", "smoke@test.com"], dir);
  spawnGitSync(["config", "user.name", "Smoke Test"], dir);
  writeFileSync(join(dir, "README.md"), "# smoke\n");
  spawnGitSync(["add", "."], dir);
  spawnGitSync(
    ["-c", "commit.gpgsign=false", "commit", "-m", "init"],
    dir,
  );
  if (dirty) {
    writeFileSync(join(dir, "README.md"), "# smoke\nchanged\n");
    spawnGitSync(["add", "."], dir);
  }
}

async function initGitRepoWithBranch(dir: string): Promise<void> {
  spawnGitSync(["init", "-b", "main"], dir);
  spawnGitSync(["config", "user.email", "smoke@test.com"], dir);
  spawnGitSync(["config", "user.name", "Smoke Test"], dir);
  writeFileSync(join(dir, "README.md"), "# smoke\n");
  spawnGitSync(["add", "."], dir);
  spawnGitSync(
    ["-c", "commit.gpgsign=false", "commit", "-m", "initial commit on main"],
    dir,
  );
  spawnGitSync(["checkout", "-b", "feat"], dir);
  mkdirSync(join(dir, "src"), { recursive: true });
  writeFileSync(join(dir, "src/new.ts"), "export const y = 2;\n");
  spawnGitSync(["add", "."], dir);
  spawnGitSync(
    ["-c", "commit.gpgsign=false", "commit", "-m", "add new file"],
    dir,
  );
}

// ---------------------------------------------------------------------------
// Stub helpers
// ---------------------------------------------------------------------------

const REAL_SNIPPET = "const x: string = badValue;";

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

function makeNotApplicable(tool: ToolName): ToolResult {
  switch (tool) {
    case "tsc": return { tool: "tsc", status: "not_applicable", parsed: [], raw: "" };
    case "eslint": return { tool: "eslint", status: "not_applicable", parsed: [], raw: "" };
    case "git-diff": return { tool: "git-diff", status: "not_applicable", parsed: [], raw: "" };
    case "ripgrep": return { tool: "ripgrep", status: "not_applicable", parsed: [], raw: "" };
  }
}

/** Stub runToolsFn that returns NORMAL-path result (tsc error + git-diff hunk). */
function makeNormalToolsFn(): RunCriticDeps["runToolsFn"] {
  return async () => ({
    tsc: {
      tool: "tsc" as const,
      status: "ok" as const,
      parsed: [
        {
          file: "src/error.ts",
          line: 1,
          col: 7,
          severity: "error" as const,
          code: "TS2322",
          message: "Type 'string' is not assignable to type 'number'.",
        },
      ],
      raw: `src/error.ts(1,7): error TS2322: Type 'string' is not assignable to type 'number'.\n${REAL_SNIPPET}`,
    },
    eslint: makeNotApplicable("eslint"),
    "git-diff": {
      tool: "git-diff" as const,
      status: "ok" as const,
      parsed: [
        {
          file: "src/error.ts",
          oldStart: 1,
          oldLines: 1,
          newStart: 1,
          newLines: 1,
          header: "@@ -1,1 +1,1 @@",
          body: `-old line\n+${REAL_SNIPPET}`,
        },
      ],
      raw: `diff --git a/src/error.ts b/src/error.ts\n--- a/src/error.ts\n+++ b/src/error.ts\n@@ -1,1 +1,1 @@\n-old line\n+${REAL_SNIPPET}`,
    },
    ripgrep: { tool: "ripgrep" as const, status: "ok" as const, parsed: [], raw: "" },
    securityFindings: [],
    owaspHints: [],
        webSearchSources: [],
  });
}

function makeNormalBrainOutput(): BrainOutput {
  return {
    mood: "annoyed",
    pose: "arms_crossed",
    bubble_short: "You have a type error that needs fixing.",
    bubble_long: "The type error in src/error.ts is blocking clean compilation.",
    critique_for_claude: "Fix TS2322 in src/error.ts line 1.",
    severity: "medium",
    confidence: "high",
    xp_earned_events: [],
    evidence: [
      {
        tool: "tsc",
        file: "src/error.ts",
        line: 1,
        snippet: REAL_SNIPPET,
      },
    ],
  };
}

// ---------------------------------------------------------------------------
// Shared fixtures
// ---------------------------------------------------------------------------

let tmp: string;
let cwd: string;
let homeBase: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "siltpoke-rev-smoke-"));
  cwd = join(tmp, "project");
  homeBase = join(tmp, ".siltpoke");
  mkdirSync(cwd, { recursive: true });
  mkdirSync(homeBase, { recursive: true });
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Scenario 1: Happy path — tsc error + runReview() → exit 0 + evidence in output
// ---------------------------------------------------------------------------

describe("Review smoke: happy path — NORMAL accepted", () => {
  test.if(gitReachable)(
    "dirty TS project with tsc error → exit 0, evidence in stdout, critique archived",
    async () => {
      await initGitRepo(cwd, true);
      mkdirSync(join(cwd, "src"), { recursive: true });
      writeFileSync(join(cwd, "tsconfig.json"), JSON.stringify({ compilerOptions: { strict: true } }));
      writeFileSync(join(cwd, "src/error.ts"), `${REAL_SNIPPET}\n`);

      const lines: string[] = [];
      let writeCalled = false;
      let archivePath = "";

      const result = await runReview({
        cwd,
        homeBase,
        output: (msg) => lines.push(msg),
        deps: {
          runToolsFn: makeNormalToolsFn(),
          callBrainFn: makeBrainFn(makeNormalBrainOutput()),
          writeCritiqueFn: async (basePath, _input) => {
            writeCalled = true;
            archivePath = join(basePath, "critiques", "archive", "c-smoke-happy.md");
            return { id: "c-smoke-happy", path: archivePath };
          },
        },
      });

      expect(result.exitCode).toBe(0);
      expect(writeCalled).toBe(true);

      // Evidence should appear in output
      const evidenceLine = lines.find(
        (l) => l.includes("tsc") && l.includes("src/error.ts"),
      );
      expect(evidenceLine).toBeDefined();

      // bubble_short should appear in output
      const bubbleLine = lines.find((l) =>
        l.includes("type error"),
      );
      expect(bubbleLine).toBeDefined();

      // Archive path should be in the output
      const archiveLine = lines.find((l) => l.includes("critique saved to"));
      expect(archiveLine).toBeDefined();
    },
  );
});

// ---------------------------------------------------------------------------
// Scenario 2: --base main — scope respected
// ---------------------------------------------------------------------------

describe("Review smoke: --base main scope", () => {
  test.if(gitReachable)(
    "--base main: branch with new commits → main...HEAD in scope output",
    async () => {
      await initGitRepoWithBranch(cwd);

      const capturedFiles: { files: string[] } = { files: [] };
      const trackingToolsFn: RunCriticDeps["runToolsFn"] = async (opts) => {
        capturedFiles.files = opts.changedFiles;
        return {
          tsc: { tool: "tsc" as const, status: "ok" as const, parsed: [], raw: "" },
          eslint: makeNotApplicable("eslint"),
          "git-diff": {
            tool: "git-diff" as const,
            status: "ok" as const,
            parsed: [
              {
                file: "src/new.ts",
                oldStart: 0,
                oldLines: 0,
                newStart: 1,
                newLines: 1,
                header: "@@ -0,0 +1,1 @@",
                body: "+export const y = 2;\n",
              },
            ],
            raw: "diff --git a/src/new.ts b/src/new.ts\n--- /dev/null\n+++ b/src/new.ts\n@@ -0,0 +1,1 @@\n+export const y = 2;\n",
          },
          ripgrep: { tool: "ripgrep" as const, status: "ok" as const, parsed: [], raw: "" },
          securityFindings: [],
          owaspHints: [],
        webSearchSources: [],
        };
      };

      const passiveOutput: BrainOutput = {
        mood: "happy",
        pose: "wave",
        bubble_short: "Clean addition, looks good.",
        bubble_long: "",
        critique_for_claude: "",
        severity: "info",
        confidence: "high",
        xp_earned_events: [],
        evidence: [],
      };

      const lines: string[] = [];
      await runReview({
        cwd,
        homeBase,
        base: "main",
        output: (msg) => lines.push(msg),
        deps: {
          runToolsFn: trackingToolsFn,
          callBrainFn: makeBrainFn(passiveOutput),
          writeCritiqueFn: async (_bp, _i) => ({ id: "c-scope", path: "/tmp" }),
        },
      });

      // Scope description should include "main...HEAD"
      const scopeLine = lines.find((l) => l.includes("main...HEAD"));
      expect(scopeLine).toBeDefined();
    },
  );
});

// ---------------------------------------------------------------------------
// Scenario 3: Empty diff bail — clean tree → exit 0 + "nothing to review"
// ---------------------------------------------------------------------------

describe("Review smoke: empty diff bail", () => {
  test.if(gitReachable)(
    "clean git tree → exit 0 + 'nothing to review' message",
    async () => {
      await initGitRepo(cwd, false); // clean tree

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
              output: makeNormalBrainOutput(),
              usage: {
                cache_creation_input_tokens: 0,
                cache_read_input_tokens: 0,
                input_tokens: 0,
                output_tokens: 0,
                total_cost_usd: 0,
              },
            };
          },
        },
      });

      expect(result.exitCode).toBe(0);
      expect(lines.some((l) => l.includes("nothing to review"))).toBe(true);
      // Brain should NOT be called for empty diff
      expect(brainCalled).toBe(false);
    },
  );
});

// ---------------------------------------------------------------------------
// Scenario 4: Guard reject — fabricated snippet → exit 2
// ---------------------------------------------------------------------------

describe("Review smoke: unverified evidence", () => {
  // Was "guard reject → exit 2". The rejection is gone: a fabricated citation
  // is dropped and the review is printed with an "unconfirmed" mark above it.
  test.if(gitReachable)(
    "Brain returns fabricated snippet not in tool raw output → marked unconfirmed, exit 0",
    async () => {
      await initGitRepo(cwd, true);

      const lines: string[] = [];

      const fabricatedOutput: BrainOutput = {
        mood: "annoyed",
        pose: "arms_crossed",
        bubble_short: "Problems detected",
        bubble_long: "",
        critique_for_claude: "Fix the hallucinated issue",
        severity: "medium",
        confidence: "high",
        xp_earned_events: [],
        evidence: [
          {
            tool: "tsc",
            file: "src/error.ts",
            line: 1,
            // This snippet is NOT in the raw tool output — fabricated hallucination
            snippet: "this is a completely fabricated snippet not from any tool output!!",
          },
        ],
      };

      const result = await runReview({
        cwd,
        homeBase,
        output: (msg) => lines.push(msg),
        deps: {
          runToolsFn: makeNormalToolsFn(),
          callBrainFn: makeBrainFn(fabricatedOutput),
          writeCritiqueFn: async (_bp, _i) => ({ id: "c-smoke-fab", path: "/tmp" }),
        },
      });

      expect(result.exitCode).toBe(0);
      expect(lines.some((l) => l.includes("unconfirmed"))).toBe(true);
      // The review survives the bad citation — the half that changed.
      expect(lines.some((l) => l.includes("Fix the hallucinated issue"))).toBe(true);
      // The fabricated snippet does not — the half that did not.
      expect(
        lines.some((l) =>
          l.includes("this is a completely fabricated snippet not from any tool output!!"),
        ),
      ).toBe(false);
    },
  );
});
