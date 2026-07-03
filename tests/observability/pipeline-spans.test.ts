import { describe, test, expect } from "bun:test";
import { runPipeline } from "../../src/critic/pipeline/runner";
import { Tracer } from "../../src/observability/tracer";
import type { TraceStore } from "../../src/observability/storage";
import type { Span } from "../../src/observability/types";
import type { BrainOutputV2 } from "../../src/brain/schema-v2";

// ---------------------------------------------------------------------------
// Mock TraceStore that captures written spans in-memory
// ---------------------------------------------------------------------------

class MockTraceStore {
  spans: Span[] = [];
  async writeSpan(span: Span): Promise<void> {
    this.spans.push(span);
  }
  getSpansByTrace(_: string): Span[] { return []; }
  getTracesByCritique(_: string): string[] { return []; }
}

function makeFirstPass(): BrainOutputV2 {
  return {
    schema_version: 2,
    intent: { classification: "feature", confidence: 0.8 },
    evidence: [],
    web_sources: [],
    reasoning: "some reasoning here for pipeline test",
    category: "correctness",
    severity: "info",
    confidence: "medium",
    critique_for_claude: "looks ok",
    mood: "watching",
    pose: "base",
    bubble_short: "short",
    bubble_long: "",
    xp_earned_events: [],
  };
}

describe("pipeline span emission", () => {
  test("emits >=6 spans with correct parent chain when tracer+store provided", async () => {
    const tracer = new Tracer();
    const store = new MockTraceStore();

    await runPipeline({
      cwd: "/tmp",
      changedFiles: [],
      diffHunks: [],
      callBrainFind: async () => makeFirstPass(),
      callBrainVerifier: async () => ({ ungrounded_ids: [] }),
      verifierMode: "always",
      critiqueId: "test-critique-99",
      tracer,
      traceStore: store as unknown as TraceStore,
    });

    expect(store.spans.length).toBeGreaterThanOrEqual(6);

    const root = store.spans.find(s => s.name === "siltpoke.turn");
    expect(root).toBeDefined();
    expect(root!.parent_span_id).toBeNull();
    expect(root!.attributes["siltpoke.critique_id"]).toBe("test-critique-99");

    // All non-root spans should point to root as parent
    const children = store.spans.filter(s => s.name !== "siltpoke.turn");
    for (const child of children) {
      expect(child.parent_span_id).toBe(root!.span_id);
    }

    // All spans share the same trace_id
    const traceIds = new Set(store.spans.map(s => s.trace_id));
    expect(traceIds.size).toBe(1);

    // Key span names should be present
    const names = store.spans.map(s => s.name);
    expect(names).toContain("siltpoke.rubric.tier1");
    expect(names).toContain("siltpoke.brain.find");
    expect(names).toContain("siltpoke.prioritize");
    expect(names).toContain("siltpoke.brain.verify");
  });

  test("no spans emitted when tracer/store absent (silent mode)", async () => {
    // Run without tracer/traceStore — should not throw, result should be normal
    const result = await runPipeline({
      cwd: "/tmp",
      changedFiles: [],
      diffHunks: [],
      callBrainFind: async () => makeFirstPass(),
      callBrainVerifier: async () => ({ ungrounded_ids: [] }),
      verifierMode: "off",
    });

    expect(Array.isArray(result.rubricTriggers)).toBe(true);
    expect(result.verifier.ran).toBe(false);
  });
});
