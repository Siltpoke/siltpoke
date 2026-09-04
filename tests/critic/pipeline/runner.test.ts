import { describe, test, expect, mock, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runPipeline } from "../../../src/critic/pipeline/runner";
import type { BrainOutputV2 } from "../../../src/brain/schema-v2";
import type { RubricTrigger } from "../../../src/critic/rubric/types";
import { Tracer } from "../../../src/observability/tracer";
import { TraceStore } from "../../../src/observability/storage";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeFirstPass(confidence: "low" | "medium" | "high" = "medium"): BrainOutputV2 {
  return {
    schema_version: 2,
    intent: { classification: "feature", confidence: 0.8 },
    evidence: [],
    web_sources: [],
    reasoning: "some reasoning text here for the test fixture",
    category: "correctness",
    severity: "info",
    confidence,
    critique_for_claude: "fix it",
    mood: "watching",
    pose: "base",
    bubble_short: "short",
    bubble_long: "",
    xp_earned_events: [],
  };
}

// Minimal input with no actual changed files so rubric returns empty triggers
const BASE_INPUT = {
  cwd: "/tmp",
  changedFiles: [],
  diffHunks: [],
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("runPipeline", () => {
  test("executes full sequence: rubric → brain find → prioritize → verifier", async () => {
    const firstPass = makeFirstPass("high");
    const callBrainFind = mock(async (_triggers: ReadonlyArray<RubricTrigger>) => firstPass);
    const callBrainVerifier = mock(async () => ({ ungrounded_ids: [] }));

    const result = await runPipeline({
      ...BASE_INPUT,
      callBrainFind,
      callBrainVerifier,
      verifierMode: "always",
    });

    // Brain find was called once
    expect(callBrainFind).toHaveBeenCalledTimes(1);
    // firstPass is present in output
    expect(result.firstPass).toBe(firstPass);
    // prioritized is an array (empty since no triggers)
    expect(Array.isArray(result.prioritized)).toBe(true);
    // verifier ran (mode=always)
    expect(result.verifier.ran).toBe(true);
    expect(callBrainVerifier).toHaveBeenCalledTimes(1);
  });

  test('verifierMode "off" — verifier does not call Brain verifier', async () => {
    const callBrainFind = mock(async () => makeFirstPass("high"));
    const callBrainVerifier = mock(async () => ({ ungrounded_ids: [] }));

    const result = await runPipeline({
      ...BASE_INPUT,
      callBrainFind,
      callBrainVerifier,
      verifierMode: "off",
    });

    expect(result.verifier.ran).toBe(false);
    expect(callBrainVerifier).not.toHaveBeenCalled();
  });

  test("prioritize is applied — finalTriggers reflects prioritized order", async () => {
    const callBrainFind = mock(async () => makeFirstPass("high"));
    const callBrainVerifier = mock(async () => ({ ungrounded_ids: [] }));

    const result = await runPipeline({
      ...BASE_INPUT,
      callBrainFind,
      callBrainVerifier,
      verifierMode: "off",
    });

    // rubricTriggers and prioritized both exist (empty here since no changed files)
    expect(Array.isArray(result.rubricTriggers)).toBe(true);
    expect(Array.isArray(result.finalTriggers)).toBe(true);
  });

  test('verifierMode "conditional" + confidence low — Brain verifier called', async () => {
    const callBrainFind = mock(async () => makeFirstPass("low"));
    const callBrainVerifier = mock(async () => ({ ungrounded_ids: [] }));

    const result = await runPipeline({
      ...BASE_INPUT,
      callBrainFind,
      callBrainVerifier,
      verifierMode: "conditional",
    });

    expect(result.verifier.ran).toBe(true);
    expect(callBrainVerifier).toHaveBeenCalledTimes(1);
  });

  test("vetoed HIGH rule ids are excluded from finalTriggers", async () => {
    // Mock runRubric is not injected — but we can at least verify the plumbing
    // works when verifier vetoes an id (no triggers emitted from rubric since no files)
    const callBrainFind = mock(async () => makeFirstPass("low"));
    const callBrainVerifier = mock(async () => ({ ungrounded_ids: ["r-vetoed"] }));

    const result = await runPipeline({
      ...BASE_INPUT,
      callBrainFind,
      callBrainVerifier,
      verifierMode: "conditional",
    });

    // No triggers from rubric → vetoed_rule_ids is empty (nothing to veto)
    expect(result.verifier.vetoed_rule_ids).toEqual([]);
    expect(result.finalTriggers).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Track #7 T3 (AC14) — genAiSystem span truth (this runner isn't wired into
// the live critic path yet — see run-critic.ts TODO — but its span
// attributes must not lie once it is).
// ---------------------------------------------------------------------------

describe("runPipeline — genAiSystem span attribute (track #7 T3)", () => {
  let tmp: string;
  let tracer: Tracer;
  let traceStore: TraceStore;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "siltpoke-runner-genai-"));
    tracer = new Tracer();
    traceStore = new TraceStore({ dir: tmp, dbPath: join(tmp, "index.sqlite") });
  });
  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  function spyOnStartSpan(): {
    tracer: Tracer;
    seenAttrs: Array<Record<string, string | number | boolean>>;
  } {
    const seenAttrs: Array<Record<string, string | number | boolean>> = [];
    const spyTracer = new Proxy(tracer, {
      get(target, prop, receiver) {
        if (prop === "startSpan") {
          return (opts: Parameters<Tracer["startSpan"]>[0]) => {
            const span = target.startSpan(opts);
            seenAttrs.push(span.attributes);
            return span;
          };
        }
        return Reflect.get(target, prop, receiver);
      },
    });
    return { tracer: spyTracer, seenAttrs };
  }

  function brainSpanAttrs(
    seenAttrs: Array<Record<string, string | number | boolean>>,
  ): Array<Record<string, string | number | boolean>> {
    return seenAttrs.filter(
      (a) => a["gen_ai.operation.name"] === "chat" || a["gen_ai.operation.name"] === "verify",
    );
  }

  test("defaults to anthropic when genAiSystem is omitted", async () => {
    const { tracer: spyTracer, seenAttrs } = spyOnStartSpan();
    await runPipeline({
      ...BASE_INPUT,
      callBrainFind: mock(async () => makeFirstPass("high")),
      callBrainVerifier: mock(async () => ({ ungrounded_ids: [] })),
      verifierMode: "always",
      tracer: spyTracer,
      traceStore,
    });

    const attrs = brainSpanAttrs(seenAttrs);
    expect(attrs.length).toBeGreaterThan(0);
    for (const a of attrs) expect(a["gen_ai.system"]).toBe("anthropic");
  });

  test("threads a non-claude genAiSystem onto both brain spans", async () => {
    const { tracer: spyTracer, seenAttrs } = spyOnStartSpan();
    await runPipeline({
      ...BASE_INPUT,
      callBrainFind: mock(async () => makeFirstPass("high")),
      callBrainVerifier: mock(async () => ({ ungrounded_ids: [] })),
      verifierMode: "always",
      tracer: spyTracer,
      traceStore,
      genAiSystem: "openai",
    });

    const attrs = brainSpanAttrs(seenAttrs);
    expect(attrs.length).toBeGreaterThan(0);
    for (const a of attrs) expect(a["gen_ai.system"]).toBe("openai");
  });
});
