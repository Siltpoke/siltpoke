// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
// Copyright (c) 2026 Jiaqi Duan
/**
 * #692's principle, moved from LENGTH to SHAPE: a malformed part must drop the
 * part, not the whole answer.
 *
 * MEASURED (2026-09-01, `~/.siltpoke/traces/`). Of 36 brain failures since
 * 2026-08-25, 33 were schema rejections. #692's length coercion covers the two
 * biggest issue classes — `evidence[].snippet: too_big` (19) and
 * `reasoning: too_big` (12). What it does not cover, and what this file pins:
 *
 *     4  evidence.N.file        invalid_type
 *     1  evidence.N.line        invalid_type
 *     1  bubble_short           too_small
 *     1  pose                   invalid_value
 *     2  critique_for_claude    invalid_type   ← deliberately NOT repaired
 *
 * Every repair here is VALUE-AGNOSTIC on purpose. #699's probe, which records
 * the rejected reply, had captured nothing when this was written, so nothing
 * below is written against an observed value: an evidence item that does not
 * satisfy its own schema is dropped whatever it holds, and a cosmetic field out
 * of range falls back whatever it held. `critique_for_claude` is the one class
 * excluded for exactly that reason — it is the payload, so whether the right
 * move is to join an array or to give up depends on the value, and the value is
 * not known yet.
 */
import { describe, expect, test } from "bun:test";
import { parseBrainOutput } from "../../src/brain/schema";

