import { describe, test, expect } from "bun:test";
import { parseBrainOutputV2 } from "../../src/brain/schema-v2";

describe("brain schema v2", () => {
  test("accepts v2 output with all new fields", () => {
    const valid = {
      schema_version: 2,
      intent: { classification: "bugfix" as const, confidence: 0.9 },
      evidence: [{
        rule_id: "god-file", tier: 1 as const, file: "src/foo.ts", line: 800,
        snippet: "x".repeat(20), signal_source: "rubric-tier1" as const,
      }],
      web_sources: [],
      reasoning: "File exceeds 800-line threshold; flagged HIGH.",
      category: "design" as const,
      severity: "high" as const,
      confidence: "high" as const,
      critique_for_claude: "src/foo.ts is 1200 lines — split it.",
      suggested_fix: "Extract auth/ subdir",
      mood: "concerned" as const,
      pose: "base" as const,
      bubble_short: "ouch big file",
      bubble_long: "",
      xp_earned_events: [],
    };
    const parsed = parseBrainOutputV2(valid);
    expect(parsed.category).toBe("design");
    expect(parsed.intent.classification).toBe("bugfix");
  });

  test("rejects missing signal_source", () => {
    const bad = { /* missing signal_source on evidence */ };
    expect(() => parseBrainOutputV2(bad)).toThrow();
  });

  test("field order preserved when serialized (reasoning before verdict)", () => {
    const v: any = {
      schema_version: 2,
      intent: { classification: "exploration", confidence: 0.3 },
      evidence: [], web_sources: [],
      reasoning: "test", category: "readability",
      severity: "info", confidence: "low",
      critique_for_claude: "",
      mood: "idle", pose: "base", bubble_short: "ok", bubble_long: "",
      xp_earned_events: [],
    };
    const parsed = parseBrainOutputV2(v);
    const json = JSON.stringify(parsed);
    expect(json.indexOf("reasoning")).toBeLessThan(json.indexOf("severity"));
  });
});
