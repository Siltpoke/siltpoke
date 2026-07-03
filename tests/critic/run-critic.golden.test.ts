/**
 * run-critic.golden — characterization snapshot for runCritic().
 *
 * Stubs runToolsFn + callBrainFn + writeCritiqueFn so the pipeline is
 * fully deterministic. Captures:
 *   1. CritiqueInput passed to the writeCritique stub (= what the v1
 *      sidecar markdown would render from).
 *   2. runCritic() return value, with non-deterministic fields stripped
 *      (timing).
 *
 * The two captures are JSON-serialized and pinned to fixtures. Later work
 * refactors must not change these unless intentionally.
 */
import { test, expect } from "bun:test";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { join, dirname } from "node:path";
import {
  runCritic,
  type RunCriticOpts,
  type RunCriticDeps,
  type RunCriticResult,
} from "../../src/critic/run-critic";
import type { ProjectCapabilities } from "../../src/critic/capabilities";
import type { BrainOutput } from "../../src/brain/schema";
import type { ToolName, ToolResult } from "../../src/critic/tools/types";
import type { BrainCallResult } from "../../src/brain/brain";
import type { CritiqueInput } from "../../src/state/critique";

const FIXTURE_DIR = join(import.meta.dir, "fixtures");
const CAPTURE = process.env.R1_GOLDEN_MODE === "capture";

function caps(): ProjectCapabilities {
  return {
    cwd: "/fixture/proj-a",
    hasGit: true,
    hasTsc: false,
    hasEslint: false,
    hasRipgrep: false,
    tsconfigPaths: [],
    eslintConfigPaths: [],
    detectedAt: 0,
    configMtimes: {},
  };
}

