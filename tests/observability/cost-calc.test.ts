/**
 * cost-calc — unit tests for token cost computation.
 *
 * haiku (no cache / cache) / sonnet / opus 4.7 / opus 4.8 / unknown defaults / zero / dated suffix
 */
import { describe, test, expect } from "bun:test";
import { computeCost } from "../../src/observability/cost-calc";

const PER_MILLION = 1_000_000;

describe("computeCost", () => {
  test("haiku no cache — charges full input + output at haiku rates", () => {
    const result = computeCost({
      input_tokens: 1_000,
      output_tokens: 200,
      cached_input_tokens: 0,
      model: "claude-haiku-4-5",
    });

    // input: 1000/1M * $1.0 = $0.001
    // output: 200/1M * $5.0 = $0.001
    // total: $0.002
    expect(result.cost_usd).toBeCloseTo(0.001 + 0.001, 8);
    expect(result.cache_savings_usd).toBe(0);
    expect(result.breakdown.billed_input).toBe(1_000);
    expect(result.breakdown.billed_cached).toBe(0);
    expect(result.breakdown.billed_output).toBe(200);
  });

  test("haiku with cache — input_tokens is EXCLUSIVE of cache reads (claude -p semantics): both billed as-is", () => {
    // Real usage blocks from claude -p follow the Anthropic API semantics:
    // input_tokens counts ONLY the non-cached prompt tokens; cache reads are
    // reported separately. A cache-heavy live turn (input 10, cached 14.9k)
    // under the old inclusive assumption clamped billed_input to 0 and read
    // a >100000% hit rate downstream.
    const result = computeCost({
      input_tokens: 1_000,
      output_tokens: 200,
      cached_input_tokens: 800,
      model: "claude-haiku-4-5",
    });

    // non-cached input: 1000/1M * $1.0 = $0.001
    // cached: 800/1M * $0.10 = $0.00008
    // output: 200/1M * $5.0 = $0.001
    const expectedCost = (1_000 / PER_MILLION) * 1.0 + (800 / PER_MILLION) * 0.10 + (200 / PER_MILLION) * 5.0;
    expect(result.cost_usd).toBeCloseTo(expectedCost, 8);

    // savings = 800 tokens * (1.0 - 0.10) / 1M
    const expectedSavings = (800 / PER_MILLION) * (1.0 - 0.10);
    expect(result.cache_savings_usd).toBeCloseTo(expectedSavings, 8);

    expect(result.breakdown.billed_input).toBe(1_000);
    expect(result.breakdown.billed_cached).toBe(800);
  });

  test("cache-heavy live shape — tiny uncached input + huge cache read never clamps to zero", () => {
    const result = computeCost({
      input_tokens: 10,
      output_tokens: 1_900,
      cached_input_tokens: 14_900,
      model: "claude-haiku-4-5",
    });
    expect(result.breakdown.billed_input).toBe(10);
    const expected =
      (10 / PER_MILLION) * 1.0 + (14_900 / PER_MILLION) * 0.10 + (1_900 / PER_MILLION) * 5.0;
    expect(result.cost_usd).toBeCloseTo(expected, 8);
  });

  test("sonnet — uses $3/M input, $0.30/M cached, $15/M output", () => {
    const result = computeCost({
      input_tokens: 2_000,
      output_tokens: 500,
      cached_input_tokens: 0,
      model: "claude-sonnet-4-6",
    });

    // input: 2000/1M * $3.0 = $0.006
    // output: 500/1M * $15.0 = $0.0075
    const expected = (2_000 / PER_MILLION) * 3.0 + (500 / PER_MILLION) * 15.0;
    expect(result.cost_usd).toBeCloseTo(expected, 8);
    expect(result.cache_savings_usd).toBe(0);
  });

  test("opus 4.7 — uses $5/M input, $0.50/M cached, $25/M output (per platform.claude.com 2026-06)", () => {
    const result = computeCost({
      input_tokens: 10_000,
      output_tokens: 1_000,
      cached_input_tokens: 5_000,
      model: "claude-opus-4-7",
    });

    // non-cached (exclusive): 10000/1M * $5 = $0.05
    // cached: 5000/1M * $0.50 = $0.0025
    // output: 1000/1M * $25 = $0.025
    const expected =
      (10_000 / PER_MILLION) * 5.0 +
      (5_000 / PER_MILLION) * 0.5 +
      (1_000 / PER_MILLION) * 25.0;
    expect(result.cost_usd).toBeCloseTo(expected, 8);

    // savings = 5000 * (5 - 0.5) / 1M
    const expectedSavings = (5_000 / PER_MILLION) * (5.0 - 0.5);
    expect(result.cache_savings_usd).toBeCloseTo(expectedSavings, 8);
  });

  test("opus 4.8 — current model resolves to opus rates, not the haiku default", () => {
    const result = computeCost({
      input_tokens: 1_000,
      output_tokens: 1_000,
      cached_input_tokens: 0,
      model: "claude-opus-4-8",
    });

    // input: 1000/1M * $5 = $0.005 ; output: 1000/1M * $25 = $0.025
    const expected = (1_000 / PER_MILLION) * 5.0 + (1_000 / PER_MILLION) * 25.0;
    expect(result.cost_usd).toBeCloseTo(expected, 8);
  });

  test("unknown model — defaults to haiku rates", () => {
    const resultUnknown = computeCost({
      input_tokens: 1_000,
      output_tokens: 200,
      cached_input_tokens: 0,
      model: "some-future-model-xyz",
    });

    const resultHaiku = computeCost({
      input_tokens: 1_000,
      output_tokens: 200,
      cached_input_tokens: 0,
      model: "claude-haiku-4-5",
    });

    expect(resultUnknown.cost_usd).toBeCloseTo(resultHaiku.cost_usd, 10);
    expect(resultUnknown.cache_savings_usd).toBe(0);
  });

  test("zero tokens — returns zero cost and zero savings", () => {
    const result = computeCost({
      input_tokens: 0,
      output_tokens: 0,
      cached_input_tokens: 0,
      model: "claude-haiku-4-5",
    });
    expect(result.cost_usd).toBe(0);
    expect(result.cache_savings_usd).toBe(0);
  });

  test("dated model variant — haiku date suffix resolves correctly", () => {
    const result = computeCost({
      input_tokens: 1_000,
      output_tokens: 0,
      cached_input_tokens: 0,
      model: "claude-haiku-4-5-20251001",
    });
    // Should use haiku rate: 1000/1M * $1.0 = $0.001
    expect(result.cost_usd).toBeCloseTo(0.001, 8);
  });
});
