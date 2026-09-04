// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
// Copyright (c) 2026 Jiaqi Duan
/**
 * Wires the slice ① reverse-deps section (Task 2, `buildReverseDepsSection`)
 * into the NORMAL critic phase as a sibling to the existing caller-impact
 * section (Task 3).
 *
 * Modeled on the "runCritic — NORMAL caller-impact wiring" describe block in
 * tests/critic/run-critic.test.ts: drives the shared `runCritic()` entry
 * (which threads `deps.reverseDeps` into `runNormalPhase`) rather than
 * `runNormalPhase` directly, so the assertions exercise the real wiring path
 * a Stop-hook/review-cli call would take. Reuses the `fakeDeps` double from
 * tests/critic/disk-awareness/fixtures.ts (single source of truth for
 * `ImportersDeps` fakes) instead of hand-rolling another one.
 */
import { describe, expect, test } from "bun:test";
import type { BrainCallResult, CallBrainOptions } from "../../../src/brain/brain";
import type { BrainOutput } from "../../../src/brain/schema";
import type { ProjectCapabilities } from "../../../src/critic/capabilities";
import { type RunCriticDeps, type RunCriticOpts, runCritic } from "../../../src/critic/run-critic";
import type { ToolName, ToolResult } from "../../../src/critic/tools/types";
import { fakeDeps } from "../disk-awareness/fixtures";

// ---------------------------------------------------------------------------
// Fixtures (trimmed local mirrors of run-critic.test.ts's — kept file-local
// so this test doesn't reach into another test file's unexported helpers).
// ---------------------------------------------------------------------------

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

function makeOpts(overrides?: Partial<RunCriticOpts>): RunCriticOpts {
  return {
    source: "stop-hook",
    cwd: "/r",
    changedFiles: ["src/a/foo.ts"],
    caps: makeCaps(),
    brainContext: {
      personalitySystemPrompt: "You are Siltpoke.",
      memory: null,
      recent: [],
      sessionId: "sess-001",
      cwd: "/r",
      stateBase: "/r/.siltpoke",
    },
    ...overrides,
  };
}

const REAL_SNIPPET = "let x: string = badValue;";

// tsc-error tool results — same shape as run-critic.test.ts's makeWithTscError,
// enough to clear classify-output's HARD_SUPPRESS gate and reach NORMAL.
function makeWithTscError(): Record<ToolName, ToolResult> & {
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
      raw: `src/a/foo.ts(10,5): error TS2322: Type 'number' is not assignable.\n${REAL_SNIPPET}`,
    },
    eslint: { tool: "eslint", status: "not_applicable", parsed: [], raw: "" },
    "git-diff": { tool: "git-diff", status: "ok", parsed: [], raw: "" },
    ripgrep: { tool: "ripgrep", status: "ok", parsed: [], raw: "" },
    securityFindings: [],
    owaspHints: [],
    webSearchSources: [],
  };
}

function makeFakeBrainOutput(overrides?: Partial<BrainOutput>): BrainOutput {
  return {
    mood: "annoyed",
    pose: "arms_crossed",
    bubble_short: "Found a type error",
    bubble_long: "You have a type mismatch in foo.ts.",
    critique_for_claude: "src/a/foo.ts line 10 has a type error.",
    severity: "medium",
    confidence: "high",
    xp_earned_events: [],
    evidence: [],
    ...overrides,
  };
}

