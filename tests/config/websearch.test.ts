import { test, expect, describe } from "bun:test";
import { webSearchConfigSchema, shouldInvokeWebSearch } from "../../src/config/websearch";
import type { WebSearchConfig } from "../../src/config/websearch";

describe("webSearchConfigSchema", () => {
  test("defaults: mode=gated, dailyCap=20", () => {
    const config = webSearchConfigSchema.parse({});
    expect(config.mode).toBe("gated");
    expect(config.dailyCap).toBe(20);
  });

  test("accepts mode=off", () => {
    const config = webSearchConfigSchema.parse({ mode: "off" });
    expect(config.mode).toBe("off");
  });

  test("accepts mode=always with custom dailyCap", () => {
    const config = webSearchConfigSchema.parse({ mode: "always", dailyCap: 50 });
    expect(config.mode).toBe("always");
    expect(config.dailyCap).toBe(50);
  });
});

const makeConfig = (mode: WebSearchConfig["mode"], dailyCap = 20): WebSearchConfig => ({
  mode,
  dailyCap,
});

describe("shouldInvokeWebSearch", () => {
  test("mode=off always returns false", () => {
    expect(
      shouldInvokeWebSearch({
        config: makeConfig("off"),
        promptOrCritique: "check the npm api",
        confidence: "low",
        dailyUsageCount: 0,
      }),
    ).toBe(false);
  });

  test("mode=always under cap returns true", () => {
    expect(
      shouldInvokeWebSearch({
        config: makeConfig("always", 20),
        promptOrCritique: "anything",
        confidence: "high",
        dailyUsageCount: 10,
      }),
    ).toBe(true);
  });

  test("mode=always at or over cap returns false", () => {
    expect(
      shouldInvokeWebSearch({
        config: makeConfig("always", 20),
        promptOrCritique: "anything",
        confidence: "low",
        dailyUsageCount: 20,
      }),
    ).toBe(false);
  });

  test("mode=gated + high confidence → false even with matching pattern", () => {
    expect(
      shouldInvokeWebSearch({
        config: makeConfig("gated"),
        promptOrCritique: "use the npm api package",
        confidence: "high",
        dailyUsageCount: 0,
      }),
    ).toBe(false);
  });

  test("mode=gated + low confidence + matching pattern → true", () => {
    expect(
      shouldInvokeWebSearch({
        config: makeConfig("gated"),
        promptOrCritique: "check the sdk endpoint",
        confidence: "low",
        dailyUsageCount: 0,
      }),
    ).toBe(true);
  });

  test("mode=gated + med confidence + matching pattern → true", () => {
    expect(
      shouldInvokeWebSearch({
        config: makeConfig("gated"),
        promptOrCritique: "this library has an api",
        confidence: "med",
        dailyUsageCount: 5,
      }),
    ).toBe(true);
  });

  test("mode=gated + low confidence + no pattern match → false", () => {
    expect(
      shouldInvokeWebSearch({
        config: makeConfig("gated"),
        promptOrCritique: "fix the typo in variable name",
        confidence: "low",
        dailyUsageCount: 0,
      }),
    ).toBe(false);
  });

  test("mode=gated + over daily cap → false", () => {
    expect(
      shouldInvokeWebSearch({
        config: makeConfig("gated", 10),
        promptOrCritique: "check the api library",
        confidence: "low",
        dailyUsageCount: 10,
      }),
    ).toBe(false);
  });
});
