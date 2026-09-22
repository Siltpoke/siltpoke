// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
// Copyright (c) 2026 Jiaqi Duan
/**
 * `findings[]` gets the same trim → drop → cap treatment `evidence` does, and
 * for the same measured reason: a cap that REJECTS takes the whole review with
 * it. That failure fired twice in this file four weeks apart (`schema.ts`, the
 * `evidence: too_big` note), so the sibling array ships with the sibling
 * defence rather than waiting to learn it again.
 *
 * The last test here is the one that is easy to forget: a critique written
 * before this field existed must still parse. Every `brain_output` row already
 * on disk is one of those.
 */
import { describe, expect, test } from "bun:test";
import { parseBrainOutput } from "../../src/brain/schema";

const base = {
  mood: "concerned",
  pose: "base",
  bubble_short: "three things",
  bubble_long: "three things worth a look",
  critique_for_claude: "prose that predates findings",
  severity: "high",
  confidence: "high",
  xp_earned_events: [],
};

const finding = (i: number) => ({
  title: `finding ${i}`,
  body: `why finding ${i} matters`,
  severity: "medium" as const,
  file: `src/f${i}.ts`,
  quote: `const value${i} = compute(${i}); // comfortably past the ten-character floor`,
});

describe("findings are trimmed and capped, never rejected", () => {
  test("six findings parse, five survive, and the one dropped is reported", () => {
    const out = parseBrainOutput({ ...base, findings: Array.from({ length: 6 }, (_, i) => finding(i)) });
    expect(out.findings).toHaveLength(5);
    expect(out.truncated?.findings).toBe(1);
    // The whole point: the review is not lost to a count.
    expect(out.critique_for_claude).toBe(base.critique_for_claude);
    expect(out.bubble_short).toBe(base.bubble_short);
  });

  test("a malformed first item costs only itself — the two good ones still arrive", () => {
    const out = parseBrainOutput({
      ...base,
      findings: [{ title: "no body, no file, no quote" }, finding(1), finding(2)],
    });
    expect(out.findings).toHaveLength(2);
    expect(out.truncated?.findings_malformed).toBe(1);
    expect(out.repaired?.some((r) => r.startsWith("findings.0:"))).toBe(true);
    // Order matters: capping before dropping would have cost the survivors.
    expect(out.findings.map((f) => f.title)).toEqual(["finding 1", "finding 2"]);
  });

  test("an over-long quote is shortened, not disqualified — and it keeps the marker the guard looks for", () => {
    const long = "x".repeat(400);
    const out = parseBrainOutput({ ...base, findings: [{ ...finding(0), quote: long }] });
    expect(out.findings).toHaveLength(1);
    expect(out.findings[0]?.quote).toHaveLength(240);
    // `…` is siltpoke's, never the model's, and the evidence guard identifies a
    // trimmed citation by it. A quote shortened any other way can never match.
    expect(out.findings[0]?.quote.endsWith("…")).toBe(true);
  });

  test("an over-long title and body are shortened rather than dropping the finding", () => {
    const out = parseBrainOutput({
      ...base,
      findings: [{ ...finding(0), title: "t".repeat(300), body: "b".repeat(900) }],
    });
    expect(out.findings).toHaveLength(1);
    expect(out.findings[0]?.title).toHaveLength(120);
    expect(out.findings[0]?.body).toHaveLength(600);
  });

  test("a line range written by the model is discarded — code derives that, not the reviewer", () => {
    const out = parseBrainOutput({
      ...base,
      findings: [{ ...finding(0), start_line: 42, end_line: 44, identity_hash: "forged" }],
    });
    expect(out.findings).toHaveLength(1);
    expect(out.findings[0] as Record<string, unknown>).not.toHaveProperty("start_line");
    expect(out.findings[0] as Record<string, unknown>).not.toHaveProperty("identity_hash");
  });

  test("AC9 — a brain_output written before this field existed still parses", () => {
    const out = parseBrainOutput({ ...base, evidence: [] });
    expect(out.findings).toEqual([]);
    expect(out.critique_for_claude).toBe(base.critique_for_claude);
  });
});
