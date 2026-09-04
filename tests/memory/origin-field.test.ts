import { test, expect } from "bun:test";
import { learnedRuleSchema } from "../../src/memory/memory";
import { selectRelevantRules } from "../../src/brain/rule-selector";

test("origin is an optional enum, zero-migration (legacy rule without it still parses)", () => {
  const legacy = { id: "lr-1", rule: "always run tsc before commit", category: "ci",
    created_at: "2026-01-01T00:00:00Z", applied_count: 0, effectiveness: "good" as const };
  expect(() => learnedRuleSchema.parse(legacy)).not.toThrow();
  const parsed = learnedRuleSchema.parse({ ...legacy, origin: "acted_on" });
  expect(parsed.origin).toBe("acted_on");
});

test("origin does NOT affect ranking — selector output is identical with/without it (AC5)", () => {
  const base = { id: "lr-1", rule: "verify null checks before merge", category: "safety",
    created_at: "2026-01-01T00:00:00Z", applied_count: 0, effectiveness: "good" as const,
    confidence: "high" as const };
  const withOrigin = { ...base, origin: "acted_on" as const };
  const a = selectRelevantRules([learnedRuleSchema.parse(base)], new Set(), 15);
  const b = selectRelevantRules([learnedRuleSchema.parse(withOrigin)], new Set(), 15);
  expect(a.map((r) => r.id)).toEqual(b.map((r) => r.id));
});
