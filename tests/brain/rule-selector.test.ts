import { test, expect } from "bun:test";
import {
  detectFileTypes,
  selectRelevantRules,
  selectRelevantRulesWithFunnel,
} from "../../src/brain/rule-selector";
import type { LearnedRule } from "../../src/memory/memory";

function rule(
  partial: Partial<LearnedRule> & { id: string } & {
    applies_to_file_types?: string[];
  },
): LearnedRule {
  return {
    rule: `rule ${partial.id}`,
    category: "misc",
    created_at: "2026-05-14T00:00:00Z",
    applied_count: 0,
    effectiveness: "good",
    ...partial,
  } as LearnedRule;
}

test("detectFileTypes extracts common extensions from transcript text", () => {
  const text = `
    Claude looked at queries.py:47 and src/main.ts and the README.md.
    Also touched config.yaml and a Cargo.toml file.
  `;
  const types = detectFileTypes(text);
  expect(types.has("py")).toBe(true);
  expect(types.has("ts")).toBe(true);
  expect(types.has("md")).toBe(true);
  expect(types.has("yaml")).toBe(true);
  expect(types.has("toml")).toBe(true);
});

test("detectFileTypes ignores uncommon/unknown extensions", () => {
  const types = detectFileTypes("opened thing.qwerty and other.xyzzy");
  expect(types.size).toBe(0);
});

test("selectRelevantRules: universal rules always included", () => {
  const rules = [
    rule({ id: "u1" }), // no applies_to_file_types → universal
    rule({ id: "py1", applies_to_file_types: ["py"] }),
    rule({ id: "rs1", applies_to_file_types: ["rs"] }),
  ];
  const selected = selectRelevantRules(rules, new Set(["ts"]));
  const ids = selected.map((r) => r.id);
  expect(ids).toContain("u1");
  expect(ids).not.toContain("py1");
  expect(ids).not.toContain("rs1");
});

test("selectRelevantRules: file-type overlap matches", () => {
  const rules = [
    rule({ id: "u1" }),
    rule({ id: "py1", applies_to_file_types: ["py"] }),
    rule({ id: "ts1", applies_to_file_types: ["ts", "tsx"] }),
  ];
  const selected = selectRelevantRules(rules, new Set(["py"]));
  const ids = selected.map((r) => r.id);
  expect(ids).toContain("u1");
  expect(ids).toContain("py1");
  expect(ids).not.toContain("ts1");
});

test("selectRelevantRules: retired rules dropped even if universal", () => {
  const rules = [
    rule({ id: "ret", effectiveness: "retired" }),
    rule({ id: "keep" }),
  ];
  const selected = selectRelevantRules(rules, new Set(["py"]));
  expect(selected.map((r) => r.id)).toEqual(["keep"]);
});

test("selectRelevantRules: empty fileTypes returns universal rules only", () => {
  const rules = [
    rule({ id: "u1" }),
    rule({ id: "py1", applies_to_file_types: ["py"] }),
  ];
  const selected = selectRelevantRules(rules, new Set());
  expect(selected.map((r) => r.id)).toEqual(["u1"]);
});

test("selectRelevantRules: hard-caps at maxRules (default 15)", () => {
  const rules = Array.from({ length: 30 }, (_, i) =>
    rule({ id: `r${i.toString().padStart(2, "0")}` }),
  );
  const selected = selectRelevantRules(rules, new Set());
  expect(selected).toHaveLength(15);
});

test("selectRelevantRules: sorts by effectiveness then recency desc", () => {
  const rules = [
    rule({
      id: "neutral-recent",
      effectiveness: "neutral",
      created_at: "2026-05-14T12:00:00Z",
    }),
    rule({
      id: "good-old",
      effectiveness: "good",
      created_at: "2025-01-01T00:00:00Z",
    }),
    rule({
      id: "good-recent",
      effectiveness: "good",
      created_at: "2026-05-14T12:00:00Z",
    }),
  ];
  const selected = selectRelevantRules(rules, new Set(), 5);
  expect(selected.map((r) => r.id)).toEqual([
    "good-recent",
    "good-old",
    "neutral-recent",
  ]);
});

