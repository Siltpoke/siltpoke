/**
 * Tests for autoPromoteSeverity() — Issue 2 from post-ship bug pack.
 *
 * Rule: when Brain emits severity=info but rubric triggers (med/high) or
 * diff-summary risks exist, force-elevate to "low" and populate
 * critique_for_claude from the evidence. Never demote; never false-promote.
 */

import { test, expect, describe } from "bun:test";
import { autoPromoteSeverity } from "../../src/critic/run-critic";
import type { BrainOutput } from "../../src/brain/schema";
import type { V2ResultFields } from "../../src/critic/run-critic";
import type { DiffSummary } from "../../src/critic/tools/run-diff-summary";
import type { RubricTrigger } from "../../src/critic/rubric/types";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeBrainOutput(overrides?: Partial<BrainOutput>): BrainOutput {
  return {
    mood: "happy",
    pose: "base",
    bubble_short: "干净！",
    bubble_long: "",
    critique_for_claude: "",
    severity: "info",
    confidence: "high",
    xp_earned_events: [],
    evidence: [],
    ...overrides,
  };
}

function makeMedTrigger(overrides?: Partial<RubricTrigger>): RubricTrigger {
  return {
    rule_id: "god-file",
    tier: 1,
    severity: "med",
    file: "src/large-module.ts",
    line: 1,
    snippet: "// 900-line module",
    message: "File exceeds 800-line limit (900 lines)",
    ...overrides,
  };
}

function makeHighTrigger(overrides?: Partial<RubricTrigger>): RubricTrigger {
  return {
    rule_id: "long-param-list",
    tier: 2,
    severity: "high",
    file: "src/access/check.ts",
    line: 12,
    snippet: "function checkAccess(a, b, c, d, e, f)",
    message: "Function has 6 positional parameters (max 4)",
    ...overrides,
  };
}

function makeLowTrigger(overrides?: Partial<RubricTrigger>): RubricTrigger {
  return {
    rule_id: "narrating-comment",
    tier: 2,
    severity: "low",
    file: "src/foo.ts",
    line: 5,
    snippet: "// increment counter",
    message: "Narrating comment detected",
    ...overrides,
  };
}

function makeV2(triggers: RubricTrigger[] = []): V2ResultFields {
  return {
    pipelineRan: true,
    rubricTriggers: triggers,
  };
}

function makeDiffSummary(risks: string[] = []): DiffSummary {
  return {
    intent: "Refactor auth module",
    key_changes: ["Extracted helper"],
    risks,
    file_count: 2,
    files_with_purpose: [],
    source: "haiku",
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("autoPromoteSeverity — promotion cases", () => {
  test("info + rubric med trigger → promoted to low, critique populated", () => {
    const critique = makeBrainOutput({ severity: "info", critique_for_claude: "" });
    const v2 = makeV2([makeMedTrigger()]);

    autoPromoteSeverity(critique, v2, undefined);

    expect(critique.severity).toBe("low");
    expect(critique.critique_for_claude.length).toBeGreaterThan(0);
    expect(critique.critique_for_claude).toContain("god-file");
  });

  test("info + rubric high trigger → promoted to low, critique populated", () => {
    const critique = makeBrainOutput({ severity: "info", critique_for_claude: "" });
    const v2 = makeV2([makeHighTrigger()]);

    autoPromoteSeverity(critique, v2, undefined);

    expect(critique.severity).toBe("low");
    expect(critique.critique_for_claude).toContain("long-param-list");
  });

  test("info + risks present → promoted to low, critique populated with risks", () => {
    const critique = makeBrainOutput({ severity: "info", critique_for_claude: "" });
    const v2 = makeV2();
    const diffSummary = makeDiffSummary(["Missing null check in auth path", "Potential race condition"]);

    autoPromoteSeverity(critique, v2, diffSummary);

    expect(critique.severity).toBe("low");
    expect(critique.critique_for_claude).toContain("Missing null check");
    expect(critique.critique_for_claude).toContain("Haiku pre-pass");
  });

  test("info + med trigger + risks → both cited in critique_for_claude", () => {
    const critique = makeBrainOutput({ severity: "info", critique_for_claude: "" });
    const v2 = makeV2([makeMedTrigger()]);
    const diffSummary = makeDiffSummary(["Risk: potential XSS"]);

    autoPromoteSeverity(critique, v2, diffSummary);

    expect(critique.severity).toBe("low");
    expect(critique.critique_for_claude).toContain("god-file");
    expect(critique.critique_for_claude).toContain("Risk: potential XSS");
  });

  test("happy mood nudged to concerned after promotion", () => {
    const critique = makeBrainOutput({ mood: "happy", severity: "info", critique_for_claude: "" });
    const v2 = makeV2([makeMedTrigger()]);

    autoPromoteSeverity(critique, v2, undefined);

    expect(critique.mood).toBe("concerned");
  });

  test("non-empty critique_for_claude preserved (not overwritten) during promotion", () => {
    const originalText = "Be careful with the auth flow.";
    const critique = makeBrainOutput({ severity: "info", critique_for_claude: originalText });
    const v2 = makeV2([makeMedTrigger()]);

    autoPromoteSeverity(critique, v2, undefined);

    // Still promoted
    expect(critique.severity).toBe("low");
    // Original text preserved — auto-populate only when empty
    expect(critique.critique_for_claude).toBe(originalText);
  });
});

describe("autoPromoteSeverity — no-op cases", () => {
  test("info + no triggers + no risks → stays info (no false promotion)", () => {
    const critique = makeBrainOutput({ severity: "info", critique_for_claude: "" });
    const v2 = makeV2();

    autoPromoteSeverity(critique, v2, undefined);

    expect(critique.severity).toBe("info");
    expect(critique.critique_for_claude).toBe("");
  });

  test("info + only low-severity triggers → stays info (low triggers don't promote)", () => {
    const critique = makeBrainOutput({ severity: "info", critique_for_claude: "" });
    const v2 = makeV2([makeLowTrigger()]);

    autoPromoteSeverity(critique, v2, undefined);

    expect(critique.severity).toBe("info");
  });

  test("med severity + triggers → stays med (no demotion)", () => {
    const critique = makeBrainOutput({ severity: "medium", critique_for_claude: "Real concern." });
    const v2 = makeV2([makeMedTrigger()]);

    autoPromoteSeverity(critique, v2, undefined);

    expect(critique.severity).toBe("medium");
    expect(critique.critique_for_claude).toBe("Real concern.");
  });

  test("high severity + triggers → stays high (no demotion)", () => {
    const critique = makeBrainOutput({ severity: "high", critique_for_claude: "Critical." });
    const v2 = makeV2([makeHighTrigger()]);

    autoPromoteSeverity(critique, v2, undefined);

    expect(critique.severity).toBe("high");
  });

  test("info + empty risks array → stays info", () => {
    const critique = makeBrainOutput({ severity: "info", critique_for_claude: "" });
    const v2 = makeV2();
    const diffSummary = makeDiffSummary([]);

    autoPromoteSeverity(critique, v2, diffSummary);

    expect(critique.severity).toBe("info");
  });
});
