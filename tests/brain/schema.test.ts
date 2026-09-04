import { test, expect } from "bun:test";
import { brainOutputSchema, evidenceItemSchema, parseBrainOutput } from "../../src/brain/schema";

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

// The SCHEMA still rejects both of these; what changed is that `parseBrainOutput`
// repairs a cosmetic field instead of discarding the review behind it. Asserted on
// both sides so neither half can drift away unnoticed —
// `tests/brain/schema-shape-repair.test.ts` carries the reasoning.
test("the schema rejects an unknown mood — the repairing parser substitutes one", () => {
  expect(brainOutputSchema.safeParse({ ...valid, mood: "rage" }).success).toBe(false);
  const parsed = parseBrainOutput({ ...valid, mood: "rage" });
  expect(parsed.mood).toBe("concerned");
  expect(parsed.repaired).toContain("mood");
});

test("the schema rejects an empty bubble_short — the repairing parser fills it", () => {
  expect(brainOutputSchema.safeParse({ ...valid, bubble_short: "" }).success).toBe(false);
  const parsed = parseBrainOutput({ ...valid, bubble_short: "" });
  expect(parsed.bubble_short).toBe(valid.bubble_long);
  expect(parsed.repaired).toContain("bubble_short");
});

test("caps bubble_short at 200 chars — by trimming it, not by dropping the answer", () => {
  // The cap is still enforced; what changed is who pays for the overflow. Rejecting
  // discarded a whole review over a bubble one character too long.
  const parsed = parseBrainOutput({ ...valid, bubble_short: "x".repeat(201) });
  expect(parsed.bubble_short).toHaveLength(200);
  expect(parsed.truncated?.bubble_short).toBe(1);
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

test("evidence: a snippet under the 10-char floor fails the item schema, and the item alone is dropped", () => {
  // The floor is still not coerced — nothing is lengthened to make it fit. What
  // changed is that the short citation no longer takes the review with it.
  const item = { ...validEvidenceItem, snippet: "short" };
  expect(evidenceItemSchema.safeParse(item).success).toBe(false);
  const parsed = parseBrainOutput({ ...valid, evidence: [item] });
  expect(parsed.evidence).toEqual([]);
  expect(parsed.truncated?.evidence_malformed).toBe(1);
  expect(parsed.critique_for_claude).toBe(valid.critique_for_claude);
});

test("evidence: caps a snippet at 240 chars and keeps the citation", () => {
  const parsed = parseBrainOutput({
    ...valid,
    evidence: [{ ...validEvidenceItem, snippet: "x".repeat(241) }],
  });
  expect(parsed.evidence[0]!.snippet).toHaveLength(240);
  expect(parsed.truncated?.evidence_snippets).toBe(1);
});

test("evidence: keeps 5 of 6 citations and reports the drop — the findings survive", () => {
  // This is the assertion the change exists for. Seven planted defects failed 3/3
  // on this cap, twice four weeks apart, and the findings that were discarded live
  // in `critique_for_claude` — a field that was never over its own cap.
  const items = Array.from({ length: 6 }, () => validEvidenceItem);
  const parsed = parseBrainOutput({ ...valid, evidence: items });
  expect(parsed.evidence).toHaveLength(5);
  expect(parsed.truncated?.evidence).toBe(1);
  expect(parsed.critique_for_claude).toBe(valid.critique_for_claude);
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

test("evidence: line: 0 fails the item schema, and the item alone is dropped", () => {
  const item = { ...validEvidenceItem, line: 0 };
  expect(evidenceItemSchema.safeParse(item).success).toBe(false);
  const parsed = parseBrainOutput({ ...valid, evidence: [item] });
  expect(parsed.evidence).toEqual([]);
  expect(parsed.truncated?.evidence_malformed).toBe(1);
  // The findings are what must survive a bad citation.
  expect(parsed.critique_for_claude).toBe(valid.critique_for_claude);
});

test("evidence: an unknown tool name fails the item schema, and the item alone is dropped", () => {
  const item = { ...validEvidenceItem, tool: "pylint" };
  expect(evidenceItemSchema.safeParse(item).success).toBe(false);
  const parsed = parseBrainOutput({ ...valid, evidence: [item] });
  expect(parsed.evidence).toEqual([]);
  expect(parsed.truncated?.evidence_malformed).toBe(1);
  // The findings are what must survive a bad citation.
  expect(parsed.critique_for_claude).toBe(valid.critique_for_claude);
});

test("evidence: an empty file string fails the item schema, and the item alone is dropped", () => {
  const item = { ...validEvidenceItem, file: "" };
  expect(evidenceItemSchema.safeParse(item).success).toBe(false);
  const parsed = parseBrainOutput({ ...valid, evidence: [item] });
  expect(parsed.evidence).toEqual([]);
  expect(parsed.truncated?.evidence_malformed).toBe(1);
  // The findings are what must survive a bad citation.
  expect(parsed.critique_for_claude).toBe(valid.critique_for_claude);
});
