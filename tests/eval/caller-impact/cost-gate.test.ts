import { describe, expect, test } from "bun:test";
import {
  checkGate,
  CostCeilingExceeded,
  projectSpend,
  SpendTracker,
} from "../../../src/eval/caller-impact/cost-gate";

describe("projectSpend", () => {
  test("arithmetic: arm + grader upper bound", () => {
    const p = projectSpend({ estimatedArmCalls: 100, estimatedGraderCallsUpperBound: 100 }, 0.01, 0.02);
    expect(p.projectedUsd).toBeCloseTo(3.0, 5); // 100×0.01 + 100×0.02
  });
});

describe("checkGate", () => {
  const proj = projectSpend({ estimatedArmCalls: 100, estimatedGraderCallsUpperBound: 100 }, 0.01, 0.02);

  test("no ceiling → refused", () => {
    expect(checkGate(proj, undefined).ok).toBe(false);
  });
  test("ceiling <= 0 → refused", () => {
    expect(checkGate(proj, 0).ok).toBe(false);
  });
  test("projection over ceiling → refused", () => {
    expect(checkGate(proj, 1.0).ok).toBe(false); // $3 projected > $1
  });
  test("projection within ceiling → ok", () => {
    expect(checkGate(proj, 5.0).ok).toBe(true);
  });
});

describe("SpendTracker", () => {
  test("accumulates and stays under ceiling", () => {
    const t = new SpendTracker(1.0);
    t.add(0.3);
    t.add(0.3);
    expect(t.spentUsd).toBeCloseTo(0.6, 5);
  });
  test("throws the instant cumulative spend crosses the ceiling", () => {
    const t = new SpendTracker(0.5);
    t.add(0.3);
    expect(() => t.add(0.3)).toThrow(CostCeilingExceeded);
    expect(t.spentUsd).toBeCloseTo(0.6, 5); // recorded the overrun before throwing
  });
  test("null/undefined cost contributes nothing", () => {
    const t = new SpendTracker(1.0);
    t.add(null);
    t.add(undefined);
    expect(t.spentUsd).toBe(0);
  });
});
