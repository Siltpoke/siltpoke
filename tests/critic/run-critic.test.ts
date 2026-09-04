/**
 * Unit tests for runCritic().
 *
 * Spec: tests/critic/run-critic.test.ts
 * Uses dependency injection (deps param) to stub runTools, callBrain, writeCritique.
 */

import { describe, expect, test, } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BrainError, type BrainCallRawResult, type BrainCallResult, type CallBrainOptions } from "../../src/brain/brain";
import type { BrainOutput } from "../../src/brain/schema";
import type { ProjectCapabilities } from "../../src/critic/capabilities";
import { type RunCriticDeps, type RunCriticOpts, runCritic } from "../../src/critic/run-critic";
import type { ToolName, ToolResult } from "../../src/critic/tools/types";
import { Tracer } from "../../src/observability/tracer";
import type { Span } from "../../src/observability/types";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeCaps(overrides?: Partial<ProjectCapabilities>): ProjectCapabilities {
  return {
    cwd: "/tmp/test",
    hasGit: true,
    hasTsc: false,
    hasEslint: false,
    hasRipgrep: false,
    tsconfigPaths: [],
    eslintConfigPaths: [],
    detectedAt: Date.now(),
    configMtimes: {},
    ...overrides,
  };
}

function makeOpts(
  overrides?: Partial<RunCriticOpts>,
): RunCriticOpts {
  return {
    source: "stop-hook",
    cwd: "/tmp/test",
    changedFiles: ["src/foo.ts"],
    caps: makeCaps(),
    brainContext: {
      personalitySystemPrompt: "You are Siltpoke.",
      memory: null,
      recent: [],
      sessionId: "sess-001",
      cwd: "/tmp/test",
      stateBase: "/tmp/test/.siltpoke",
    },
    ...overrides,
  };
}

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

function makeCleanWithDiff(): Record<ToolName, ToolResult> & { securityFindings: never[]; owaspHints: never[]; webSearchSources: never[] } {
  return {
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
  };
}

const REAL_SNIPPET = "let x: string = badValue;";

function makeWithTscError(): Record<ToolName, ToolResult> & { securityFindings: never[]; owaspHints: never[]; webSearchSources: never[] } {
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
      raw: `src/foo.ts(10,5): error TS2322: Type 'number' is not assignable.\n${REAL_SNIPPET}`,
    },
    eslint: makeNotApplicable("eslint"),
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
    critique_for_claude: "src/foo.ts line 10 has a type error.",
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

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("runCritic — HARD_SUPPRESS path", () => {
  test("all tools not_applicable → no Brain call, returns HARD_SUPPRESS", async () => {
    let brainCalled = false;
    let writeCalled = false;

    const deps: RunCriticDeps = {
      runToolsFn: async () => makeAllNotApplicable(),
      callBrainFn: async () => {
        brainCalled = true;
        return { output: makeFakeBrainOutput(), usage: { cache_creation_input_tokens: 0, cache_read_input_tokens: 0, input_tokens: 0, output_tokens: 0, total_cost_usd: 0 } };
      },
      writeCritiqueFn: async () => {
        writeCalled = true;
        return { id: "c-test", path: "/tmp/test" };
      },
    };

    const result = await runCritic(makeOpts(), deps);

    expect(result.decision).toBe("HARD_SUPPRESS");
    expect(brainCalled).toBe(false);
    expect(writeCalled).toBe(false);
    expect("reason" in result && result.reason).toBeTruthy();
  });
});

describe("runCritic — PASSIVE_BUBBLE path", () => {
  test("clean tools + diff → Brain called with passive prompt, critique written, returns PASSIVE_BUBBLE", async () => {
    let brainCalled = false;
    let writeCalled = false;
    let capturedSystemPrompt = "";

    const passiveBrain = makeFakeBrainOutput({
      mood: "happy",
      pose: "base",
      bubble_short: "Clean refactor",
      critique_for_claude: "",
      evidence: [],
    });

    const deps: RunCriticDeps = {
      runToolsFn: async () => makeCleanWithDiff(),
      callBrainFn: async (opts) => {
        brainCalled = true;
        capturedSystemPrompt = opts.systemPrompt;
        return { output: passiveBrain, usage: { cache_creation_input_tokens: 0, cache_read_input_tokens: 0, input_tokens: 100, output_tokens: 50, total_cost_usd: 0 } };
      },
      writeCritiqueFn: async () => {
        writeCalled = true;
        return { id: "c-passive", path: "/tmp/test" };
      },
    };

    const result = await runCritic(makeOpts(), deps);

    expect(result.decision).toBe("PASSIVE_BUBBLE");
    expect(brainCalled).toBe(true);
    expect(writeCalled).toBe(true);
    if (result.decision === "PASSIVE_BUBBLE") {
      expect(result.critique.mood).toBe("happy");
    }
    // System prompt includes personality
    expect(capturedSystemPrompt).toContain("You are Siltpoke");
  });
});

// ---------------------------------------------------------------------------
// Track #7 T3 (deferred T2 item) — the reviewed-repo cwd must reach
// callBrainFn (so the codex adapter's `-C` targets the right repo, not the
// daemon's own frozen process.cwd()).
// ---------------------------------------------------------------------------

describe("runCritic — reviewed-repo cwd threading (track #7 T3)", () => {
  test("PASSIVE_BUBBLE — callBrainFn receives brainContext.cwd", async () => {
    let capturedCwd: string | undefined;
    const deps: RunCriticDeps = {
      runToolsFn: async () => makeCleanWithDiff(),
      callBrainFn: async (opts) => {
        capturedCwd = opts.cwd;
        return {
          output: makeFakeBrainOutput({ mood: "happy", pose: "base", evidence: [] }),
          usage: { cache_creation_input_tokens: 0, cache_read_input_tokens: 0, input_tokens: 10, output_tokens: 5, total_cost_usd: 0 },
        };
      },
      writeCritiqueFn: async () => ({ id: "c-cwd-passive", path: "/tmp/test" }),
    };

    const result = await runCritic(
      makeOpts({ brainContext: { ...makeOpts().brainContext, cwd: "/repo/under/review" } }),
      deps,
    );

    expect(result.decision).toBe("PASSIVE_BUBBLE");
    expect(capturedCwd).toBe("/repo/under/review");
  });

  test("NORMAL — callBrainFn receives brainContext.cwd", async () => {
    let capturedCwd: string | undefined;
    const deps: RunCriticDeps = {
      runToolsFn: async () => makeWithTscError(),
      callBrainFn: async (opts) => {
        capturedCwd = opts.cwd;
        return {
          output: makeFakeBrainOutput({
            evidence: [{ tool: "tsc", file: "src/foo.ts", line: 10, snippet: "let x: string = badValue;" }],
          }),
          usage: { cache_creation_input_tokens: 0, cache_read_input_tokens: 0, input_tokens: 10, output_tokens: 5, total_cost_usd: 0 },
        };
      },
      writeCritiqueFn: async () => ({ id: "c-cwd-normal", path: "/tmp/test" }),
    };

    const result = await runCritic(
      makeOpts({ brainContext: { ...makeOpts().brainContext, cwd: "/repo/under/review" } }),
      deps,
    );

    expect(result.decision).toBe("NORMAL");
    expect(capturedCwd).toBe("/repo/under/review");
  });
});

