// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
// Copyright (c) 2026 Jiaqi Duan
/**
 * A cap must drop the overflow, never the whole answer.
 *
 * Measured twice, four weeks apart (#481 on 2026-08-03 and again 2026-08-31): a
 * diff with seven planted defects fails 3/3 with `evidence: too_big`, and the
 * response carrying all seven findings is discarded whole. The findings live in
 * `critique_for_claude`, a string that was never over its cap — so the review the
 * user loses is lost to a citation count, and a critic that finds more reports
 * nothing, which is indistinguishable from finding nothing.
 */
import { describe, expect, test } from "bun:test";
import { parseBrainOutput } from "../../src/brain/schema";

const base = {
  mood: "concerned",
  pose: "base",
  bubble_short: "seven things",
  bubble_long: "seven things worth a look",
  critique_for_claude: "1. off-by-one 2. missing await 3. unclosed resource",
  severity: "high",
  confidence: "high",
  xp_earned_events: [],
};

const cite = (i: number) => ({
  tool: "git-diff" as const,
  file: `src/f${i}.ts`,
  line: i + 1,
  snippet: `const value${i} = compute(${i}); // a snippet comfortably past the ten-character floor`,
});

describe("parseBrainOutput coerces over-cap fields instead of rejecting", () => {
  test("seven citations parse, five are kept, and the two dropped are reported", () => {
    const out = parseBrainOutput({ ...base, evidence: Array.from({ length: 7 }, (_, i) => cite(i)) });
    expect(out.evidence).toHaveLength(5);
    expect(out.truncated?.evidence).toBe(2);
    // The point of the whole change: the findings survive the citation overflow.
    expect(out.critique_for_claude).toBe(base.critique_for_claude);
  });

  test("an over-long reasoning is cut to its cap and reported, not thrown away", () => {
    const out = parseBrainOutput({ ...base, evidence: [cite(0)], reasoning: "x".repeat(900) });
    expect(out.reasoning?.length).toBe(800);
    expect(out.truncated?.reasoning).toBe(100);
    expect(out.evidence).toHaveLength(1);
  });

  test("every other length cap in this schema behaves the same way", () => {
    const out = parseBrainOutput({
      ...base,
      bubble_short: "s".repeat(250),
      bubble_long: "l".repeat(2100),
      what_would_refute: "r".repeat(260),
      evidence: [{ ...cite(0), snippet: "z".repeat(300) }],
    });
    expect(out.bubble_short).toHaveLength(200);
    expect(out.bubble_long).toHaveLength(2000);
    expect(out.what_would_refute).toHaveLength(200);
    expect(out.evidence[0]!.snippet).toHaveLength(240);
  });

  test("nothing over its cap means no truncation record at all — silence is not a lie here", () => {
    const out = parseBrainOutput({ ...base, evidence: [cite(0), cite(1)], reasoning: "short" });
    expect(out.evidence).toHaveLength(2);
    expect(out.truncated).toBeUndefined();
  });

  test("a floor is NOT coerced — nothing is lengthened to make it fit, and that is deliberate", () => {
    // Truncation can shorten an over-long value; nothing can lengthen an under-long
    // one without inventing content. Stated as a test so the residual is visible
    // rather than discovered.
    expect(() =>
      parseBrainOutput({ ...base, xp_earned_events: [{ type: "review", amount: -1 }] }),
    ).toThrow();
  });

  test("a floor INSIDE an evidence item drops that item — the floor is still not coerced", () => {
    // 2026-09-01: this used to reject the whole response. The floor is unchanged
    // — the short snippet is thrown away, never padded — but a bad citation no
    // longer takes the findings with it. See tests/brain/schema-shape-repair.test.ts.
    const out = parseBrainOutput({ ...base, evidence: [{ ...cite(0), snippet: "tooshort" }, cite(1)] });
    expect(out.evidence).toHaveLength(1);
    expect(out.truncated?.evidence_malformed).toBe(1);
  });
});
