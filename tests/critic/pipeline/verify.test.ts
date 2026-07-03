import { describe, test, expect, mock } from "bun:test";
import { runVerifier } from "../../../src/critic/pipeline/verify";
import type { RubricTrigger } from "../../../src/critic/rubric/types";
import type { BrainOutputV2 } from "../../../src/brain/schema-v2";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTrigger(rule_id: string, severity: "low" | "med" | "high"): RubricTrigger {
  return { rule_id, tier: 1, severity, file: "x.ts", line: 1, snippet: "x".repeat(20), message: "y" };
}

function makeFirstPass(confidence: "low" | "medium" | "high"): BrainOutputV2 {
  return {
    schema_version: 2,
    intent: { classification: "feature", confidence: 0.8 },
    evidence: [],
    web_sources: [],
    reasoning: "some reasoning here for the test",
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

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("runVerifier", () => {
  test('mode "off" — never calls Brain, returns triggers unchanged, ran=false', async () => {
    const callBrainVerifier = mock(async () => ({ ungrounded_ids: [] }));
    const triggers = [makeTrigger("r1", "high"), makeTrigger("r2", "low")];
    const result = await runVerifier({
      firstPass: makeFirstPass("high"),
      triggers,
      mode: "off",
      callBrainVerifier,
    });
    expect(callBrainVerifier).not.toHaveBeenCalled();
    expect(result.ran).toBe(false);
    expect(result.filtered_triggers).toEqual(triggers);
    expect(result.vetoed_rule_ids).toEqual([]);
  });

  test('mode "always" — calls Brain even when no HIGH trigger and confidence=HIGH', async () => {
    const callBrainVerifier = mock(async () => ({ ungrounded_ids: [] }));
    const triggers = [makeTrigger("r1", "low"), makeTrigger("r2", "med")];
    const result = await runVerifier({
      firstPass: makeFirstPass("high"),
      triggers,
      mode: "always",
      callBrainVerifier,
    });
    expect(callBrainVerifier).toHaveBeenCalledTimes(1);
    expect(result.ran).toBe(true);
  });

  test('mode "conditional" + confidence=HIGH + all LOW triggers — no Brain call', async () => {
    const callBrainVerifier = mock(async () => ({ ungrounded_ids: [] }));
    const triggers = [makeTrigger("r1", "low"), makeTrigger("r2", "low")];
    const result = await runVerifier({
      firstPass: makeFirstPass("high"),
      triggers,
      mode: "conditional",
      callBrainVerifier,
    });
    expect(callBrainVerifier).not.toHaveBeenCalled();
    expect(result.ran).toBe(false);
    expect(result.filtered_triggers).toEqual(triggers);
  });

  test('mode "conditional" + confidence=LOW — Brain called', async () => {
    const callBrainVerifier = mock(async () => ({ ungrounded_ids: [] }));
    const triggers = [makeTrigger("r1", "med")];
    const result = await runVerifier({
      firstPass: makeFirstPass("low"),
      triggers,
      mode: "conditional",
      callBrainVerifier,
    });
    expect(callBrainVerifier).toHaveBeenCalledTimes(1);
    expect(result.ran).toBe(true);
  });

  test('mode "conditional" + any HIGH trigger — Brain called', async () => {
    const callBrainVerifier = mock(async () => ({ ungrounded_ids: [] }));
    const triggers = [makeTrigger("r1", "low"), makeTrigger("r2", "high")];
    const result = await runVerifier({
      firstPass: makeFirstPass("medium"),
      triggers,
      mode: "conditional",
      callBrainVerifier,
    });
    expect(callBrainVerifier).toHaveBeenCalledTimes(1);
    expect(result.ran).toBe(true);
  });

  test("verifier returns ungrounded_ids containing a HIGH trigger id — that HIGH dropped from filtered output", async () => {
    const highId = "r-high";
    const lowId = "r-low";
    const callBrainVerifier = mock(async () => ({ ungrounded_ids: [highId] }));
    const triggers = [makeTrigger(highId, "high"), makeTrigger(lowId, "low")];
    const result = await runVerifier({
      firstPass: makeFirstPass("high"),
      triggers,
      mode: "always",
      callBrainVerifier,
    });
    expect(result.vetoed_rule_ids).toEqual([highId]);
    expect(result.filtered_triggers.map(t => t.rule_id)).not.toContain(highId);
    expect(result.filtered_triggers.map(t => t.rule_id)).toContain(lowId);
  });
});
