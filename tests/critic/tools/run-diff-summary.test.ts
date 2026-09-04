import { describe, test, expect } from "bun:test";
import { runDiffSummary, truncArray } from "../../../src/critic/tools/run-diff-summary";
import type { BrainCallRawResult } from "../../../src/brain/brain";
import type { CallBrainOptions } from "../../../src/brain/brain";

type MockFn = (opts: CallBrainOptions) => Promise<BrainCallRawResult>;

const SAMPLE_DIFF = `diff --git a/x.ts b/x.ts
@@ -1,3 +1,5 @@
+export const FOO = 1;
+export const BAR = 2;
 export const BAZ = 3;
`;

describe("runDiffSummary — schema coercion", () => {
  test("over-length purpose (>160 chars) is truncated, not rejected", async () => {
    const overLongPurpose = "x".repeat(220);
    const callFn: MockFn = async () => ({
      output: {
        intent: "test intent",
        key_changes: ["one change"],
        risks: [],
        file_count: 1,
        files_with_purpose: [{ path: "x.ts", purpose: overLongPurpose }],
        source: "haiku",
      },
      usage: { input_tokens: 10, output_tokens: 10, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, total_cost_usd: 0 },
    });
    const r = await runDiffSummary({ diffText: SAMPLE_DIFF, callFn });
    expect(r).not.toBeNull();
    expect(r?.summary.files_with_purpose[0].purpose.length).toBeLessThanOrEqual(160);
    expect(r?.summary.files_with_purpose[0].purpose).toContain("xxxx");
  });

  test("over-length intent (>600) truncated", async () => {
    const callFn: MockFn = async () => ({
      output: {
        intent: "x".repeat(700),
        key_changes: [],
        risks: [],
        file_count: 0,
        files_with_purpose: [],
        source: "haiku",
      },
      usage: { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, total_cost_usd: 0 },
    });
    const r = await runDiffSummary({ diffText: SAMPLE_DIFF, callFn });
    expect(r?.summary.intent.length).toBeLessThanOrEqual(600);
  });

  test("over-length key_changes entry (>300) truncated", async () => {
    const callFn: MockFn = async () => ({
      output: {
        intent: "ok",
        key_changes: ["x".repeat(400)],
        risks: [],
        file_count: 0,
        files_with_purpose: [],
        source: "haiku",
      },
      usage: { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, total_cost_usd: 0 },
    });
    const r = await runDiffSummary({ diffText: SAMPLE_DIFF, callFn });
    expect(r?.summary.key_changes[0].length).toBeLessThanOrEqual(300);
  });

  test("at-limit purpose (exactly 160) passes unchanged", async () => {
    const exact = "x".repeat(160);
    const callFn: MockFn = async () => ({
      output: {
        intent: "ok",
        key_changes: [],
        risks: [],
        file_count: 1,
        files_with_purpose: [{ path: "x.ts", purpose: exact }],
        source: "haiku",
      },
      usage: { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, total_cost_usd: 0 },
    });
    const r = await runDiffSummary({ diffText: SAMPLE_DIFF, callFn });
    expect(r?.summary.files_with_purpose[0].purpose).toBe(exact);
  });
});

