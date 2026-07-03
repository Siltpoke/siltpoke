/**
 * Unit tests for runCritic().
 *
 * Spec: tests/critic/run-critic.test.ts
 * Uses dependency injection (deps param) to stub runTools, callBrain, writeCritique.
 */

import { describe, expect, test, } from "bun:test";
import type { BrainCallResult, CallBrainOptions } from "../../src/brain/brain";
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

describe("runCritic — NORMAL rejected path", () => {
  test("fabricated snippet not in corpus → guard rejects, no writeCritique, returns accepted:false", async () => {
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
    // After narrowing decision + accepted, access reason safely via type assertion
    // (the assertion is safe because the expect above guarantees NORMAL + not-accepted)
    expect(
      result.decision === "NORMAL" && !result.accepted,
    ).toBe(true);
    if (result.decision === "NORMAL" && !result.accepted) {
      const reason: string = result.reason;
      expect(reason).toContain("snippet not in evidence_corpus");
    }
    expect(writeCalled).toBe(false);
  });

  test("NORMAL mode with empty evidence array → guard rejects", async () => {
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
    expect(
      result.decision === "NORMAL" && !result.accepted,
    ).toBe(true);
    if (result.decision === "NORMAL" && !result.accepted) {
      const reason: string = result.reason;
      expect(reason).toContain("evidence array empty");
    }
    expect(writeCalled).toBe(false);
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

  test("NEGATIVE CONTROL: resolver unavailable → no block → same caller-token citation IS guard-rejected", async () => {
    // Proves the corpus extension is causally necessary: identical Brain output
    // (citing CALLER_TOKEN, file=changed src/foo.ts so the file-check passes),
    // but with NO caller block the token never enters the corpus → snippet check
    // fails → guard rejects. If this still accepted, the positive test would be
    // proving nothing (token coincidentally in tool output).
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
      expect(result.accepted).toBe(false); // snippet not in corpus → rejected
    }
    expect(writeCalled).toBe(false);
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
