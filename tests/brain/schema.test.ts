import { test, expect } from "bun:test";
import { parseBrainOutput } from "../../src/brain/schema";

const valid = {
  mood: "annoyed",
  pose: "arms_crossed",
  bubble_short: "这段 SQL 让我有点担心",
  bubble_long: "JOIN 没处理 NULL",
  critique_for_claude: "queries.py:47 NULL not handled",
  severity: "medium",
  confidence: "high",
  xp_earned_events: [],
};

test("accepts a fully valid output", () => {
  const parsed = parseBrainOutput(valid);
  expect(parsed.mood).toBe("annoyed");
  expect(parsed.xp_earned_events).toEqual([]);
});

test("rejects unknown mood", () => {
  expect(() => parseBrainOutput({ ...valid, mood: "rage" })).toThrow();
});

test("rejects empty bubble_short", () => {
  expect(() => parseBrainOutput({ ...valid, bubble_short: "" })).toThrow();
});

test("rejects bubble_short longer than 200 chars", () => {
  const long = "x".repeat(201);
  expect(() => parseBrainOutput({ ...valid, bubble_short: long })).toThrow();
});

test("rejects negative XP amount", () => {
  expect(() =>
    parseBrainOutput({
      ...valid,
      xp_earned_events: [{ type: "review", amount: -1 }],
    }),
  ).toThrow();
});

test("rejects missing required field", () => {
  const { critique_for_claude, ...rest } = valid;
  expect(() => parseBrainOutput(rest)).toThrow();
});

// --- evidence field ---

const validEvidenceItem = {
  tool: "tsc" as const,
  file: "src/x.ts",
  snippet: "TS2345: Argument of type 'string' is not assignable",
};

test("evidence: accepts valid evidence array", () => {
  const parsed = parseBrainOutput({ ...valid, evidence: [validEvidenceItem] });
  expect(parsed.evidence).toHaveLength(1);
  expect(parsed.evidence[0].tool).toBe("tsc");
  expect(parsed.evidence[0].file).toBe("src/x.ts");
});

test("evidence: omitting evidence field produces empty array default", () => {
  const parsed = parseBrainOutput(valid);
  expect(parsed.evidence).toEqual([]);
});

test("evidence: rejects snippet shorter than 10 chars", () => {
  expect(() =>
    parseBrainOutput({
      ...valid,
      evidence: [{ ...validEvidenceItem, snippet: "short" }],
    }),
  ).toThrow();
});

test("evidence: rejects snippet longer than 240 chars", () => {
  const tooLong = "x".repeat(241);
  expect(() =>
    parseBrainOutput({
      ...valid,
      evidence: [{ ...validEvidenceItem, snippet: tooLong }],
    }),
  ).toThrow();
});

test("evidence: rejects more than 5 items", () => {
  const items = Array.from({ length: 6 }, () => validEvidenceItem);
  expect(() =>
    parseBrainOutput({ ...valid, evidence: items }),
  ).toThrow();
});

test("evidence: line field is optional", () => {
  const parsed = parseBrainOutput({
    ...valid,
    evidence: [{ ...validEvidenceItem }],
  });
  expect(parsed.evidence[0].line).toBeUndefined();
});

test("evidence: accepts valid line number", () => {
  const parsed = parseBrainOutput({
    ...valid,
    evidence: [{ ...validEvidenceItem, line: 42 }],
  });
  expect(parsed.evidence[0].line).toBe(42);
});

test("evidence: rejects line: 0 (must be positive)", () => {
  expect(() =>
    parseBrainOutput({
      ...valid,
      evidence: [{ ...validEvidenceItem, line: 0 }],
    }),
  ).toThrow();
});

test("evidence: rejects invalid tool name", () => {
  expect(() =>
    parseBrainOutput({
      ...valid,
      evidence: [{ ...validEvidenceItem, tool: "pylint" }],
    }),
  ).toThrow();
});

test("evidence: rejects empty file string", () => {
  expect(() =>
    parseBrainOutput({
      ...valid,
      evidence: [{ ...validEvidenceItem, file: "" }],
    }),
  ).toThrow();
});
