import { test, expect } from "bun:test";
import {
  detectFileTypes,
  selectRelevantRules,
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
