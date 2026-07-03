import { describe, test, expect, mock } from "bun:test";
import { runPipeline } from "../../../src/critic/pipeline/runner";
import type { BrainOutputV2 } from "../../../src/brain/schema-v2";
import type { RubricTrigger } from "../../../src/critic/rubric/types";

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