function notApplicable(tool: ToolName): ToolResult {
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

function brainOut(overrides?: Partial<BrainOutput>): BrainOutput {
  return {
    mood: "annoyed",
    pose: "arms_crossed",
    bubble_short: "Found a type error",
    bubble_long: "You have a type mismatch in foo.ts.",
    critique_for_claude: "src/foo.ts line 10 has a type error.",
    severity: "medium",
    confidence: "high",
    xp_earned_events: [],
    evidence: [],
    ...overrides,
  };
}

function fakeBrainCall(out: BrainOutput): () => Promise<BrainCallResult> {
  return async () => ({
    output: out,
    usage: {
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
      input_tokens: 100,
      output_tokens: 50,
      total_cost_usd: 0.001,
    },
  });
}

function makeOpts(over?: Partial<RunCriticOpts>): RunCriticOpts {
  return {
    source: "stop-hook",
    cwd: "/fixture/proj-a",
    changedFiles: ["src/foo.ts"],
    caps: caps(),
    brainContext: {
      personalitySystemPrompt: "You are Siltpoke (fixture).",
      memory: null,
      recent: [],
      sessionId: "sess-golden",
      cwd: "/fixture/proj-a",
      stateBase: "/fixture/proj-a/.siltpoke",
    },
    ...over,
  };
}

function stripTiming<R extends RunCriticResult>(r: R): unknown {
  const { timing: _t, ...rest } = r as RunCriticResult & { timing?: unknown };
  return rest;
}

function diffOrCapture(content: string, fixtureName: string): void {
  const fixturePath = join(FIXTURE_DIR, fixtureName);
  if (CAPTURE || !existsSync(fixturePath)) {
    mkdirSync(dirname(fixturePath), { recursive: true });
    writeFileSync(fixturePath, content, "utf8");
    expect(content).toBe(content);
    return;
  }
  const expected = readFileSync(fixturePath, "utf8");
  if (content !== expected) {
    throw new Error(
      `${fixtureName} mismatch.\n` +
        `Fixture: ${fixturePath}\n` +
        `Re-capture with: R1_GOLDEN_MODE=capture bun test tests/critic/run-critic.golden.test.ts`,
    );
  }
  expect(content).toBe(expected);
}

test("golden: runCritic HARD_SUPPRESS path is stable", async () => {
  let captured: CritiqueInput | null = null;
  const deps: RunCriticDeps = {
    runToolsFn: async () => ({
      tsc: notApplicable("tsc"),
      eslint: notApplicable("eslint"),
      "git-diff": notApplicable("git-diff"),
      ripgrep: notApplicable("ripgrep"),
      securityFindings: [],
      owaspHints: [],
      webSearchSources: [],
    }),
    callBrainFn: fakeBrainCall(brainOut()),
    writeCritiqueFn: async (_base, input) => {
      captured = input;
      return { id: "c-hard", path: "/fixture/proj-a/.siltpoke/c-hard.md" };
    },
  };

  const result = await runCritic(makeOpts(), deps);
  const snapshot = JSON.stringify(
    { result: stripTiming(result), critiqueInput: captured },
    null,
    2,
  );
  diffOrCapture(snapshot, "runCritic-HARD_SUPPRESS.json");
});

test("golden: runCritic PASSIVE_BUBBLE path is stable", async () => {
  let captured: CritiqueInput | null = null;
  const passive = brainOut({
    mood: "happy",
    pose: "base",
    bubble_short: "Clean refactor",
    critique_for_claude: "",
    evidence: [],
  });

  const deps: RunCriticDeps = {
    runToolsFn: async () => ({
      tsc: { tool: "tsc", status: "ok", parsed: [], raw: "" },
      eslint: { tool: "eslint", status: "ok", parsed: [], raw: "" },
      "git-diff": {
        tool: "git-diff",
        status: "ok",
        parsed: [
          {
            file: "src/foo.ts",
            oldStart: 1,
            oldLines: 5,
            newStart: 1,
            newLines: 5,
            header: "@@ -1,5 +1,5 @@",
            body: "-old line\n+new line",
          },
        ],
        raw: "diff --git a/src/foo.ts b/src/foo.ts",
      },
      ripgrep: { tool: "ripgrep", status: "ok", parsed: [], raw: "" },
      securityFindings: [],
      owaspHints: [],
      webSearchSources: [],
    }),
    callBrainFn: fakeBrainCall(passive),
    writeCritiqueFn: async (_base, input) => {
      captured = input;
      return { id: "c-passive", path: "/fixture/proj-a/.siltpoke/c-passive.md" };
    },
  };

  const result = await runCritic(makeOpts(), deps);
  const snapshot = JSON.stringify(
    { result: stripTiming(result), critiqueInput: captured },
    null,
    2,
  );
  diffOrCapture(snapshot, "runCritic-PASSIVE_BUBBLE.json");
});

test("golden: runCritic NORMAL accepted path is stable", async () => {
  let captured: CritiqueInput | null = null;
  const SNIPPET = "let x: string = badValue;";
  const accepted = brainOut({
    evidence: [{ tool: "tsc", file: "src/foo.ts", line: 10, snippet: SNIPPET }],
  });

  const deps: RunCriticDeps = {
    runToolsFn: async () => ({
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
        raw: `src/foo.ts(10,5): error TS2322: Type 'number' is not assignable.\n${SNIPPET}`,
      },
      eslint: notApplicable("eslint"),
      "git-diff": { tool: "git-diff", status: "ok", parsed: [], raw: "" },
      ripgrep: notApplicable("ripgrep"),
      securityFindings: [],
      owaspHints: [],
      webSearchSources: [],
    }),
    callBrainFn: fakeBrainCall(accepted),
    writeCritiqueFn: async (_base, input) => {
      captured = input;
      return { id: "c-normal", path: "/fixture/proj-a/.siltpoke/c-normal.md" };
    },
  };

  const result = await runCritic(makeOpts(), deps);
  const snapshot = JSON.stringify(
    { result: stripTiming(result), critiqueInput: captured },
    null,
    2,
  );
  diffOrCapture(snapshot, "runCritic-NORMAL_accepted.json");
});

test("golden: runCritic NORMAL rejected path is stable", async () => {
  let writeCalled = false;
  const FABRICATED = "this snippet was hallucinated by the LLM!";
  const rejected = brainOut({
    evidence: [{ tool: "tsc", file: "src/foo.ts", line: 10, snippet: FABRICATED }],
  });

  const deps: RunCriticDeps = {
    runToolsFn: async () => ({
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
        raw: `src/foo.ts(10,5): error TS2322: Type 'number' is not assignable.\nlet x: string = badValue;`,
      },
      eslint: notApplicable("eslint"),
      "git-diff": { tool: "git-diff", status: "ok", parsed: [], raw: "" },
      ripgrep: notApplicable("ripgrep"),
      securityFindings: [],
      owaspHints: [],
      webSearchSources: [],
    }),
    callBrainFn: fakeBrainCall(rejected),
    writeCritiqueFn: async () => {
      writeCalled = true;
      return { id: "c-rejected", path: "/fixture/proj-a/.siltpoke/c-rejected.md" };
    },
  };

  const result = await runCritic(makeOpts(), deps);
  expect(writeCalled).toBe(false);
  const snapshot = JSON.stringify(
    { result: stripTiming(result), writeCalled },
    null,
    2,
  );
  diffOrCapture(snapshot, "runCritic-NORMAL_rejected.json");
});
