import { describe, test, expect } from "bun:test";
import { prioritize } from "../../../src/critic/pipeline/prioritize";
import type { RubricTrigger } from "../../../src/critic/rubric/types";

const t = (rule_id: string, severity: "low" | "med" | "high", file: string, line: number): RubricTrigger => ({
  rule_id, tier: 1, severity, file, line, snippet: "x".repeat(20), message: "y",
});

describe("prioritize", () => {
  test("sorts by severity (high → low)", () => {
    const r = prioritize([t("a", "low", "x.ts", 1), t("b", "high", "x.ts", 2)]);
    expect(r[0].rule_id).toBe("b");
  });

  test("dedupes same rule+file+line", () => {
    const r = prioritize([t("a", "med", "x.ts", 5), t("a", "med", "x.ts", 5)]);
    expect(r).toHaveLength(1);
  });

  test("drops LOW when count > 5 (noise gate)", () => {
    const many = Array.from({length: 10}, (_, i) => t(`r${i}`, "low", "x.ts", i));
    const r = prioritize(many);
    expect(r.filter(x => x.severity === "low")).toHaveLength(5);
  });
});
