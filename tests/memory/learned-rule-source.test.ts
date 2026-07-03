import { test, expect } from "bun:test";
import { learnedRuleSchema } from "../../src/memory/memory";

test("learnedRuleSchema accepts an optional source field", () => {
  const withSource = learnedRuleSchema.parse({
    id: "lr-1",
    rule: "r",
    category: "c",
    created_at: new Date().toISOString(),
    applied_count: 0,
    effectiveness: "good",
    source: "from dismissing critique c-1: because X",
  });
  expect(withSource.source).toBe("from dismissing critique c-1: because X");

  // still parses without source (backward compat)
  const withoutSource = learnedRuleSchema.parse({
    id: "lr-2",
    rule: "r",
    category: "c",
    created_at: new Date().toISOString(),
    applied_count: 0,
    effectiveness: "good",
  });
  expect(withoutSource.source).toBeUndefined();
});
