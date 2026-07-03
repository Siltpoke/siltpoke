// tests/eval/episodic-oracle/corpus.test.ts
import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { injectEverythingPolicy, keywordPolicy } from "../../../src/eval/episodic-oracle/reference";
import { runOracle } from "../../../src/eval/episodic-oracle/run";
import { loadOracleFixtures } from "../../../src/eval/episodic-oracle/types";

const DIR = join(import.meta.dir, "../../../src/eval/episodic-oracle/fixtures");

describe("control fixture corpus", () => {
  test("every fixture validates and kinds are covered", async () => {
    const fx = await loadOracleFixtures(DIR);
    expect(fx.length).toBeGreaterThanOrEqual(5);
    const kinds = new Set(fx.map((f) => f.kind));
    expect(kinds.has("positive")).toBe(true);
    expect(kinds.has("distractor")).toBe(true);
    expect(kinds.has("mixed")).toBe(true);
  });

  test("good keyword policy: 0 wrong-injection, positive recall = 1, must-not-regress PASS", async () => {
    const fx = await loadOracleFixtures(DIR);
    const run = runOracle(fx, keywordPolicy);
    expect(run.aggregate.wrong_injection_rate).toBe(0);
    expect(run.aggregate.inject_recall).toBe(1);
    expect(run.aggregate.must_not_regress_pass).toBe(true);
  });

  test("inject-everything is caught over the real corpus (teeth)", async () => {
    const fx = await loadOracleFixtures(DIR);
    const run = runOracle(fx, injectEverythingPolicy);
    expect(run.aggregate.wrong_injection_rate).toBeGreaterThan(0);
    expect(run.aggregate.must_not_regress_pass).toBe(false);
  });
});
