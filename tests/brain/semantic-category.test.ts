import { describe, test, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseBrainOutput, categoryEnum } from "../../src/brain/schema";

const base = {
  mood: "watching",
  pose: "base",
  bubble_short: "hi",
  bubble_long: "",
  critique_for_claude: "src/a.ts:1 — something",
  severity: "medium",
  confidence: "high",
  xp_earned_events: [],
  evidence: [{ tool: "git-diff", file: "src/a.ts", line: 1, snippet: "x".repeat(12) }],
  reasoning: "because",
};

describe("the production schema keeps the semantic fields", () => {
  // The whole point. brainOutputSchema is a plain z.object with no .strict(),
  // so Zod STRIPS unknown keys silently — a prompt-only change would have the
  // model emit `category` and the parser discard it without a word. That is the
  // "designed but unreachable" defect this track exists to close, so the field
  // surviving the parse is the thing worth asserting.
  test("category survives parsing", () => {
    const out = parseBrainOutput({ ...base, category: "correctness" });
    expect(out.category).toBe("correctness");
  });

  test("what_would_refute survives parsing", () => {
    const out = parseBrainOutput({ ...base, what_would_refute: "a definition elsewhere in the file" });
    expect(out.what_would_refute).toBe("a definition elsewhere in the file");
  });

  test("refutation_checked survives parsing", () => {
    const out = parseBrainOutput({ ...base, refutation_checked: "no" });
    expect(out.refutation_checked).toBe("no");
  });

  // Every critique file on disk predates these fields, for the same reason
  // `reasoning` is optional. An entry without them must still parse.
  test("output with none of the three still parses", () => {
    const out = parseBrainOutput(base);
    expect(out.category).toBeUndefined();
    expect(out.severity).toBe("medium");
  });

  test("a category outside the taxonomy is rejected, not silently kept", () => {
    expect(() => parseBrainOutput({ ...base, category: "vibes" })).toThrow();
  });

  test("refutation_checked offers an honest 'could not check from the diff'", () => {
    const out = parseBrainOutput({ ...base, refutation_checked: "not-possible-from-the-diff" });
    expect(out.refutation_checked).toBe("not-possible-from-the-diff");
  });

  test("the taxonomy is the seven categories schema-v2 already declared", () => {
    expect([...categoryEnum.options].sort()).toEqual(
      ["consistency", "correctness", "design", "performance", "readability", "security", "tests"],
    );
  });
});

// ⚠️ PARKED, NOT FORGOTTEN — and this block is the tripwire that keeps it that way.
//
// #655 added these fields to the schema AND asked the prompt for them. The paid
// A/B that followed (#657, $3.82) said no:
//
//     traps passed      OFF 7/9   ON 7/9   — identical, no improvement
//     controls passed   OFF 8/8   ON 6/8   — the new prompt LOST visible bugs
//
// and on the fixture that regressed, pooled over two runs, OFF was 8/8 and ON was
// 4/7. On the runs where it lost a fully-visible off-by-one it had written
// `refutation_checked: not-possible-from-the-diff` — about a defect entirely
// inside the hunk. "If you cannot check, stay at info" was being used as an
// excuse to abstain rather than a trigger to go look, and a miss is invisible in
// a way a false positive is not.
//
// So the PROMPT half was reverted and the SCHEMA half kept. That leaves the three
// fields declared and unrequested — which is exactly the "designed but
// unreachable" shape this whole track exists to hunt. The difference between a
// deliberate parking and that defect is only ever whether something ASSERTS it,
// so these tests do:
//
//   · the schema still accepts the fields (kept, and proven reachable by #657 —
//     they really did arrive from the model and come back)
//   · the prompt does not ask for them, ON PURPOSE
//
// If you are here because this block went red, you have re-added the request to
// the prompt. That may well be right — but read
// an internal design note first, and re-run
// `bun run eval:refutation --max-usd=5` before shipping it. The last version of
// this idea cost recall, and nothing but that harness will tell you whether yours
// does too.
describe("the prompt does NOT ask for them — parked after #657", () => {
  const prompt = readFileSync(join(import.meta.dir, "../../src/brain/system-prompt.md"), "utf8");

  test("no category taxonomy in the prompt", () => {
    for (const c of categoryEnum.options) {
      // `tests` and `design` are ordinary English and appear in unrelated prose;
      // the taxonomy is recognisable by the enum LINE, not by its member words.
      if (c === "tests" || c === "design") continue;
      expect(prompt).not.toContain(c);
    }
    expect(prompt).not.toContain("correctness | security");
  });

  test("no refutation fields in the prompt", () => {
    expect(prompt).not.toContain("what_would_refute");
    expect(prompt).not.toContain("refutation_checked");
  });

  // The specific rule that caused the regression. Named on its own so a re-add
  // of the taxonomy alone does not silently drag this back in with it.
  test("no outside-the-diff escape hatch that demotes severity", () => {
    expect(prompt).not.toMatch(/outside\s+the\s*\n?\s*diff[\s\S]{0,200}severity\s+stays/i);
  });
});
