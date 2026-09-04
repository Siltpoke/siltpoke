// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
import { describe, expect, test } from "bun:test";
import { validateVerbalization } from "../../src/quiz/output-validator";

describe("validateVerbalization", () => {
  test("caving prose after contradict is rejected", () => {
    const r = validateVerbalization("Actually the edge runs the other way, but your intuition is basically right.", "contradict");
    expect(r.ok).toBe(false);
    expect(r.violations).toContain("caving_phrase:basically right");
  });
  test("agreement after abstain is rejected", () => {
    const r = validateVerbalization("You're right, both are true here.", "abstain");
    expect(r.ok).toBe(false);
  });
  test("forbidden causal connective on structural prose is rejected", () => {
    const r = validateVerbalization("daemon depends on web because it needs the dashboard renderer.", "confirm");
    expect(r.ok).toBe(false);
    expect(r.violations).toContain("causal_connective:because");
  });
  test("a clean confirm passes", () => {
    const r = validateVerbalization("Yes — the graph shows daemon depends on web.", "confirm");
    expect(r.ok).toBe(true);
    expect(r.violations).toEqual([]);
  });
  test("a clean, plainly-stated contradiction passes", () => {
    const r = validateVerbalization("The graph shows the dependency runs the other way: web depends on daemon.", "contradict");
    expect(r.ok).toBe(true);
  });
});