const base = {
  mood: "concerned",
  pose: "base",
  bubble_short: "three things",
  bubble_long: "three things worth a look",
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

describe("a malformed evidence item drops itself, not the review", () => {
  test("the observed case: `file` is a number, so that one citation goes and the rest stay", () => {
    const out = parseBrainOutput({
      ...base,
      evidence: [cite(0), { ...cite(1), file: 42 }, cite(2)],
    });
    expect(out.evidence).toHaveLength(2);
    expect(out.evidence.map((e) => e.file)).toEqual(["src/f0.ts", "src/f2.ts"]);
    expect(out.truncated?.evidence_malformed).toBe(1);
    // The point of the whole change: the findings survive the bad citation.
    expect(out.critique_for_claude).toBe(base.critique_for_claude);
  });

  test("the dropped item records the TYPE it arrived as, so the probe is not the only way to know", () => {
    // This change repairs the very classes #699's probe was installed to
    // observe, so those replies stop rejecting and the probe stops seeing them.
    // The received type is what answers the question that would otherwise be
    // lost: could a coercion have SAVED this citation instead of dropping it?
    const out = parseBrainOutput({ ...base, evidence: [{ ...cite(0), file: 42 }] });
    expect(out.repaired).toEqual(["evidence.0: file: invalid_type (received number)"]);
  });

  test("the record carries no model-written VALUE — only the field, the code and the type", () => {
    const secret = "src/definitely-not-a-path-the-model-made-up.ts";
    const out = parseBrainOutput({ ...base, evidence: [{ ...cite(0), line: secret }] });
    expect(out.repaired?.join(" ")).not.toContain(secret);
    expect(out.repaired?.[0]).toContain("received string");
  });

  test("`line` is a string — the same drop, because the rule is the schema, not a code list", () => {
    const out = parseBrainOutput({ ...base, evidence: [{ ...cite(0), line: "12" }, cite(1)] });
    expect(out.evidence).toHaveLength(1);
    expect(out.truncated?.evidence_malformed).toBe(1);
  });

  test("a floor inside an item drops the item — nothing is lengthened to make it fit", () => {
    // Supersedes the older assertion that a too-short snippet rejects the whole
    // review. The floor itself is still not coerced: the item is thrown away, not
    // padded. What changed is that it no longer takes the other findings with it.
    const out = parseBrainOutput({ ...base, evidence: [{ ...cite(0), snippet: "tooshort" }, cite(1)] });
    expect(out.evidence).toHaveLength(1);
    expect(out.evidence[0]!.file).toBe("src/f1.ts");
    expect(out.truncated?.evidence_malformed).toBe(1);
  });

  test("every item malformed leaves an empty array and a live review, not a rejection", () => {
    // `evidence: []` is already a state the pipeline handles — `evidence-guard.ts`
    // labels it `no_evidence` and shows the review anyway (2026-08-19). So an
    // all-bad citation list degrades into a state that already exists, rather
    // than into silence.
    const out = parseBrainOutput({ ...base, evidence: [{ ...cite(0), file: null }, { ...cite(1), tool: "oracle" }] });
    expect(out.evidence).toEqual([]);
    expect(out.truncated?.evidence_malformed).toBe(2);
    expect(out.critique_for_claude).toBe(base.critique_for_claude);
  });

  test("the 5-item cap applies to what SURVIVES, so bad citations do not cost good ones", () => {
    // Seven citations, the first two malformed. Capping before dropping returned
    // three survivors — items 5 and 6 were sliced off before anything looked at
    // shape, so the reader lost two perfectly good citations to two bad ones.
    // Found by two independent cross-family reviews of this change.
    const out = parseBrainOutput({
      ...base,
      evidence: [
        { ...cite(0), file: 42 },
        { ...cite(1), file: 42 },
        cite(2), cite(3), cite(4), cite(5), cite(6),
      ],
    });
    expect(out.evidence.map((e) => e.file)).toEqual([
      "src/f2.ts", "src/f3.ts", "src/f4.ts", "src/f5.ts", "src/f6.ts",
    ]);
    expect(out.truncated?.evidence_malformed).toBe(2);
    // Nothing overflowed the cap once the bad ones were gone: five survivors, cap five.
    expect(out.truncated?.evidence).toBeUndefined();
  });

  test("the cap still reports its own overflow, counted after the drop", () => {
    const out = parseBrainOutput({
      ...base,
      evidence: [{ ...cite(0), file: 42 }, cite(1), cite(2), cite(3), cite(4), cite(5), cite(6)],
    });
    expect(out.evidence).toHaveLength(5);
    expect(out.truncated?.evidence_malformed).toBe(1);
    // Six survivors, cap five — one over, not two.
    expect(out.truncated?.evidence).toBe(1);
  });

  test("an item that is BOTH over-long and malformed is not reported as trimmed", () => {
    // The trim runs first and the drop runs second, so this item is shortened
    // and then thrown away. Recording the shortening would leave `truncated`
    // describing characters cut off a value that no longer exists — the exact
    // lie both passes are here to stop. Found by two independent cross-family
    // reviews of this change, on this input.
    const out = parseBrainOutput({
      ...base,
      evidence: [{ ...cite(0), file: 42, snippet: "x".repeat(300) }, cite(1)],
    });
    expect(out.evidence).toHaveLength(1);
    expect(out.truncated?.evidence_malformed).toBe(1);
    expect(out.truncated?.evidence_snippets).toBeUndefined();
  });

  test("a surviving item's trim IS still reported, alongside a neighbour's drop", () => {
    // The positive control for the assertion above: suppressing the stale record
    // must not suppress the real one sitting next to it.
    const out = parseBrainOutput({
      ...base,
      evidence: [{ ...cite(0), file: 42 }, { ...cite(1), snippet: "y".repeat(300) }],
    });
    expect(out.evidence).toHaveLength(1);
    expect(out.truncated?.evidence_malformed).toBe(1);
    expect(out.truncated?.evidence_snippets).toBe(60);
  });

  test("a length truncation elsewhere survives a shape repair on the same response", () => {
    const out = parseBrainOutput({
      ...base,
      reasoning: "x".repeat(900),
      evidence: [{ ...cite(0), file: 42 }],
    });
    expect(out.truncated).toEqual({ reasoning: 100, evidence_malformed: 1 });
  });

  test("an evidence entry that is not an object at all is dropped and named", () => {
    const out = parseBrainOutput({ ...base, evidence: [42, null, cite(1)] });
    expect(out.evidence).toHaveLength(1);
    expect(out.truncated?.evidence_malformed).toBe(2);
    expect(out.repaired).toEqual([
      "evidence.0: (item): invalid_type (received number)",
      "evidence.1: (item): invalid_type (received null)",
    ]);
  });

  test("a non-array `evidence` is not silently turned into one", () => {
    // Dropping malformed ITEMS is the change; inventing an array where the model
    // sent something else is not, and would hide a different failure.
    expect(() => parseBrainOutput({ ...base, evidence: "src/f0.ts" })).toThrow();
  });
});

describe("a cosmetic field out of range falls back; a judgement field still rejects", () => {
  test("an unknown pose becomes the neutral pose and the review survives", () => {
    const out = parseBrainOutput({ ...base, evidence: [cite(0)], pose: "backflip" });
    expect(out.pose).toBe("base");
    expect(out.repaired).toContain("pose");
    expect(out.critique_for_claude).toBe(base.critique_for_claude);
  });

  test("an unknown mood falls back TOWARD attention, never toward calm", () => {
    // A calm face on a high-severity review is a lie the reader cannot detect,
    // so the fallback is derived from the (already validated) severity rather
    // than from a single constant.
    const high = parseBrainOutput({ ...base, evidence: [cite(0)], mood: "smug" });
    expect(high.mood).toBe("concerned");
    expect(high.repaired).toContain("mood");

    const low = parseBrainOutput({ ...base, evidence: [cite(0)], mood: "smug", severity: "info" });
    expect(low.mood).toBe("watching");
  });

  test("a cosmetic field that is ABSENT falls back too, not only one out of range", () => {
    // Broader than the observed failure (`pose: invalid_value`), and deliberate:
    // a review dying because the model sent no face is the same loss as one
    // dying because it sent an unknown face. Pinned because it is broader —
    // an untested widening is how a repair becomes a surprise.
    const { pose: _p, mood: _m, ...noFace } = base;
    const out = parseBrainOutput({ ...noFace, evidence: [cite(0)] });
    expect(out.pose).toBe("base");
    expect(out.mood).toBe("concerned");
    expect(out.repaired).toEqual(["pose", "mood"]);
    expect(out.critique_for_claude).toBe(base.critique_for_claude);
  });

  test("severity and confidence are NOT repaired — a fallback there would invent a judgement", () => {
    expect(() => parseBrainOutput({ ...base, evidence: [cite(0)], severity: "critical" })).toThrow();
    expect(() => parseBrainOutput({ ...base, evidence: [cite(0)], confidence: "certain" })).toThrow();
  });

  test("`critique_for_claude` of the wrong type still rejects — the payload needs the probe first", () => {
    // 2 of the residual failures. Whether the right repair is to join an array,
    // to stringify, or to give up depends on what actually arrives, and #699's
    // probe had recorded nothing yet. Pinned so the gap stays visible.
    expect(() => parseBrainOutput({ ...base, evidence: [cite(0)], critique_for_claude: ["a", "b"] })).toThrow();
  });
});

describe("an empty bubble does not discard the findings behind it", () => {
  test("an empty bubble_short is filled from bubble_long", () => {
    const out = parseBrainOutput({ ...base, evidence: [cite(0)], bubble_short: "" });
    expect(out.bubble_short).toBe(base.bubble_long);
    expect(out.repaired).toContain("bubble_short");
  });

  test("with no bubble_long either, it falls back to the critique", () => {
    const out = parseBrainOutput({
      ...base,
      evidence: [cite(0)],
      bubble_short: "",
      bubble_long: "",
    });
    expect(out.bubble_short).toBe(base.critique_for_claude);
    expect(out.repaired).toContain("bubble_short");
  });

  test("a long source is cut to the bubble's own cap, not left over it", () => {
    const out = parseBrainOutput({
      ...base,
      evidence: [cite(0)],
      bubble_short: "",
      bubble_long: "x".repeat(900),
    });
    expect(out.bubble_short).toHaveLength(200);
  });

  test("nothing anywhere to say still rejects — a bubble is not invented out of nothing", () => {
    expect(() =>
      parseBrainOutput({
        ...base,
        evidence: [cite(0)],
        bubble_short: "",
        bubble_long: "",
        critique_for_claude: "",
      }),
    ).toThrow();
  });
});

describe("the honesty signals cannot be written by the subject they describe", () => {
  test("a model-supplied `truncated` and `repaired` are dropped, not believed", () => {
    // Both fields are declared on the schema, so a model CAN emit them, and a
    // forged `truncated` reads identically to a real one on every surface.
    const out = parseBrainOutput({
      ...base,
      evidence: [cite(0)],
      truncated: { evidence: 9 },
      repaired: ["severity"],
    });
    expect(out.truncated).toBeUndefined();
    expect(out.repaired).toBeUndefined();
  });

  test("a forged value does not survive alongside a real one either", () => {
    const out = parseBrainOutput({
      ...base,
      evidence: [{ ...cite(0), file: 42 }],
      truncated: { evidence: 9, reasoning: 500 },
    });
    expect(out.truncated).toEqual({ evidence_malformed: 1 });
  });

  test("an empty `truncated` from the model cannot break the absent-never-empty contract", () => {
    const out = parseBrainOutput({ ...base, evidence: [cite(0)], truncated: {} });
    expect(out.truncated).toBeUndefined();
  });
});

describe("silence still means nothing happened", () => {
  test("a clean output carries neither a truncation record nor a repair record", () => {
    const out = parseBrainOutput({ ...base, evidence: [cite(0), cite(1)] });
    expect(out.truncated).toBeUndefined();
    expect(out.repaired).toBeUndefined();
    expect(out.evidence).toHaveLength(2);
  });

  test("a length truncation does not masquerade as a shape repair", () => {
    const out = parseBrainOutput({ ...base, evidence: [cite(0)], reasoning: "x".repeat(900) });
    expect(out.truncated?.reasoning).toBe(100);
    expect(out.truncated?.evidence_malformed).toBeUndefined();
    expect(out.repaired).toBeUndefined();
  });
});
