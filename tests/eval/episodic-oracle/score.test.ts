import { describe, expect, test } from "bun:test";
import { aggregateScores, scoreFixture } from "../../../src/eval/episodic-oracle/score";
import type { OracleFixture, RetrievalDecision } from "../../../src/eval/episodic-oracle/types";

const posFix: OracleFixture = {
  id: "pos-1",
  kind: "positive",
  scenario: { id: "s", intent: "bugfix", files: [], summary: "x" },
  store: [{ id: "m1", text: "t", ts: "2026-06-01T00:00:00Z", confidence: 0.9 }],
  expect: { must_inject: ["m1"], must_not_inject: [], must_abstain: false },
};
const distFix: OracleFixture = {
  id: "dist-1",
  kind: "distractor",
  scenario: { id: "s", intent: "bugfix", files: [], summary: "x" },
  store: [{ id: "m9", text: "t", ts: "2026-06-01T00:00:00Z", confidence: 0.9 }],
  expect: { must_inject: [], must_not_inject: ["m9"], must_abstain: true },
  must_not_regress: true,
};

describe("scoreFixture", () => {
  test("positive: injecting the right id passes", () => {
    const d: RetrievalDecision = { injected: ["m1"], abstained: false };
    expect(scoreFixture(posFix, d).passed).toBe(true);
  });
  test("distractor: injecting the trap fails with wrong-injection", () => {
    const d: RetrievalDecision = { injected: ["m9"], abstained: false };
    const s = scoreFixture(distFix, d);
    expect(s.passed).toBe(false);
    expect(s.failures.join(" ")).toContain("wrong-injection m9");
  });
  test("abstained=true but injected non-empty trips the invariant", () => {
    const d: RetrievalDecision = { injected: ["m1"], abstained: true };
    expect(scoreFixture(posFix, d).failures.join(" ")).toContain("invariant");
  });
});

describe("aggregateScores", () => {
  test("wrong-injection-rate + must_not_regress catch a leak", () => {
    const agg = aggregateScores([
      { fixture: posFix, decision: { injected: ["m1"], abstained: false } },
      { fixture: distFix, decision: { injected: ["m9"], abstained: false } },
    ]);
    expect(agg.wrong_injection_rate).toBe(1);
    expect(agg.must_not_regress_pass).toBe(false);
    expect(agg.inject_recall).toBe(1);
  });
  test("clean run: zero wrong-injection, abstain correct", () => {
    const agg = aggregateScores([
      { fixture: posFix, decision: { injected: ["m1"], abstained: false } },
      { fixture: distFix, decision: { injected: [], abstained: true } },
    ]);
    expect(agg.wrong_injection_rate).toBe(0);
    expect(agg.abstain_correctness).toBe(1);
    expect(agg.must_not_regress_pass).toBe(true);
  });
});