test("selectRelevantRules: within equal effectiveness, sorts high > medium > low; missing = medium", () => {
  const rules = [
    rule({ id: "low", confidence: "low", created_at: "2026-05-14T12:00:00Z" }),
    rule({ id: "high", confidence: "high", created_at: "2026-05-14T12:00:00Z" }),
    rule({ id: "none", created_at: "2026-05-14T12:00:00Z" }), // treated as medium
    rule({ id: "med", confidence: "medium", created_at: "2026-05-14T12:00:00Z" }),
  ];
  const selected = selectRelevantRules(rules, new Set(), 10);
  const ids = selected.map((r) => r.id);
  expect(ids.indexOf("high")).toBeLessThan(ids.indexOf("med"));
  expect(ids.indexOf("high")).toBeLessThan(ids.indexOf("none"));
  expect(ids.indexOf("med")).toBeLessThan(ids.indexOf("low"));
  expect(ids.indexOf("none")).toBeLessThan(ids.indexOf("low")); // missing ranks as medium
});

// --- memory-funnel stages [1]-[3] (eval design §2.1) ---
//
// The funnel's whole value is that the FIRST stage to read zero names the break.
// That only works if the stages are independently observable, so this fixture is
// built so all three counts differ (5 / 4 / 2): a fixture where two stages happen
// to be equal would pass even if the implementation returned the wrong one.

function funnelFixture(): LearnedRule[] {
  return [
    rule({ id: "retired1", effectiveness: "retired" }), // dropped at stage 1
    rule({ id: "universal" }), // no applies_to_file_types → always scope-matched
    rule({ id: "ts1", applies_to_file_types: ["ts"] }),
    rule({ id: "ts2", applies_to_file_types: ["ts"] }),
    rule({ id: "ts3", applies_to_file_types: ["tsx", "ts"] }),
    rule({ id: "py1", applies_to_file_types: ["py"] }), // dropped at stage 2
  ];
}

test("funnel: the three read-half stages are counted independently", () => {
  const { selected, rules_in_store, rules_scope_matched } =
    selectRelevantRulesWithFunnel(funnelFixture(), new Set(["ts"]), 2);

  expect(rules_in_store).toBe(5); // 6 rules minus the retired one
  expect(rules_scope_matched).toBe(4); // universal + ts1 + ts2 + ts3; py1 filtered out
  expect(selected.length).toBe(2); // maxRules cap
});

test("funnel: a scope filter that drops everything is distinguishable from an empty store", () => {
  // Stage 2 zero with stage 1 non-zero = "the selector filtered everything out",
  // which is a different diagnosis from "the store is empty" — the funnel exists
  // to tell those two apart.
  const rules = [rule({ id: "py1", applies_to_file_types: ["py"] })];
  const filtered = selectRelevantRulesWithFunnel(rules, new Set(["ts"]), 15);
  expect(filtered.rules_in_store).toBe(1);
  expect(filtered.rules_scope_matched).toBe(0);
  expect(filtered.selected.length).toBe(0);

  const empty = selectRelevantRulesWithFunnel([], new Set(["ts"]), 15);
  expect(empty.rules_in_store).toBe(0);
  expect(empty.rules_scope_matched).toBe(0);
});

test("funnel: the cap is what drops rules, not the scope filter", () => {
  // Stage 2 non-zero but stage 3 smaller = "ranking/cap dropped them".
  const { selected, rules_scope_matched } = selectRelevantRulesWithFunnel(
    funnelFixture(),
    new Set(["ts"]),
    1,
  );
  expect(rules_scope_matched).toBe(4);
  expect(selected.length).toBe(1);
});

// NOTE: no `withFunnel(...).selected === selectRelevantRules(...)` test here, for
// the same reason as in prompt-assembly.test.ts — `selectRelevantRules` is now
// `return selectRelevantRulesWithFunnel(...).selected`, so the assertion is
// X === X by construction and cannot fail. The selection behavior is pinned by
// the unmodified `selectRelevantRules` tests above.
