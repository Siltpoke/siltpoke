import { describe, test, expect } from "bun:test";
import { ALL_RUBRIC_RULES } from "../../../src/critic/rubric/rules";

describe("ALL_RUBRIC_RULES registration", () => {
  test("contains 13 rules total", () => {
    expect(ALL_RUBRIC_RULES).toHaveLength(13);
  });

  test("includes repo-memory-inconsistency rule", () => {
    const ids = ALL_RUBRIC_RULES.map((r) => r.id);
    expect(ids).toContain("repo-memory-inconsistency");
  });

  test("includes repo-memory-convention rule", () => {
    const ids = ALL_RUBRIC_RULES.map((r) => r.id);
    expect(ids).toContain("repo-memory-convention");
  });

  test("all rules have valid tier (1, 2, or 3)", () => {
    for (const rule of ALL_RUBRIC_RULES) {
      expect([1, 2, 3]).toContain(rule.tier);
    }
  });
});