// Defect ④ — coerceLengths truncates the STRINGS inside an array but never the
// array's own length, so an over-cap array is rejected outright by safeParse and
// the whole summary degrades to the heuristic (risks: []).
//
// Note the shape of the describe block ABOVE: every one of its cases is an
// over-length STRING, and all of them pass today. That asymmetry is the defect —
// `.max()` on a string is coerced, `.max()` on an array is not.
//
// The live rate of ④ has been zero since 2026-07-26, and that is NOT a fix (the
// code is untouched; the trigger stopped occurring). So these oracles are
// constructed inputs, deliberately — a production count would report success.
describe("runDiffSummary — array-length coercion (defect ④)", () => {
  const usage = { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, total_cost_usd: 0 };

  const NINE_CHANGES = Array.from({ length: 9 }, (_, i) => `change ${i + 1}`);
  const nineChangeCall: MockFn = async () => ({
    output: {
      intent: "ok",
      key_changes: [...NINE_CHANGES],
      risks: [],
      file_count: 1,
      files_with_purpose: [{ path: "x.ts", purpose: "p" }],
      source: "haiku",
    },
    usage,
  });

  // AC1 asserts the SHAPE, not just survival. A bare "it did not throw" would pass
  // for an implementation that silently slices to 8 and loses the 9th — which is
  // the exact defect this fix exists to remove, re-created inside its own fix.
  test("AC1: 9 key_changes (cap 8) -> exactly 8 REAL entries, in order", async () => {
    const r = await runDiffSummary({ diffText: SAMPLE_DIFF, callFn: nineChangeCall });
    expect(r).not.toBeNull();
    const kc = r?.summary.key_changes ?? [];
    expect(kc.length).toBe(8);
    // Every surviving entry is real content — the count is not padded by a marker.
    expect(kc).toEqual(NINE_CHANGES.slice(0, 8));
  });

  test("AC2: the drop is recorded OUTSIDE the array, with the count", async () => {
    const r = await runDiffSummary({ diffText: SAMPLE_DIFF, callFn: nineChangeCall });
    expect(r?.summary.truncated?.key_changes).toBe(1);
    // and nothing else claims to have been truncated
    expect(r?.summary.truncated?.risks).toBeUndefined();
    expect(r?.summary.truncated?.files_with_purpose).toBeUndefined();
  });

  // The "every entry is real" clause is load-bearing. When the marker lived INSIDE
  // the array, `risks.length` was read as a risk count by severity-promotion.ts:69
  // and rendered into the pet bubble, so a truncated summary told the user
  // "6 risks flagged" when 5 were real. An independent review found three such
  // readers. These assertions are what stop that from being reintroduced.
  test("AC3: 7 risks (cap 6) -> exactly 6 REAL risks + a separate count of 1", async () => {
    const SEVEN_RISKS = Array.from({ length: 7 }, (_, i) => `risk ${i + 1}`);
    const callFn: MockFn = async () => ({
      output: {
        intent: "ok",
        key_changes: ["one"],
        risks: [...SEVEN_RISKS],
        file_count: 1,
        files_with_purpose: [{ path: "x.ts", purpose: "p" }],
        source: "haiku",
      },
      usage,
    });
    const r = await runDiffSummary({ diffText: SAMPLE_DIFF, callFn });
    expect(r).not.toBeNull();
    expect(r?.summary.risks).toEqual(SEVEN_RISKS.slice(0, 6));
    expect(r?.summary.truncated?.risks).toBe(1);
  });

  test("AC3b: risks at exactly the cap are untouched, and claim no truncation", async () => {
    const six = Array.from({ length: 6 }, (_, i) => `risk ${i + 1}`);
    const callFn: MockFn = async () => ({
      output: {
        intent: "ok",
        key_changes: ["one"],
        risks: [...six],
        file_count: 1,
        files_with_purpose: [{ path: "x.ts", purpose: "p" }],
        source: "haiku",
      },
      usage,
    });
    const r = await runDiffSummary({ diffText: SAMPLE_DIFF, callFn });
    // Positive control for AC3: if either half goes red, truncation is firing when
    // nothing was dropped, and AC3 would be passing for the wrong reason.
    expect(r?.summary.risks).toEqual(six);
    expect(r?.summary.truncated?.risks).toBeUndefined();
  });

  // Strengthened after review: the earlier version asserted only `length <= 40`,
  // which a silent-drop-with-no-record implementation passes unchanged (40 <= 40),
  // as would one that dropped the FIRST entries or returned an empty array. This
  // is the field with the most too_big events on record (148 of 216), so it gets
  // the same assertions as its siblings, not weaker ones.
  test("AC3c: 41 files_with_purpose (cap 40) -> 40 real entries, in order, count recorded", async () => {
    const FILES = Array.from({ length: 41 }, (_, i) => ({ path: `f${i}.ts`, purpose: "p" }));
    const callFn: MockFn = async () => ({
      output: {
        intent: "ok",
        key_changes: ["one"],
        risks: [],
        file_count: 41,
        files_with_purpose: FILES.map(f => ({ ...f })),
        source: "haiku",
      },
      usage,
    });
    const r = await runDiffSummary({ diffText: SAMPLE_DIFF, callFn });
    expect(r).not.toBeNull();
    expect(r?.summary.files_with_purpose).toEqual(FILES.slice(0, 40));
    expect(r?.summary.truncated?.files_with_purpose).toBe(1);
  });

  // Firing evidence for truncArray's `cap < 1` guard. Nothing in the module can
  // reach it — ARRAY_CAPS holds 8/6/40 — so without a direct call the guard is
  // written, shipped, and never invoked: the "dead" half of the defect family in
  // docs/lessons.md L3, inside a commit about that very family.
  //
  // A mutation run also narrowed what the guard is FOR. Weakening `cap < 1` to
  // `cap < 0` left everything green, because `slice(0, 0)` is already `[]` — a
  // cap of 0 never needed protecting. The negative case is the real one, and it
  // is about the COUNT, not the slice.
  describe("truncArray guard (direct, because ARRAY_CAPS cannot reach it)", () => {
    test("cap 0 empties the array", () => {
      expect(truncArray(["a", "b", "c"], 0)).toEqual({ kept: [], dropped: 3 });
    });

    test("cap 1 keeps exactly one", () => {
      expect(truncArray(["a", "b", "c"], 1)).toEqual({ kept: ["a"], dropped: 2 });
    });

    // THE case the guard earns its place on. Unguarded, `arr.length - cap` is
    // 2 - (-3) = 5: the summary would report five entries dropped from an array
    // that only ever held two.
    test("negative cap drops everything and reports the true count, not length - cap", () => {
      expect(truncArray(["a", "b"], -3)).toEqual({ kept: [], dropped: 2 });
    });

    test("at or under cap passes through untouched, reporting no drop", () => {
      expect(truncArray(["a", "b"], 2)).toEqual({ kept: ["a", "b"], dropped: 0 });
      expect(truncArray(["a"], 5)).toEqual({ kept: ["a"], dropped: 0 });
      expect(truncArray([], 3)).toEqual({ kept: [], dropped: 0 });
    });
  });

  test("AC3d: a summary with nothing over cap reports no truncation at all", async () => {
    const callFn: MockFn = async () => ({
      output: {
        intent: "ok",
        key_changes: ["one", "two"],
        risks: ["r1"],
        file_count: 1,
        files_with_purpose: [{ path: "x.ts", purpose: "p" }],
        source: "haiku",
      },
      usage,
    });
    const r = await runDiffSummary({ diffText: SAMPLE_DIFF, callFn });
    expect(r?.summary.truncated).toEqual({});
  });

  // Review finding #2: before array truncation existed, an over-cap
  // files_with_purpose always failed safeParse and never reached the post-parse
  // file_count reconciliation, so its unconditional push could not overflow.
  // It can now. 40 kept + 1 pushed = 41, past the .max(40) this fix exists to
  // satisfy, carrying two truncation notes computed from different bases.
  test("AC3e: post-parse file-count note cannot push the array back over the cap", async () => {
    const manyFileDiff = Array.from({ length: 45 }, (_, i) =>
      `diff --git a/f${i}.ts b/f${i}.ts\n@@ -1 +1 @@\n-a\n+b\n`,
    ).join("");
    const callFn: MockFn = async () => ({
      output: {
        intent: "ok",
        key_changes: ["one"],
        risks: [],
        // Haiku undercounts (so the reconciliation branch fires) AND returns an
        // over-cap array (so coerceLengths already truncated to exactly 40).
        file_count: 41,
        files_with_purpose: Array.from({ length: 41 }, (_, i) => ({ path: `f${i}.ts`, purpose: "p" })),
        source: "haiku",
      },
      usage,
    });
    const r = await runDiffSummary({ diffText: manyFileDiff, callFn });
    expect(r?.summary.files_with_purpose.length).toBeLessThanOrEqual(40);
    // The fact is not lost — file_count carries the ground truth, which is what
    // the dashboard's count-vs-enumerated mismatch banner renders off.
    expect(r?.summary.file_count).toBe(45);
  });
});
