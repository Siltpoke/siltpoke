// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
// Copyright (c) 2026 Jiaqi Duan
/**
 * The per-tool span wiring — failure **F9.1** in
 * an internal design note.
 *
 * `runTools` has emitted a `siltpoke.tool.<name>` child span per invocation
 * since the tracing helper was written, and `tests/critic/tools/run-tools.test.ts`
 * proves it does — when handed a `tracing` context. Nothing in production ever
 * handed it one: `runCritic` held `tracer` / `traceStore` / `rootSpan` and
 * called `runToolsPhase` without them, and `runToolsPhase` had no field to
 * carry them. Measured across all 84 days of traces on the author's machine
 * 2026-08-23: **zero** spans named `siltpoke.tool.*`, ever.
 *
 * That is why this file tests the two HANDOFFS rather than the span emission —
 * the emission was never the broken part, and a test that stubs `runTools` and
 * then asserts on spans would be asserting against its own stub. What was
 * missing is the argument crossing two function boundaries, so that is what is
 * pinned:
 *
 *   1. `runCritic` → `runToolsPhase`   (the phase receives a tracing context)
 *   2. `runToolsPhase` → `runToolsFn`  (it forwards one, parented correctly)
 *
 * Together with the existing `run-tools.test.ts` coverage of
 * `runToolsFn` → spans, the chain is covered end to end.
 *
 * The registry §8 names this the first cut of the critic investigation because
 * it unblocks three registered failures at once: F9.1 goes away, F1.5 (was
 * ripgrep actually running for 68 days?) becomes answerable from the next
 * review onward, and F4.1's vacuous `[].every(...)` gets an observable input.
 */
import { describe, expect, test } from "bun:test";
import type { ProjectCapabilities } from "../../src/critic/capabilities";
import { runToolsPhase } from "../../src/critic/phases/tools";
import { type RunCriticDeps, type RunCriticOpts, runCritic } from "../../src/critic/run-critic";
import type { runTools as defaultRunTools } from "../../src/critic/tools/run-tools";
import type { ToolName, ToolResult } from "../../src/critic/tools/types";
import { Tracer } from "../../src/observability/tracer";
import type { Span } from "../../src/observability/types";

type RunToolsOpts = Parameters<typeof defaultRunTools>[0];
type RunToolsResult = Awaited<ReturnType<typeof defaultRunTools>>;

class FakeTraceStore {
  spans: Span[] = [];
  async writeSpan(span: Span): Promise<void> { this.spans.push(span); }
  getSpansByTrace(_trace_id: string): Span[] { return this.spans; }
  getTracesByCritique(_critique_id: string): string[] { return []; }
}

function makeCaps(): ProjectCapabilities {
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
  };
}

function notApplicable(tool: ToolName): ToolResult {
  return { tool, status: "not_applicable", parsed: [], raw: "" } as ToolResult;
}

function makeAllNotApplicable(): RunToolsResult {
  return {
    tsc: notApplicable("tsc"),
    eslint: notApplicable("eslint"),
    "git-diff": notApplicable("git-diff"),
    ripgrep: notApplicable("ripgrep"),
    securityFindings: [],
    owaspHints: [],
    webSearchSources: [],
  } as RunToolsResult;
}

describe("F9.1 — the tools phase forwards its tracing context", () => {
  /** Run the phase with a tracing context, returning what runToolsFn saw. */
  async function capture(withTracing: boolean): Promise<{
    seen: RunToolsOpts | null;
    parentSpan: Span;
  }> {
    const tracer = new Tracer();
    const store = new FakeTraceStore();
    const parentSpan = tracer.startSpan({ name: "siltpoke.turn", kind: "INTERNAL" });

    let seen: RunToolsOpts | null = null;
    const runToolsFn = (async (opts: RunToolsOpts) => {
      seen = opts;
      return makeAllNotApplicable();
    }) as typeof defaultRunTools;

    await runToolsPhase({
      cwd: "/tmp/test",
      changedFiles: ["src/foo.ts"],
      caps: makeCaps(),
      homeBase: undefined,
      source: "stop-hook",
      sessionId: "sess-001",
      runToolsFn,
      tracing: withTracing
        ? { tracer, traceStore: store as never, parentSpan }
        : undefined,
    });

    return { seen, parentSpan };
  }

  test("runToolsFn receives the tracer, the store, and the turn span as parent", async () => {
    const { seen, parentSpan } = await capture(true);

    expect(seen).not.toBeNull();
    const tracing = seen?.tracing;
    expect(tracing).toBeDefined();
    expect(tracing?.tracer).toBeDefined();
    expect(tracing?.traceStore).toBeDefined();
    // Parented to the turn span, so the four tool spans hang under the review
    // they belong to instead of opening four orphan traces.
    expect(tracing?.parentSpan.span_id).toBe(parentSpan.span_id);
    expect(tracing?.parentSpan.trace_id).toBe(parentSpan.trace_id);
  });

  test("no tracing context in, none forwarded out (back-compat)", async () => {
    const { seen } = await capture(false);

    expect(seen).not.toBeNull();
    expect(seen?.tracing).toBeUndefined();
  });
});

describe("F9.1 — runCritic hands the tools phase its tracing context", () => {
  /** Run a full critic turn, returning the opts `runTools` was called with. */
  async function runAndCapture(traced: boolean): Promise<RunToolsOpts | null> {
    const tracer = new Tracer();
    const store = new FakeTraceStore();

    let seen: RunToolsOpts | null = null;
    const runToolsFn = (async (opts: RunToolsOpts) => {
      seen = opts;
      return makeAllNotApplicable();
    }) as typeof defaultRunTools;

    const deps: RunCriticDeps = {
      runToolsFn,
      callBrainFn: async () => ({
        output: {
          mood: "happy",
          pose: "base",
          bubble_short: "Clean",
          critique_for_claude: "",
          evidence: [],
          confidence: "high",
          reasoning: "",
        } as never,
        usage: {
          cache_creation_input_tokens: 0,
          cache_read_input_tokens: 0,
          input_tokens: 50,
          output_tokens: 20,
          total_cost_usd: 0,
        },
      }),
      writeCritiqueFn: async () => ({ id: "c-tool-spans", path: "/tmp" }),
    };

    const opts: RunCriticOpts = {
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
      ...(traced ? { tracer: tracer as never, traceStore: store as never } : {}),
    };

    await runCritic(opts, deps);
    return seen;
  }

  test("a traced turn reaches runTools with a context parented to the turn span", async () => {
    const seen = await runAndCapture(true);

    expect(seen).not.toBeNull();
    const tracing = seen?.tracing;
    expect(tracing).toBeDefined();
    // The parent must be the turn's own root span — `siltpoke.turn` is what
    // `runCritic` opens first and what every other child span hangs under.
    expect(tracing?.parentSpan.name).toBe("siltpoke.turn");
  });

  test("an untraced turn reaches runTools with no context at all", async () => {
    const seen = await runAndCapture(false);

    expect(seen).not.toBeNull();
    expect(seen?.tracing).toBeUndefined();
  });
});
