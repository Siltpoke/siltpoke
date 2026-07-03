import { describe, expect, test } from "bun:test";
import { injectEverythingPolicy, injectNothingPolicy, keywordPolicy } from "../../../src/eval/episodic-oracle/reference";
import { formatOracleReport, runOracle } from "../../../src/eval/episodic-oracle/run";
import type { OracleFixture } from "../../../src/eval/episodic-oracle/types";

const fixtures: OracleFixture[] = [
  {
    id: "pos-1",
    kind: "positive",
    scenario: { id: "s", intent: "bugfix", files: [], summary: "missing null guard auth crash" },
    store: [{ id: "rel", text: "you forgot a null guard in auth before", ts: "2026-06-01T00:00:00Z", confidence: 0.9 }],
    expect: { must_inject: ["rel"], must_not_inject: [], must_abstain: false },
    must_not_regress: true,
  },
  {
    id: "dist-1",
    kind: "distractor",
    scenario: { id: "s", intent: "bugfix", files: [], summary: "zzzz qqqq wwww" },
    store: [{ id: "trap", text: "completely unrelated styling note", ts: "2026-06-01T00:00:00Z", confidence: 0.9 }],
    expect: { must_inject: [], must_not_inject: ["trap"], must_abstain: true },
    must_not_regress: true,
  },
];

describe("runOracle teeth", () => {
  test("good keyword policy passes positives + abstains distractors", () => {
    const run = runOracle(fixtures, keywordPolicy);
    expect(run.aggregate.wrong_injection_rate).toBe(0);
    expect(run.aggregate.inject_recall).toBe(1);
    expect(run.aggregate.must_not_regress_pass).toBe(true);
  });
  test("inject-everything is CAUGHT (the oracle has teeth)", () => {
    const run = runOracle(fixtures, injectEverythingPolicy);
    expect(run.aggregate.wrong_injection_rate).toBeGreaterThan(0);
    expect(run.aggregate.must_not_regress_pass).toBe(false);
    expect(formatOracleReport(run)).toContain("FAIL");
  });
  test("inject-nothing fails positive recall", () => {
    const run = runOracle(fixtures, injectNothingPolicy);
    expect(run.aggregate.inject_recall).toBeLessThan(1);
    expect(run.aggregate.abstain_correctness).toBe(1);
  });
});