function makeFakeBrainFn(
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

// A changed file with a known importer: src/consumer.ts imports src/a/foo.ts.
const REVERSE_DEPS_FILES = {
  "src/a/foo.ts": "export const x = 1;",
  "src/consumer.ts": "import { x } from './a/foo';",
};

const IMPORTER_TOKEN = "src/consumer.ts";

describe("runCritic — NORMAL reverse-deps wiring", () => {
  test("appends REVERSE_DEPS section to the prompt and its tokens to the guard corpus", async () => {
    let capturedSystemPrompt = "";
    let writeCalled = false;

    // Brain cites the importer token as its evidence snippet. File stays
    // src/a/foo.ts (a changed file) so the file-check passes; the snippet
    // check can only pass if the token reached the evidence corpus via the
    // reverse-deps wiring under test.
    const brainOutput = makeFakeBrainOutput({
      evidence: [{ tool: "ripgrep", file: "src/a/foo.ts", line: 1, snippet: IMPORTER_TOKEN }],
    });

    const deps: RunCriticDeps = {
      runToolsFn: async () => makeWithTscError(),
      callBrainFn: async (opts) => {
        capturedSystemPrompt = opts.systemPrompt;
        return {
          output: brainOutput,
          usage: { cache_creation_input_tokens: 0, cache_read_input_tokens: 0, input_tokens: 100, output_tokens: 50, total_cost_usd: 0 },
        };
      },
      writeCritiqueFn: async () => {
        writeCalled = true;
        return { id: "c-reverse-deps", path: "/r" };
      },
      reverseDeps: fakeDeps(REVERSE_DEPS_FILES),
    };

    const result = await runCritic(makeOpts(), deps);

    // (a) section reached the assembled prompt
    expect(capturedSystemPrompt).toContain("REVERSE_DEPS");
    expect(capturedSystemPrompt).toContain(IMPORTER_TOKEN);
    // (b) the importer-token citation VERIFIED → token in corpus
    expect(result.decision).toBe("NORMAL");
    if (result.decision === "NORMAL") {
      expect(result.evidenceLabel).toBe("verified");
      expect(result.unverifiedCount).toBe(0);
    }
    expect(writeCalled).toBe(true);
  });

  test("NEGATIVE CONTROL: no importers found → no section → same token citation IS dropped", async () => {
    // Proves the corpus extension is causally necessary: identical Brain
    // output (citing IMPORTER_TOKEN, file=changed src/a/foo.ts so the
    // file-check passes), but a file with zero importers never produces a
    // REVERSE_DEPS block → token never enters the corpus → snippet check
    // fails → the citation is dropped.
    //
    // Reworked 2026-08-19: this control used to read `accepted === false` and
    // `writeCalled === false`. Since the check labels instead of deleting, the
    // review IS written — so the control now reads the label and the count,
    // which say the same thing about the corpus and keep the control alive.
    // Left as `accepted === false` it would have been unfalsifiable.
    let writeCalled = false;
    const brainOutput = makeFakeBrainOutput({
      evidence: [{ tool: "ripgrep", file: "src/a/foo.ts", line: 1, snippet: IMPORTER_TOKEN }],
    });
    const deps: RunCriticDeps = {
      runToolsFn: async () => makeWithTscError(),
      callBrainFn: makeFakeBrainFn(brainOutput),
      writeCritiqueFn: async () => {
        writeCalled = true;
        return { id: "c-neg", path: "/r" };
      },
      reverseDeps: fakeDeps({ "src/a/foo.ts": "export const x = 1;" }), // lonely file, no importers
    };
    const result = await runCritic(makeOpts(), deps);
    expect(result.decision).toBe("NORMAL");
    if (result.decision === "NORMAL") {
      expect(result.evidenceLabel).toBe("none_verified"); // snippet not in corpus
      expect(result.unverifiedCount).toBe(1);
      // The citation itself does not survive — only the review does.
      expect(result.critique.evidence).toEqual([]);
    }
    expect(writeCalled).toBe(true);
  });

  test("FAIL-SOFT: a ripgrep that THROWS is swallowed → critic proceeds normally, no REVERSE_DEPS section", async () => {
    // buildReverseDepsSection's outer try/catch must absorb a real throw
    // from an injected ripgrep, not just a graceful empty result. Brain
    // cites REAL_SNIPPET (in the tsc corpus) so the run still accepts —
    // proving the throw didn't break the normal phase.
    let capturedSystemPrompt = "";
    const brainOutput = makeFakeBrainOutput({
      evidence: [{ tool: "tsc", file: "src/a/foo.ts", line: 10, snippet: REAL_SNIPPET }],
    });
    const throwingDeps = fakeDeps(REVERSE_DEPS_FILES);
    throwingDeps.ripgrep = () => {
      throw new Error("simulated ripgrep explosion");
    };
    const deps: RunCriticDeps = {
      runToolsFn: async () => makeWithTscError(),
      callBrainFn: async (opts) => {
        capturedSystemPrompt = opts.systemPrompt;
        return {
          output: brainOutput,
          usage: { cache_creation_input_tokens: 0, cache_read_input_tokens: 0, input_tokens: 100, output_tokens: 50, total_cost_usd: 0 },
        };
      },
      writeCritiqueFn: async () => ({ id: "c-throw", path: "/r" }),
      reverseDeps: throwingDeps,
    };
    const result = await runCritic(makeOpts(), deps);
    expect(capturedSystemPrompt).not.toContain("REVERSE_DEPS");
    expect(result.decision).toBe("NORMAL");
    if (result.decision === "NORMAL") {
      expect(result.accepted).toBe(true);
    }
  });

  test("no reverseDeps deps injected → defaults run fail-soft, no section, critic proceeds normally", async () => {
    // Default deps hit real ripgrep/fs against a non-existent cwd → no
    // importers found → no section, no throw.
    const brainOutput = makeFakeBrainOutput({
      evidence: [{ tool: "tsc", file: "src/a/foo.ts", line: 10, snippet: REAL_SNIPPET }],
    });
    const deps: RunCriticDeps = {
      runToolsFn: async () => makeWithTscError(),
      callBrainFn: makeFakeBrainFn(brainOutput),
      writeCritiqueFn: async () => ({ id: "c-nodeps", path: "/r" }),
    };
    const result = await runCritic(makeOpts(), deps);
    expect(result.decision).toBe("NORMAL");
    if (result.decision === "NORMAL") {
      expect(result.accepted).toBe(true);
    }
  });
});