describe("runCritic — diff-summary extract-role wiring (single-brain #10, S2, task 10)", () => {
  // Minimal fake of `claude -p --output-format json`, mirroring
  // tests/brain/role-brain.test.ts's fakeClaudeSpawn — captures argv so the
  // test can assert which --model actually reached the (faked) subprocess.
  function fakeClaudeSpawn(innerResult: string, capture?: { argv?: string[] }) {
    return ((argv: string[]) => {
      if (capture) capture.argv = argv;
      const events = [{ type: "result", result: innerResult, total_cost_usd: 0, usage: {} }];
      return {
        stdin: { write() {}, end() {} },
        stdout: new Response(JSON.stringify(events)).body,
        stderr: new Response("").body,
        exited: Promise.resolve(0),
        kill() {},
      } as unknown as ReturnType<typeof Bun.spawn>;
    }) as unknown as typeof Bun.spawn;
  }

  test("with homeBase — runDiffSummaryFn's callFn is genuinely role-routed to extract (pinned model)", async () => {
    const home = mkdtempSync(join(tmpdir(), "run-critic-diff-summary-"));
    try {
      let capturedCallFn: ((opts: CallBrainOptions) => Promise<BrainCallRawResult>) | undefined;
      const deps: RunCriticDeps = {
        runToolsFn: async () => makeCleanWithDiff(),
        callBrainFn: async () => ({
          output: makeFakeBrainOutput({ mood: "happy", pose: "base", evidence: [] }),
          usage: { cache_creation_input_tokens: 0, cache_read_input_tokens: 0, input_tokens: 50, output_tokens: 20, total_cost_usd: 0 },
        }),
        writeCritiqueFn: async () => ({ id: "c-diff-summary-wiring", path: "/tmp" }),
        runDiffSummaryFn: async (opts) => {
          capturedCallFn = opts.callFn;
          return null;
        },
      };

      await runCritic(makeOpts({ homeBase: home }), deps);

      expect(capturedCallFn).toBeDefined();

      // Prove it's genuinely role-routed (not just "some function" survives
      // the wiring): invoke the captured callFn with a fake spawn and assert
      // the `extract` role's pinned default model reached `claude -p --model`
      // — this is what makeRoleRawBrain(homeBase, "extract") does and a
      // hand-rolled stub would not.
      const capture: { argv?: string[] } = {};
      const out = await capturedCallFn!({
        systemPrompt: "sys",
        contextBundle: "diff",
        spawnFn: fakeClaudeSpawn(JSON.stringify({ intent: "x" }), capture),
      });
      expect(out.output).toEqual({ intent: "x" });
      const modelIdx = capture.argv?.indexOf("--model") ?? -1;
      expect(modelIdx).toBeGreaterThanOrEqual(0);
      expect(capture.argv?.[modelIdx + 1]).toBe("claude-haiku-4-5-20251001");
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("without homeBase — runDiffSummaryFn's callFn is undefined (falls back to its own lazy default)", async () => {
    let receivedCallFn: unknown;
    let sawCall = false;
    const deps: RunCriticDeps = {
      runToolsFn: async () => makeCleanWithDiff(),
      callBrainFn: async () => ({
        output: makeFakeBrainOutput({ mood: "happy", pose: "base", evidence: [] }),
        usage: { cache_creation_input_tokens: 0, cache_read_input_tokens: 0, input_tokens: 50, output_tokens: 20, total_cost_usd: 0 },
      }),
      writeCritiqueFn: async () => ({ id: "c-diff-summary-no-homebase", path: "/tmp" }),
      runDiffSummaryFn: async (opts) => {
        sawCall = true;
        receivedCallFn = opts.callFn;
        return null;
      },
    };

    await runCritic(makeOpts({ homeBase: undefined }), deps);

    expect(sawCall).toBe(true);
    expect(receivedCallFn).toBeUndefined();
  });
});

describe("runCritic — NORMAL accepted path", () => {
  test("tsc error + snippet in corpus → guard accepts, critique written, returns accepted:true", async () => {
    let writeCalled = false;

    const brainOutput = makeFakeBrainOutput({
      evidence: [
        {
          tool: "tsc",
          file: "src/foo.ts",
          line: 10,
          snippet: REAL_SNIPPET,
        },
      ],
    });

    const deps: RunCriticDeps = {
      runToolsFn: async () => makeWithTscError(),
      callBrainFn: makeFakeBrainFn(brainOutput),
      writeCritiqueFn: async () => {
        writeCalled = true;
        return { id: "c-normal", path: "/tmp/test" };
      },
    };

    const result = await runCritic(makeOpts(), deps);

    expect(result.decision).toBe("NORMAL");
    if (result.decision === "NORMAL") {
      expect(result.accepted).toBe(true);
      expect(result.critique.mood).toBe("annoyed");
    }
    expect(writeCalled).toBe(true);
  });

  // Guard-corpus regression: the Brain only SEES the formatted tool section,
  // but the guard historically checked snippets against the RAW stdout only.
  // The full tsc message ("...assignable to type 'string'.") is present in the
  // formatted section but NOT in this raw (which is truncated). A snippet the
  // model legitimately copied from what it saw must still pass the guard.
  test("snippet present in formatted section (not raw) → guard accepts", async () => {
    let writeCalled = false;

    // In formatTscBlock output via parsed.message; absent from makeWithTscError raw.
    const sectionOnlySnippet = "is not assignable to type 'string'.";

    const brainOutput = makeFakeBrainOutput({
      evidence: [
        { tool: "tsc", file: "src/foo.ts", line: 10, snippet: sectionOnlySnippet },
      ],
    });

    const deps: RunCriticDeps = {
      runToolsFn: async () => makeWithTscError(),
      callBrainFn: makeFakeBrainFn(brainOutput),
      writeCritiqueFn: async () => {
        writeCalled = true;
        return { id: "c-section", path: "/tmp/test" };
      },
    };

    const result = await runCritic(makeOpts(), deps);

    expect(result.decision).toBe("NORMAL");
    if (result.decision === "NORMAL") {
      expect(result.accepted).toBe(true);
    }
    expect(writeCalled).toBe(true);
  });
});

describe("runCritic — NORMAL unverified-evidence path", () => {
  // Renamed from "NORMAL rejected path" on 2026-08-19. Both cases below used
  // to end the review; both now end only the citation. The assertions moved
  // with them: `accepted === false` / `writeCalled === false` became the label,
  // the count, and the fact that the review IS written with its bad citation
  // stripped out. Asserting the old pair would have been asserting a branch
  // that can no longer be taken.
  test("fabricated snippet not in corpus → citation dropped, review still written", async () => {
    let writeCalled = false;

    const fabricatedSnippet = "this snippet was hallucinated by the LLM!";

    const brainOutput = makeFakeBrainOutput({
      evidence: [
        {
          tool: "tsc",
          file: "src/foo.ts",
          line: 10,
          snippet: fabricatedSnippet,
        },
      ],
    });

    const deps: RunCriticDeps = {
      runToolsFn: async () => makeWithTscError(),
      callBrainFn: makeFakeBrainFn(brainOutput),
      writeCritiqueFn: async () => {
        writeCalled = true;
        return { id: "c-rejected", path: "/tmp/test" };
      },
    };

    const result = await runCritic(makeOpts(), deps);

    expect(result.decision).toBe("NORMAL");
    if (result.decision === "NORMAL") {
      expect(result.evidenceLabel).toBe("none_verified");
      expect(result.unverifiedCount).toBe(1);
      // The hallucinated snippet does not reach the persisted critique — the
      // anti-hallucination half of the guard is unchanged.
      expect(result.critique.evidence).toEqual([]);
      // ...and the reviewer's prose does, which is the half that changed.
      expect(result.critique.critique_for_claude.length).toBeGreaterThan(0);
    }
    expect(writeCalled).toBe(true);
  });

  test("NORMAL mode with empty evidence array → review still written, labelled no_evidence", async () => {
    let writeCalled = false;

    const brainOutput = makeFakeBrainOutput({
      evidence: [],
    });

    const deps: RunCriticDeps = {
      runToolsFn: async () => makeWithTscError(),
      callBrainFn: makeFakeBrainFn(brainOutput),
      writeCritiqueFn: async () => {
        writeCalled = true;
        return { id: "c-rejected-empty", path: "/tmp/test" };
      },
    };

    const result = await runCritic(makeOpts(), deps);

    expect(result.decision).toBe("NORMAL");
    if (result.decision === "NORMAL") {
      expect(result.evidenceLabel).toBe("no_evidence");
      // Nothing was cited, so nothing was dropped. A `1` here would mean the
      // empty case had been folded into the unverified case.
      expect(result.unverifiedCount).toBe(0);
    }
    expect(writeCalled).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Caller-impact wiring into NORMAL phase + evidence guard.
// Injected fake resolver + fake ImageReader (no git, no rg). The git-diff raw
// carries a real unified diff that changes `foo`'s param count, so the pipeline
// emits a caller block; we assert (a) the block reaches the system prompt and
// (b) a Brain citation of a `caller:` token survives the evidence guard.
// ---------------------------------------------------------------------------

const SIG_CHANGE_DIFF = [
  "diff --git a/src/foo.ts b/src/foo.ts",
  "index 111..222 100644",
  "--- a/src/foo.ts",
  "+++ b/src/foo.ts",
  "@@ -1,3 +1,3 @@",
  "-export function foo(a) {",
  "+export function foo(a, b) {",
  "   return a;",
  " }",
].join("\n");

function makeTscErrorWithSigDiff(): Record<ToolName, ToolResult> & { securityFindings: never[]; owaspHints: never[]; webSearchSources: never[] } {
  const base = makeWithTscError();
  base["git-diff"] = { tool: "git-diff", status: "ok", parsed: [], raw: SIG_CHANGE_DIFF };
  return base;
}

const CALLER_TOKEN = "caller: src/bar.ts:42";

function makeCallerImpactDeps() {
  const images = {
    pre: (path: string) =>
      path === "src/foo.ts" ? ["export function foo(a) {", "  return a;", "}"].join("\n") : null,
    post: (path: string) =>
      path === "src/foo.ts" ? ["export function foo(a, b) {", "  return a;", "}"].join("\n") : null,
  };
  const resolver = {
    async resolveCallers() {
      return { callers: [{ file: "src/bar.ts", line: 42 }], defs: 1, ambiguous: false, callsiteCount: 1, unavailable: false };
    },
  };
  return { images, resolver };
}

describe("runCritic — NORMAL caller-impact wiring", () => {
  test("sig-change diff + injected resolver → caller block in system prompt AND caller token survives evidence guard", async () => {
    let capturedSystemPrompt = "";
    let writeCalled = false;

    // Brain cites the caller token as its evidence snippet. File stays
    // src/foo.ts (a changed file) so the file-check passes; the snippet check
    // can only pass if the token reached the evidence corpus via caller-impact wiring.
    const brainOutput = makeFakeBrainOutput({
      evidence: [{ tool: "ripgrep", file: "src/foo.ts", line: 1, snippet: CALLER_TOKEN }],
    });

    const deps: RunCriticDeps = {
      runToolsFn: async () => makeTscErrorWithSigDiff(),
      callBrainFn: async (opts) => {
        capturedSystemPrompt = opts.systemPrompt;
        return { output: brainOutput, usage: { cache_creation_input_tokens: 0, cache_read_input_tokens: 0, input_tokens: 100, output_tokens: 50, total_cost_usd: 0 } };
      },
      writeCritiqueFn: async () => {
        writeCalled = true;
        return { id: "c-caller", path: "/tmp/test" };
      },
      callerImpact: makeCallerImpactDeps(),
    };

    const result = await runCritic(makeOpts(), deps);

    // (a) block reached the prompt
    expect(capturedSystemPrompt).toContain("Caller impact (1-hop, structural)");
    expect(capturedSystemPrompt).toContain(CALLER_TOKEN);
    // (b) the caller-token citation was NOT guard-rejected → token in corpus
    expect(result.decision).toBe("NORMAL");
    if (result.decision === "NORMAL") {
      expect(result.accepted).toBe(true);
    }
    expect(writeCalled).toBe(true);
  });

  test("NEGATIVE CONTROL: resolver unavailable → no block → same caller-token citation IS dropped", async () => {
    // Proves the corpus extension is causally necessary: identical Brain output
    // (citing CALLER_TOKEN, file=changed src/foo.ts so the file-check passes),
    // but with NO caller block the token never enters the corpus → snippet check
    // fails → the citation is dropped. If it still verified, the positive test
    // would be proving nothing (token coincidentally in tool output).
    //
    // The control reads `evidenceLabel` since 2026-08-19; `accepted` is now
    // constant on this path and a control asserting a constant is dead.
    let writeCalled = false;
    const brainOutput = makeFakeBrainOutput({
      evidence: [{ tool: "ripgrep", file: "src/foo.ts", line: 1, snippet: CALLER_TOKEN }],
    });
    const noBlockDeps = makeCallerImpactDeps();
    noBlockDeps.resolver = {
      async resolveCallers() {
        return { callers: [], defs: 0, ambiguous: false, callsiteCount: 0, unavailable: true };
      },
    };
    const deps: RunCriticDeps = {
      runToolsFn: async () => makeTscErrorWithSigDiff(),
      callBrainFn: makeFakeBrainFn(brainOutput),
      writeCritiqueFn: async () => {
        writeCalled = true;
        return { id: "c-neg", path: "/tmp/test" };
      },
      callerImpact: noBlockDeps,
    };
    const result = await runCritic(makeOpts(), deps);
    expect(result.decision).toBe("NORMAL");
    if (result.decision === "NORMAL") {
      expect(result.evidenceLabel).toBe("none_verified"); // snippet not in corpus
      expect(result.critique.evidence).toEqual([]);
    }
    expect(writeCalled).toBe(true);
  });

  test("FAIL-SOFT: a resolver that THROWS is swallowed → critic proceeds normally", async () => {
    // The outer try/catch in buildCallerImpactSection must absorb a real throw,
    // not just a graceful null. Brain cites REAL_SNIPPET (in the tsc corpus) so
    // the run still accepts — proving the throw didn't break the normal phase.
    const brainOutput = makeFakeBrainOutput({
      evidence: [{ tool: "tsc", file: "src/foo.ts", line: 10, snippet: REAL_SNIPPET }],
    });
    const throwingDeps = makeCallerImpactDeps();
    throwingDeps.resolver = {
      async resolveCallers() {
        throw new Error("simulated resolver explosion");
      },
    };
    const deps: RunCriticDeps = {
      runToolsFn: async () => makeTscErrorWithSigDiff(),
      callBrainFn: makeFakeBrainFn(brainOutput),
      writeCritiqueFn: async () => ({ id: "c-throw", path: "/tmp/test" }),
      callerImpact: throwingDeps,
    };
    const result = await runCritic(makeOpts(), deps);
    expect(result.decision).toBe("NORMAL");
    if (result.decision === "NORMAL") {
      expect(result.accepted).toBe(true);
    }
  });

  test("no callerImpact deps injected → defaults run fail-soft, no block, critic proceeds normally", async () => {
    // Default image reader hits real git on a non-existent path → null → no block.
    const brainOutput = makeFakeBrainOutput({
      evidence: [{ tool: "tsc", file: "src/foo.ts", line: 10, snippet: REAL_SNIPPET }],
    });
    const deps: RunCriticDeps = {
      runToolsFn: async () => makeWithTscError(),
      callBrainFn: makeFakeBrainFn(brainOutput),
      writeCritiqueFn: async () => ({ id: "c-nodeps", path: "/tmp/test" }),
    };
    const result = await runCritic(makeOpts(), deps);
    expect(result.decision).toBe("NORMAL");
    if (result.decision === "NORMAL") {
      expect(result.accepted).toBe(true);
    }
  });
});

describe("runCritic — source tagging", () => {
  test('source="review-cli" is reflected in returned result without errors', async () => {
    const deps: RunCriticDeps = {
      runToolsFn: async () => makeAllNotApplicable(),
      callBrainFn: makeFakeBrainFn(makeFakeBrainOutput()),
      writeCritiqueFn: async () => ({ id: "c-cli", path: "/tmp" }),
    };

    const result = await runCritic(
      makeOpts({ source: "review-cli" }),
      deps,
    );

    // review-cli with all tools not_applicable → HARD_SUPPRESS
    expect(result.decision).toBe("HARD_SUPPRESS");
  });

  test('source="review-cli" on PASSIVE_BUBBLE path completes without errors', async () => {
    let brainCalled = false;

    const deps: RunCriticDeps = {
      runToolsFn: async () => makeCleanWithDiff(),
      callBrainFn: async (_opts) => {
        brainCalled = true;
        return { output: makeFakeBrainOutput({ mood: "happy", pose: "base", evidence: [] }), usage: { cache_creation_input_tokens: 0, cache_read_input_tokens: 0, input_tokens: 0, output_tokens: 0, total_cost_usd: 0 } };
      },
      writeCritiqueFn: async () => ({ id: "c-cli-passive", path: "/tmp" }),
    };

    const result = await runCritic(
      makeOpts({ source: "review-cli" }),
      deps,
    );

    expect(result.decision).toBe("PASSIVE_BUBBLE");
    expect(brainCalled).toBe(true);
  });
});

describe("runCritic — error resilience", () => {
  test("runTools throws → HARD_SUPPRESS, no crash", async () => {
    const deps: RunCriticDeps = {
      runToolsFn: async () => {
        throw new Error("spawn failed");
      },
      callBrainFn: makeFakeBrainFn(makeFakeBrainOutput()),
      writeCritiqueFn: async () => ({ id: "c-err", path: "/tmp" }),
    };

    const result = await runCritic(makeOpts(), deps);

    expect(result.decision).toBe("HARD_SUPPRESS");
    if (result.decision === "HARD_SUPPRESS") {
      expect(result.reason).toContain("runTools threw");
    }
  });

  test("Brain call throws in NORMAL path → HARD_SUPPRESS, no crash", async () => {
    let writeCalled = false;

    const deps: RunCriticDeps = {
      runToolsFn: async () => makeWithTscError(),
      callBrainFn: async () => {
        throw new Error("claude -p timeout");
      },
      writeCritiqueFn: async () => {
        writeCalled = true;
        return { id: "c-brain-err", path: "/tmp" };
      },
    };

    const result = await runCritic(makeOpts(), deps);

    expect(result.decision).toBe("HARD_SUPPRESS");
    expect(writeCalled).toBe(false);
  });

  test("Brain call throws in NORMAL path with an ordinary (non-quota) BrainError → HARD_SUPPRESS, skipCode undefined", async () => {
    const deps: RunCriticDeps = {
      runToolsFn: async () => makeWithTscError(),
      callBrainFn: async () => {
        throw new BrainError("claude -p exited with code 1: rate limit exceeded", undefined, {
          exitCode: 1,
          stderr: "rate limit exceeded",
          stdout: "",
        });
      },
      writeCritiqueFn: async () => ({ id: "c-brain-err-2", path: "/tmp" }),
    };

    const result = await runCritic(makeOpts(), deps);

    expect(result.decision).toBe("HARD_SUPPRESS");
    if (result.decision === "HARD_SUPPRESS") {
      expect(result.skipCode).toBeUndefined();
    }
  });

  test("Brain call throws a code:\"quota_cap\" BrainError in NORMAL path → HARD_SUPPRESS carries skipCode:\"quota_cap\"", async () => {
    let writeCalled = false;

    const deps: RunCriticDeps = {
      runToolsFn: async () => makeWithTscError(),
      callBrainFn: async () => {
        throw new BrainError(
          '[brain-quota-cap] daily call cap (50/day) reached for quota-billed provider "codex" — call skipped, $0 spent',
          undefined,
          undefined,
          "quota_cap",
        );
      },
      writeCritiqueFn: async () => {
        writeCalled = true;
        return { id: "c-quota-cap", path: "/tmp" };
      },
    };

    const result = await runCritic(makeOpts(), deps);

    expect(result.decision).toBe("HARD_SUPPRESS");
    expect(writeCalled).toBe(false);
    if (result.decision === "HARD_SUPPRESS") {
      expect(result.skipCode).toBe("quota_cap");
      expect(result.reason).toMatch(/cap/i);
    }
  });

  test("Brain call throws a code:\"agy_prompt_too_large\" BrainError in NORMAL path → HARD_SUPPRESS carries its OWN skipCode, not collapsed into quota_cap", async () => {
    const deps: RunCriticDeps = {
      runToolsFn: async () => makeWithTscError(),
      callBrainFn: async () => {
        throw new BrainError(
          "agy -p: merged prompt too large (250000 bytes > 200000 byte cap)",
          undefined,
          undefined,
          "agy_prompt_too_large",
        );
      },
      writeCritiqueFn: async () => ({ id: "c-agy-too-large", path: "/tmp" }),
    };

    const result = await runCritic(makeOpts(), deps);

    expect(result.decision).toBe("HARD_SUPPRESS");
    if (result.decision === "HARD_SUPPRESS") {
      expect(result.skipCode).toBe("agy_prompt_too_large");
      expect(result.skipCode).not.toBe("quota_cap");
    }
  });

  test("Brain call throws a code:\"quota_cap\" BrainError in PASSIVE_BUBBLE path → HARD_SUPPRESS carries skipCode:\"quota_cap\"", async () => {
    const deps: RunCriticDeps = {
      runToolsFn: async () => makeCleanWithDiff(),
      callBrainFn: async () => {
        throw new BrainError(
          '[brain-quota-cap] daily call cap (50/day) reached for quota-billed provider "codex" — call skipped, $0 spent',
          undefined,
          undefined,
          "quota_cap",
        );
      },
      writeCritiqueFn: async () => ({ id: "c-quota-cap-pb", path: "/tmp" }),
    };

    const result = await runCritic(makeOpts(), deps);

    expect(result.decision).toBe("HARD_SUPPRESS");
    if (result.decision === "HARD_SUPPRESS") {
      expect(result.skipCode).toBe("quota_cap");
    }
  });
});

// ---------------------------------------------------------------------------
// New tests — tracer spans, v2 frontmatter, intent propagation
// ---------------------------------------------------------------------------

/** In-memory TraceStore stub — captures spans without touching disk or sqlite. */
class FakeTraceStore {
  spans: Span[] = [];
  async writeSpan(span: Span): Promise<void> { this.spans.push(span); }
  getSpansByTrace(_trace_id: string): Span[] { return this.spans; }
  getTracesByCritique(_critique_id: string): string[] { return []; }
}

describe("runCritic — tracer spans", () => {
  test("runCritic emits ≥5 spans when tracer + traceStore provided (PASSIVE_BUBBLE path)", async () => {
    const tracer = new Tracer();
    const store = new FakeTraceStore();

    const passiveBrain = makeFakeBrainOutput({
      mood: "happy",
      pose: "base",
      bubble_short: "Clean",
      critique_for_claude: "",
      evidence: [],
    });

    const deps: RunCriticDeps = {
      runToolsFn: async () => makeCleanWithDiff(),
      callBrainFn: async () => ({
        output: passiveBrain,
        usage: { cache_creation_input_tokens: 0, cache_read_input_tokens: 0, input_tokens: 50, output_tokens: 20, total_cost_usd: 0 },
      }),
      writeCritiqueFn: async () => ({ id: "c-spans", path: "/tmp" }),
    };

    const opts = makeOpts({
      tracer: tracer as never,
      traceStore: store as never,
    });

    await runCritic(opts, deps);

    // Expect at minimum: siltpoke.turn + rubric.tier1 + rubric.tier2 + intent.classify + prompt.build + brain.find + critique.persist
    expect(store.spans.length).toBeGreaterThanOrEqual(5);

    const names = store.spans.map((s) => s.name);
    expect(names).toContain("siltpoke.turn");
    expect(names).toContain("siltpoke.rubric.tier1");
    expect(names).toContain("siltpoke.brain.find");
  });
});

describe("runCritic — v2 frontmatter (pipelineRan + rubricTriggers)", () => {
  test("pipelineRan=true returned on PASSIVE_BUBBLE path", async () => {
    const deps: RunCriticDeps = {
      runToolsFn: async () => makeCleanWithDiff(),
      callBrainFn: async () => ({
        output: makeFakeBrainOutput({ mood: "happy", pose: "base", evidence: [] }),
        usage: { cache_creation_input_tokens: 0, cache_read_input_tokens: 0, input_tokens: 50, output_tokens: 20, total_cost_usd: 0 },
      }),
      writeCritiqueFn: async () => ({ id: "c-v2-passive", path: "/tmp" }),
    };

    const result = await runCritic(makeOpts(), deps);

    expect(result.decision).toBe("PASSIVE_BUBBLE");
    // Pipeline enabled by default (no homeBase → no config file read, defaults to true)
    expect(result.pipelineRan).toBe(true);
    // rubricTriggers should be an array (may be empty for a tmp dir with no real TS files)
    expect(Array.isArray(result.rubricTriggers)).toBe(true);
  });

  test("pipelineRan=true and rubricTriggers array present on NORMAL accepted path", async () => {
    const brainOutput = makeFakeBrainOutput({
      evidence: [{ tool: "tsc", file: "src/foo.ts", line: 10, snippet: REAL_SNIPPET }],
    });

    const deps: RunCriticDeps = {
      runToolsFn: async () => makeWithTscError(),
      callBrainFn: makeFakeBrainFn(brainOutput),
      writeCritiqueFn: async () => ({ id: "c-v2-normal", path: "/tmp" }),
    };

    const result = await runCritic(makeOpts(), deps);

    expect(result.decision).toBe("NORMAL");
    expect(result.pipelineRan).toBe(true);
    expect(Array.isArray(result.rubricTriggers)).toBe(true);
  });
});

describe("runCritic — intent classification propagation", () => {
  test("intentResult is populated on result when pipeline runs", async () => {
    const deps: RunCriticDeps = {
      runToolsFn: async () => makeCleanWithDiff(),
      callBrainFn: async () => ({
        output: makeFakeBrainOutput({ mood: "happy", pose: "base", evidence: [] }),
        usage: { cache_creation_input_tokens: 0, cache_read_input_tokens: 0, input_tokens: 50, output_tokens: 20, total_cost_usd: 0 },
      }),
      writeCritiqueFn: async () => ({ id: "c-intent", path: "/tmp" }),
    };

    // Provide a commit message that hints at a refactor — classifier should pick it up.
    const opts = makeOpts({ commitMsg: "refactor: extract helper functions" });

    const result = await runCritic(opts, deps);

    expect(result.pipelineRan).toBe(true);
    // intentResult is defined when pipeline ran
    expect(result.intentResult).toBeDefined();
    if (result.intentResult) {
      expect(typeof result.intentResult.classification).toBe("string");
      expect(typeof result.intentResult.confidence).toBe("number");
      expect(result.intentResult.signal_source).toBe("regex");
    }
  });
});

// ---------------------------------------------------------------------------
// span input/output/kind payloads
// ---------------------------------------------------------------------------

describe("runCritic — span attributes (kind + input + output)", () => {
  test("spans carry siltpoke.kind attribute on PASSIVE_BUBBLE path", async () => {
    const tracer = new Tracer();
    const store = new FakeTraceStore();

    const deps: RunCriticDeps = {
      runToolsFn: async () => makeCleanWithDiff(),
      callBrainFn: async () => ({
        output: makeFakeBrainOutput({ mood: "happy", pose: "base", evidence: [] }),
        usage: { cache_creation_input_tokens: 0, cache_read_input_tokens: 0, input_tokens: 50, output_tokens: 20, total_cost_usd: 0 },
      }),
      writeCritiqueFn: async () => ({ id: "c-kind-test", path: "/tmp" }),
    };

    await runCritic(makeOpts({ tracer: tracer as never, traceStore: store as never }), deps);

    // Every span with siltpoke.kind should have one of the expected values
    const validKinds = new Set(["llm", "tool", "rubric", "chain", "parser", "persist"]);
    for (const span of store.spans) {
      const k = span.attributes["siltpoke.kind"];
      if (k !== undefined) {
        expect(validKinds.has(k as string)).toBe(true);
      }
    }

    // siltpoke.turn root span must be kind=chain
    const root = store.spans.find((s) => s.name === "siltpoke.turn");
    expect(root?.attributes["siltpoke.kind"]).toBe("chain");

    // siltpoke.brain.find must be kind=llm
    const brain = store.spans.find((s) => s.name === "siltpoke.brain.find");
    expect(brain?.attributes["siltpoke.kind"]).toBe("llm");

    // siltpoke.rubric.tier1 must be kind=rubric
    const rubric = store.spans.find((s) => s.name === "siltpoke.rubric.tier1");
    expect(rubric?.attributes["siltpoke.kind"]).toBe("rubric");
  });

  test("siltpoke.turn carries siltpoke.input with source/cwd/changedFiles_count", async () => {
    const tracer = new Tracer();
    const store = new FakeTraceStore();

    const deps: RunCriticDeps = {
      runToolsFn: async () => makeCleanWithDiff(),
      callBrainFn: async () => ({
        output: makeFakeBrainOutput({ mood: "happy", pose: "base", evidence: [] }),
        usage: { cache_creation_input_tokens: 0, cache_read_input_tokens: 0, input_tokens: 50, output_tokens: 20, total_cost_usd: 0 },
      }),
      writeCritiqueFn: async () => ({ id: "c-input-test", path: "/tmp" }),
    };

    await runCritic(makeOpts({ tracer: tracer as never, traceStore: store as never }), deps);

    const root = store.spans.find((s) => s.name === "siltpoke.turn");
    expect(root).toBeDefined();
    const input = root?.attributes["siltpoke.input"] as string | undefined;
    expect(typeof input).toBe("string");
    expect(input).toContain("source");
    expect(input).toContain("cwd");
    expect(input).toContain("changedFiles_count");
  });

  test("siltpoke.turn carries siltpoke.output with decision on PASSIVE_BUBBLE path", async () => {
    const tracer = new Tracer();
    const store = new FakeTraceStore();

    const deps: RunCriticDeps = {
      runToolsFn: async () => makeCleanWithDiff(),
      callBrainFn: async () => ({
        output: makeFakeBrainOutput({ mood: "happy", pose: "base", evidence: [] }),
        usage: { cache_creation_input_tokens: 0, cache_read_input_tokens: 0, input_tokens: 50, output_tokens: 20, total_cost_usd: 0 },
      }),
      writeCritiqueFn: async () => ({ id: "c-output-test", path: "/tmp" }),
    };

    await runCritic(makeOpts({ tracer: tracer as never, traceStore: store as never }), deps);

    const root = store.spans.find((s) => s.name === "siltpoke.turn");
    const output = root?.attributes["siltpoke.output"] as string | undefined;
    expect(typeof output).toBe("string");
    expect(output).toContain("PASSIVE_BUBBLE");
  });

  test("siltpoke.brain.find carries siltpoke.input with messages array", async () => {
    const tracer = new Tracer();
    const store = new FakeTraceStore();

    const deps: RunCriticDeps = {
      runToolsFn: async () => makeCleanWithDiff(),
      callBrainFn: async () => ({
        output: makeFakeBrainOutput({ mood: "happy", pose: "base", evidence: [] }),
        usage: { cache_creation_input_tokens: 0, cache_read_input_tokens: 0, input_tokens: 50, output_tokens: 20, total_cost_usd: 0 },
      }),
      writeCritiqueFn: async () => ({ id: "c-brain-input", path: "/tmp" }),
    };

    await runCritic(makeOpts({ tracer: tracer as never, traceStore: store as never }), deps);

    const brain = store.spans.find((s) => s.name === "siltpoke.brain.find");
    const input = brain?.attributes["siltpoke.input"] as string | undefined;
    expect(typeof input).toBe("string");
    expect(input).toContain("messages");
    expect(input).toContain("system");

    // output should contain Brain JSON fields
    const output = brain?.attributes["siltpoke.output"] as string | undefined;
    expect(typeof output).toBe("string");
    expect(output).toContain("mood");
  });

  test("siltpoke.response.parse span emitted with parser kind", async () => {
    const tracer = new Tracer();
    const store = new FakeTraceStore();

    const deps: RunCriticDeps = {
      runToolsFn: async () => makeCleanWithDiff(),
      callBrainFn: async () => ({
        output: makeFakeBrainOutput({ mood: "happy", pose: "base", evidence: [] }),
        usage: { cache_creation_input_tokens: 0, cache_read_input_tokens: 0, input_tokens: 50, output_tokens: 20, total_cost_usd: 0 },
      }),
      writeCritiqueFn: async () => ({ id: "c-parse-span", path: "/tmp" }),
    };

    await runCritic(makeOpts({ tracer: tracer as never, traceStore: store as never }), deps);

    const parseSpan = store.spans.find((s) => s.name === "siltpoke.response.parse");
    expect(parseSpan).toBeDefined();
    expect(parseSpan?.attributes["siltpoke.kind"]).toBe("parser");
    const output = parseSpan?.attributes["siltpoke.output"] as string | undefined;
    expect(typeof output).toBe("string");
    expect(output).toContain("mood");
  });

  test("critique.persist span carries kind=persist + input/output", async () => {
    const tracer = new Tracer();
    const store = new FakeTraceStore();

    const deps: RunCriticDeps = {
      runToolsFn: async () => makeCleanWithDiff(),
      callBrainFn: async () => ({
        output: makeFakeBrainOutput({ mood: "happy", pose: "base", evidence: [] }),
        usage: { cache_creation_input_tokens: 0, cache_read_input_tokens: 0, input_tokens: 50, output_tokens: 20, total_cost_usd: 0 },
      }),
      writeCritiqueFn: async () => ({ id: "c-persist-span", path: "/tmp" }),
    };

    await runCritic(makeOpts({ tracer: tracer as never, traceStore: store as never }), deps);

    const persist = store.spans.find((s) => s.name === "siltpoke.critique.persist");
    expect(persist).toBeDefined();
    expect(persist?.attributes["siltpoke.kind"]).toBe("persist");
    const input = persist?.attributes["siltpoke.input"] as string | undefined;
    expect(typeof input).toBe("string");
    expect(input).toContain("day");
  });

  test("no spans exceed 8KB each on siltpoke.input or siltpoke.output attrs", async () => {
    const tracer = new Tracer();
    const store = new FakeTraceStore();

    const deps: RunCriticDeps = {
      runToolsFn: async () => makeCleanWithDiff(),
      callBrainFn: async () => ({
        output: makeFakeBrainOutput({ mood: "happy", pose: "base", evidence: [] }),
        usage: { cache_creation_input_tokens: 0, cache_read_input_tokens: 0, input_tokens: 50, output_tokens: 20, total_cost_usd: 0 },
      }),
      writeCritiqueFn: async () => ({ id: "c-8kb-test", path: "/tmp" }),
    };

    await runCritic(makeOpts({ tracer: tracer as never, traceStore: store as never }), deps);

    for (const span of store.spans) {
      const inp = span.attributes["siltpoke.input"];
      const out = span.attributes["siltpoke.output"];
      if (typeof inp === "string") expect(inp.length).toBeLessThanOrEqual(8192);
      if (typeof out === "string") expect(out.length).toBeLessThanOrEqual(8192);
    }
  });
});

// ---------------------------------------------------------------------------
// diff-summary span truthfulness (single-brain #10, S2, task 10 follow-up
// fix): the summarizer span's gen_ai.* attributes must reflect the
// ACTUALLY-configured `extract` role, not a hardcoded "anthropic" + pinned
// Haiku label — regardless of which family the diff-summary call itself
// (already role-routed per the S2/task-10 wiring tests above) is sent to.
// ---------------------------------------------------------------------------

describe("runCritic — diff-summary span reports the configured extract family (task 10 span-truthfulness fix)", () => {
  test("default config (no homeBase) — span stays anthropic + pinned Haiku, byte-identical to pre-fix", async () => {
    const tracer = new Tracer();
    const store = new FakeTraceStore();

    const deps: RunCriticDeps = {
      runToolsFn: async () => makeCleanWithDiff(),
      callBrainFn: async () => ({
        output: makeFakeBrainOutput({ mood: "happy", pose: "base", evidence: [] }),
        usage: { cache_creation_input_tokens: 0, cache_read_input_tokens: 0, input_tokens: 50, output_tokens: 20, total_cost_usd: 0 },
      }),
      writeCritiqueFn: async () => ({ id: "c-diff-summary-span-default", path: "/tmp" }),
      runDiffSummaryFn: async () => ({
        summary: { intent: "x", key_changes: [], file_count: 1, risks: [], files_with_purpose: [], source: "haiku" as const },
        usage: { cache_creation_input_tokens: 0, cache_read_input_tokens: 0, input_tokens: 10, output_tokens: 5, total_cost_usd: 0 },
      }),
    };

    await runCritic(makeOpts({ homeBase: undefined, tracer: tracer as never, traceStore: store as never }), deps);

    const summarizerSpan = store.spans.find((s) => s.name === "siltpoke.summarizer.haiku");
    expect(summarizerSpan).toBeDefined();
    expect(summarizerSpan?.attributes["gen_ai.system"]).toBe("anthropic");
    expect(summarizerSpan?.attributes["gen_ai.request.model"]).toBe("claude-haiku-4-5-20251001");
  });

  test("config extract→qoder — span reports qoder's genAiSystem (alibaba) + configured model, NOT anthropic", async () => {
    const home = mkdtempSync(join(tmpdir(), "run-critic-diff-summary-span-"));
    try {
      writeFileSync(
        join(home, "config.json"),
        JSON.stringify({ brain: { roles: { extract: { provider: "qoder", model: "qwen-max-latest" } } } }),
        "utf8",
      );

      const tracer = new Tracer();
      const store = new FakeTraceStore();

      const deps: RunCriticDeps = {
        runToolsFn: async () => makeCleanWithDiff(),
        callBrainFn: async () => ({
          output: makeFakeBrainOutput({ mood: "happy", pose: "base", evidence: [] }),
          usage: { cache_creation_input_tokens: 0, cache_read_input_tokens: 0, input_tokens: 50, output_tokens: 20, total_cost_usd: 0 },
        }),
        writeCritiqueFn: async () => ({ id: "c-diff-summary-span-qoder", path: "/tmp" }),
        // Stub the pre-pass call itself (not under test here — the S2/task-10
        // wiring tests above already prove the callFn is genuinely
        // role-routed); this test only asserts the SPAN ATTRIBUTES.
        runDiffSummaryFn: async () => ({
          summary: { intent: "x", key_changes: [], file_count: 1, risks: [], files_with_purpose: [], source: "haiku" as const },
          usage: { cache_creation_input_tokens: 0, cache_read_input_tokens: 0, input_tokens: 10, output_tokens: 5, total_cost_usd: 0 },
        }),
      };

      await runCritic(makeOpts({ homeBase: home, tracer: tracer as never, traceStore: store as never }), deps);

      const summarizerSpan = store.spans.find((s) => s.name === "siltpoke.summarizer.haiku");
      expect(summarizerSpan).toBeDefined();
      expect(summarizerSpan?.attributes["gen_ai.system"]).toBe("alibaba");
      expect(summarizerSpan?.attributes["gen_ai.system"]).not.toBe("anthropic");
      expect(summarizerSpan?.attributes["gen_ai.request.model"]).toBe("qwen-max-latest");
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// Defect ② — the safety net is structurally unreachable on PASSIVE_BUBBLE.
//
// `diffSummary` is declared at run-critic.ts:332 and assigned ONLY inside
// finalizeSummary(). The PASSIVE_BUBBLE branch passes it by VALUE into the phase
// and calls finalizeSummary() on the next line, so the phase always receives
// undefined and autoPromoteSeverity's `hasRisks` is always false.
//
// NORMAL does not have this bug: it passes the PROMISE and the phase awaits it.
//
// Measured on production data: of PASSIVE_BUBBLE runs whose summary HAD risks,
// 1,500 / 1,843 (81.4%) still shipped severity=info with an empty critique, and
// the hasRisks branch has produced 0 of 2,643 outputs in its lifetime.
// ---------------------------------------------------------------------------

describe("runCritic — PASSIVE_BUBBLE safety net (defect ②)", () => {
  const RISKY_SUMMARY = {
    intent: "risky change",
    key_changes: ["touched auth"],
    risks: ["drops the tenant check", "no test covers the empty-token path"],
    file_count: 1,
    files_with_purpose: [{ path: "src/foo.ts", purpose: "auth" }],
    source: "haiku" as const,
  };

  function happyBrain(): BrainOutput {
    return makeFakeBrainOutput({
      mood: "happy",
      pose: "base",
      bubble_short: "Clean refactor",
      bubble_long: "",
      critique_for_claude: "",
      severity: "info",
      evidence: [],
    });
  }

  test("AC4: the phase receives a defined summary whose risks are non-empty", async () => {
    let written: BrainOutput | undefined;
    const deps: RunCriticDeps = {
      runToolsFn: async () => makeCleanWithDiff(),
      callBrainFn: async () => ({
        output: happyBrain(),
        usage: { cache_creation_input_tokens: 0, cache_read_input_tokens: 0, input_tokens: 10, output_tokens: 10, total_cost_usd: 0 },
      }),
      runDiffSummaryFn: async () => ({
        summary: RISKY_SUMMARY,
        usage: { cache_creation_input_tokens: 0, cache_read_input_tokens: 0, input_tokens: 5, output_tokens: 5, total_cost_usd: 0 },
      }),
      writeCritiqueFn: async (_base, input) => {
        written = input.brain_output;
        return { id: "c-net", path: "/tmp/test" };
      },
    };

    const result = await runCritic(makeOpts(), deps);
    expect(result.decision).toBe("PASSIVE_BUBBLE");
    // If the summary reached autoPromoteSeverity at all, severity moved off info.
    expect(written?.severity).toBe("low");
  });

  test("AC5: the risks Haiku already paid for reach the persisted critique", async () => {
    let written: BrainOutput | undefined;
    const deps: RunCriticDeps = {
      runToolsFn: async () => makeCleanWithDiff(),
      callBrainFn: async () => ({
        output: happyBrain(),
        usage: { cache_creation_input_tokens: 0, cache_read_input_tokens: 0, input_tokens: 10, output_tokens: 10, total_cost_usd: 0 },
      }),
      runDiffSummaryFn: async () => ({
        summary: RISKY_SUMMARY,
        usage: { cache_creation_input_tokens: 0, cache_read_input_tokens: 0, input_tokens: 5, output_tokens: 5, total_cost_usd: 0 },
      }),
      writeCritiqueFn: async (_base, input) => {
        written = input.brain_output;
        return { id: "c-net", path: "/tmp/test" };
      },
    };

    await runCritic(makeOpts(), deps);
    expect(written?.critique_for_claude).toContain("Diff-summary risks (Haiku pre-pass):");
    expect(written?.critique_for_claude).toContain("drops the tenant check");
    // And the bubble must stop saying the happy thing while risks are flagged.
    expect(written?.mood).not.toBe("happy");
  });

  test("AC4b (positive control): no risks -> no promotion, bubble untouched", async () => {
    let written: BrainOutput | undefined;
    const deps: RunCriticDeps = {
      runToolsFn: async () => makeCleanWithDiff(),
      callBrainFn: async () => ({
        output: happyBrain(),
        usage: { cache_creation_input_tokens: 0, cache_read_input_tokens: 0, input_tokens: 10, output_tokens: 10, total_cost_usd: 0 },
      }),
      runDiffSummaryFn: async () => ({
        summary: { ...RISKY_SUMMARY, risks: [] },
        usage: { cache_creation_input_tokens: 0, cache_read_input_tokens: 0, input_tokens: 5, output_tokens: 5, total_cost_usd: 0 },
      }),
      writeCritiqueFn: async (_base, input) => {
        written = input.brain_output;
        return { id: "c-net", path: "/tmp/test" };
      },
    };

    await runCritic(makeOpts(), deps);
    // Without this, AC4/AC5 could pass for an implementation that promotes
    // unconditionally -- which would make every clean run look concerning.
    expect(written?.severity).toBe("info");
    expect(written?.mood).toBe("happy");
    expect(written?.critique_for_claude).toBe("");
  });

  test("AC5b: a REJECTING summary promise must not break the path", async () => {
    // This is the regression the first draft of the fix would have shipped:
    // awaiting the raw promise inside the phase throws past finalizeSummary's
    // catch, its diffSummaryError capture, and the heuristic fallback.
    let written = false;
    const deps: RunCriticDeps = {
      runToolsFn: async () => makeCleanWithDiff(),
      callBrainFn: async () => ({
        output: happyBrain(),
        usage: { cache_creation_input_tokens: 0, cache_read_input_tokens: 0, input_tokens: 10, output_tokens: 10, total_cost_usd: 0 },
      }),
      runDiffSummaryFn: async () => {
        throw new BrainError("summariser exploded");
      },
      writeCritiqueFn: async () => {
        written = true;
        return { id: "c-net", path: "/tmp/test" };
      },
    };

    const result = await runCritic(makeOpts(), deps);
    expect(result.decision).toBe("PASSIVE_BUBBLE");
    expect(written).toBe(true);
    expect(result.summaryError).toContain("summariser exploded");
    // The heuristic fallback still fills in, so the dashboard shows something.
    expect(result.diffSummary?.source).toBe("heuristic");
  });
});

// ---------------------------------------------------------------------------
// finalizeSummary idempotence.
//
// Defect ②'s fix has the PASSIVE_BUBBLE phase settle the summary itself, while
// the caller's own `await finalizeSummary()` stays put — it is still the only
// one on the paths where the phase returns early. So finalizeSummary now runs
// twice on the happy path and must be a no-op the second time.
//
// A mutation run found this uncovered: neutering the `summarySettled` guard left
// all 39 tests green. The observable damage is a duplicated audit line in
// logs/diff-summary.log, which is what this asserts. (`timing.summary_ms` also
// gets recomputed, but that field is already known to measure the wrong thing —
// defect ⑨ — so it is not the thing to pin behaviour on.)
// ---------------------------------------------------------------------------

describe("runCritic — finalizeSummary runs its side effects once", () => {
  test("one PASSIVE_BUBBLE run appends exactly one diff-summary.log line", async () => {
    const home = mkdtempSync(join(tmpdir(), "siltpoke-finalize-"));
    try {
      const deps: RunCriticDeps = {
        runToolsFn: async () => makeCleanWithDiff(),
        callBrainFn: async () => ({
          output: makeFakeBrainOutput({ severity: "info", critique_for_claude: "", evidence: [] }),
          usage: { cache_creation_input_tokens: 0, cache_read_input_tokens: 0, input_tokens: 10, output_tokens: 10, total_cost_usd: 0 },
        }),
        runDiffSummaryFn: async () => ({
          summary: {
            intent: "x",
            key_changes: ["k"],
            risks: ["r"],
            file_count: 1,
            files_with_purpose: [{ path: "src/foo.ts", purpose: "p" }],
            source: "haiku" as const,
          },
          usage: { cache_creation_input_tokens: 0, cache_read_input_tokens: 0, input_tokens: 1, output_tokens: 1, total_cost_usd: 0 },
        }),
        writeCritiqueFn: async () => ({ id: "c-once", path: "/tmp/test" }),
      };

      const result = await runCritic(makeOpts({ homeBase: home }), deps);
      expect(result.decision).toBe("PASSIVE_BUBBLE");

      const { readFileSync } = await import("node:fs");
      const log = readFileSync(join(home, "logs", "diff-summary.log"), "utf8");
      const lines = log.split("\n").filter((l) => l.trim().length > 0);
      expect(lines.length).toBe(1);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// AC8 — what the brain.find span records, decided rather than inherited.
//
// autoPromoteSeverity mutates the critique IN PLACE, and `critique` is the same
// object reference as `brainResult.output`. tracer.setOutput runs at
// passive-bubble.ts:130, BEFORE the promotion at :166 — so whether the span shows
// the promoted or the un-promoted severity depends entirely on whether setOutput
// serialises eagerly or holds the reference. Reading the code says eagerly
// (tracer.ts:138 calls jsonSerialize immediately); this asserts it, because "the
// span records the raw model output" is a claim the code has to keep, not a
// comment that happens to be true today.
//
// The eager behaviour is the one we want: siltpoke.brain.find is the record of
// what the reviewer model actually returned. The promoted value is what the user
// sees, and it is asserted separately by AC4/AC5.
// ---------------------------------------------------------------------------

describe("runCritic — brain.find span records the raw Brain output (AC8)", () => {
  test("span shows severity=info while the persisted critique shows the promotion", async () => {
    const tracer = new Tracer();
    const store = new FakeTraceStore();
    let written: BrainOutput | undefined;

    const deps: RunCriticDeps = {
      runToolsFn: async () => makeCleanWithDiff(),
      callBrainFn: async () => ({
        output: makeFakeBrainOutput({
          mood: "happy",
          pose: "base",
          bubble_short: "Clean refactor",
          critique_for_claude: "",
          severity: "info",
          evidence: [],
        }),
        usage: { cache_creation_input_tokens: 0, cache_read_input_tokens: 0, input_tokens: 10, output_tokens: 10, total_cost_usd: 0 },
      }),
      runDiffSummaryFn: async () => ({
        summary: {
          intent: "risky",
          key_changes: ["k"],
          risks: ["drops the tenant check"],
          file_count: 1,
          files_with_purpose: [{ path: "src/foo.ts", purpose: "p" }],
          source: "haiku" as const,
        },
        usage: { cache_creation_input_tokens: 0, cache_read_input_tokens: 0, input_tokens: 1, output_tokens: 1, total_cost_usd: 0 },
      }),
      writeCritiqueFn: async (_base, input) => {
        written = input.brain_output;
        return { id: "c-span", path: "/tmp/test" };
      },
    };

    await runCritic(makeOpts({ tracer: tracer as never, traceStore: store as never }), deps);

    // The promotion happened...
    expect(written?.severity).toBe("low");

    // ...and the brain.find span still holds what the model itself said.
    const brainSpan = store.spans.find((s) => s.name === "siltpoke.brain.find");
    expect(brainSpan).toBeDefined();
    const output = String(brainSpan?.attributes["siltpoke.output"] ?? "");
    // The span attribute holds pretty-printed JSON, hence the space.
    expect(output).toContain('"severity": "info"');
    expect(output).not.toContain('"severity": "low"');
  });
});

// ---------------------------------------------------------------------------
// AC7 — the latency claim, measured rather than asserted.
//
// D1 chose to have the phase settle the summary itself rather than serialise it
// in front of the Brain call. The first draft of the spec called that "zero added
// latency", which a cross-family review corrected: it is zero only when the
// summary settles before the Brain call returns, so the honest claim is that the
// path costs max(T_brain, T_summary) rather than their sum.
//
// The test must use OVERLAPPING controlled timers. Instantly-resolved fixture
// promises make every implementation pass, including the serialised one D1
// rejected -- which is exactly how this AC was vacuous in its first form.
// ---------------------------------------------------------------------------

describe("runCritic — the summary overlaps the Brain call, not queues behind it (AC7)", () => {
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

  test("PASSIVE_BUBBLE total is about max(T_brain, T_summary), not the sum", async () => {
    const T_BRAIN = 120;
    const T_SUMMARY = 150;

    const deps: RunCriticDeps = {
      runToolsFn: async () => makeCleanWithDiff(),
      callBrainFn: async () => {
        await sleep(T_BRAIN);
        return {
          output: makeFakeBrainOutput({ severity: "info", critique_for_claude: "", evidence: [] }),
          usage: { cache_creation_input_tokens: 0, cache_read_input_tokens: 0, input_tokens: 10, output_tokens: 10, total_cost_usd: 0 },
        };
      },
      runDiffSummaryFn: async () => {
        await sleep(T_SUMMARY);
        return {
          summary: {
            intent: "x",
            key_changes: ["k"],
            risks: ["r"],
            file_count: 1,
            files_with_purpose: [{ path: "src/foo.ts", purpose: "p" }],
            source: "haiku" as const,
          },
          usage: { cache_creation_input_tokens: 0, cache_read_input_tokens: 0, input_tokens: 1, output_tokens: 1, total_cost_usd: 0 },
        };
      },
      writeCritiqueFn: async () => ({ id: "c-timing", path: "/tmp/test" }),
    };

    const started = Date.now();
    const result = await runCritic(makeOpts(), deps);
    const elapsed = Date.now() - started;

    expect(result.decision).toBe("PASSIVE_BUBBLE");
    // Serialised would be >= 270ms. Overlapped is ~150ms. The midpoint is a wide
    // enough gate to stay stable on a loaded machine while still failing the
    // serialised implementation outright.
    expect(elapsed).toBeLessThan(T_BRAIN + T_SUMMARY - 40);
    // And it genuinely waited for the summary -- otherwise this asserts nothing
    // about ordering, only that the run was fast.
    expect(elapsed).toBeGreaterThanOrEqual(T_SUMMARY - 20);
  });
});

// ---------------------------------------------------------------------------
// AC6 — NORMAL is unchanged, proven on the inputs that could break it.
//
// Both paths share coerceLengths and both consume the summary, so a happy-path
// -only assertion is vacuous. These are the two shapes this slice actually
// touched: an over-cap summary, and a rejecting summary promise.
// ---------------------------------------------------------------------------

describe("runCritic — NORMAL path is unaffected by the summary changes (AC6)", () => {
  // Composed rather than reused: the existing tsc-error fixtures carry an empty
  // `parsed` for git-diff, which makes diffBody empty and skips the summariser
  // entirely — the test would then pass while asserting nothing about NORMAL's
  // handling of a summary. This one has real hunks AND a real tsc finding.
  const normalTools = () => {
    const base = makeCleanWithDiff();
    return {
      ...base,
      tsc: makeWithTscError().tsc,
    };
  };

  test("over-cap arrays: NORMAL still completes and gets the truncation counts", async () => {
    let written: BrainOutput | undefined;
    const deps: RunCriticDeps = {
      runToolsFn: async () => normalTools(),
      callBrainFn: async () => ({
        output: makeFakeBrainOutput({ severity: "medium", critique_for_claude: "real finding", evidence: [] }),
        usage: { cache_creation_input_tokens: 0, cache_read_input_tokens: 0, input_tokens: 10, output_tokens: 10, total_cost_usd: 0 },
      }),
      runDiffSummaryFn: async () => ({
        // Already coerced by runDiffSummary in production; here the dep is stubbed,
        // so the point is that NORMAL carries whatever shape it is handed without
        // choking on the new field.
        summary: {
          intent: "x",
          key_changes: ["a", "b", "c", "d", "e", "f", "g", "h"],
          risks: ["r1", "r2", "r3", "r4", "r5", "r6"],
          file_count: 1,
          files_with_purpose: [{ path: "src/foo.ts", purpose: "p" }],
          source: "haiku" as const,
          truncated: { key_changes: 1, risks: 1 },
        },
        usage: { cache_creation_input_tokens: 0, cache_read_input_tokens: 0, input_tokens: 1, output_tokens: 1, total_cost_usd: 0 },
      }),
      writeCritiqueFn: async (_base, input) => {
        written = input.brain_output;
        return { id: "c-normal", path: "/tmp/test" };
      },
    };

    const result = await runCritic(makeOpts(), deps);
    expect(result.decision).toBe("NORMAL");
    // The new field survives the NORMAL path's own summary handling, which is a
    // different code path from PASSIVE_BUBBLE's and reads phase.diffSummary.
    expect(result.diffSummary?.truncated).toEqual({ key_changes: 1, risks: 1 });
    // An empty evidence array used to make this run guard_rejected, so
    // writeCritiqueFn never fired and this asserted `written` was undefined.
    // Since 2026-08-19 the review is written and labelled instead, so the
    // write DOES fire — and it carries the severity the safety net left alone
    // (that property is unit-tested directly in
    // tests/critic/auto-promote-severity.test.ts; asserted here only to the
    // extent that the persisted object is the reviewer's, not an empty stub).
    expect(written).toBeDefined();
    expect(written?.critique_for_claude).toBe("real finding");
    expect(written?.evidence).toEqual([]);
  });

  test("rejecting summary promise: NORMAL still completes, with the heuristic fallback", async () => {
    const deps: RunCriticDeps = {
      runToolsFn: async () => normalTools(),
      callBrainFn: async () => ({
        output: makeFakeBrainOutput({ severity: "medium", critique_for_claude: "real finding", evidence: [] }),
        usage: { cache_creation_input_tokens: 0, cache_read_input_tokens: 0, input_tokens: 10, output_tokens: 10, total_cost_usd: 0 },
      }),
      runDiffSummaryFn: async () => {
        throw new BrainError("summariser exploded on NORMAL");
      },
      writeCritiqueFn: async () => ({ id: "c-normal", path: "/tmp/test" }),
    };

    const result = await runCritic(makeOpts(), deps);
    expect(result.decision).toBe("NORMAL");
    // The heuristic fallback fires, so the dashboard still shows a summary.
    expect(result.diffSummary?.source).toBe("heuristic");
    // ...and NORMAL now reports the summariser failure, same as PASSIVE_BUBBLE.
    //
    // This assertion was `toBeUndefined()` until 2026-08-19, and the asymmetry
    // it recorded turns out to have been an artifact: this fixture's empty
    // evidence array sent it down the guard-rejected return, and THAT return
    // was the one that omitted `summaryError`. Removing the rejection branch
    // removed the asymmetry with it — nothing here was fixed on purpose, so it
    // is recorded rather than claimed as a feature.
    expect(result.summaryError).toBe("summariser exploded on NORMAL");
  });
});
