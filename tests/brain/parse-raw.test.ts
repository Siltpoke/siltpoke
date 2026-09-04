import { describe, expect, test } from "bun:test";
import { BrainError } from "../../src/brain/brain";
import { brainOutputFromText, parseRawJson } from "../../src/brain/parse-raw";

describe("parseRawJson", () => {
  test("parses fenced JSON (```json ... ```)", () => {
    expect(parseRawJson('```json\n{"a":1}\n```')).toEqual({ a: 1 });
  });
  test("parses bare JSON", () => {
    expect(parseRawJson('{"a":2}')).toEqual({ a: 2 });
  });
  test("throws BrainError on non-JSON prose", () => {
    expect(() => parseRawJson("I think the answer is 42")).toThrow(BrainError);
  });
});

describe("brainOutputFromText", () => {
  test("parses a full valid brain envelope", () => {
    const envelope = JSON.stringify({
      mood: "happy", pose: "base", bubble_short: "ok", bubble_long: "all good",
      critique_for_claude: "", severity: "info", confidence: "medium", xp_earned_events: [],
    });
    const out = brainOutputFromText(envelope);
    expect(out.mood).toBe("happy");
  });
  test("throws BrainError when schema fields are missing", () => {
    expect(() => brainOutputFromText('{"mood":"neutral"}')).toThrow(BrainError);
  });
});

// 152 schema-validation failures sit in ~/.siltpoke/traces and not one of them
// says which field failed. `BrainError` stores the ZodError as `.cause`, and
// nothing in src/ reads `.cause`; the raw text is in scope at the throw site and
// is dropped too. So the whole class is undiagnosable from history — the third
// instance this session of "the thing needed to diagnose is discarded where it
// is thrown" (cf. eslintConfigPaths, and the tool span disarmed by a missing
// argument).
//
// The message therefore has to name the failing paths. It names PATHS AND CODES
// ONLY — never zod's own `message`, which interpolates the received value and
// would put reviewed source into a log line that the span input is deliberately
// redacted to keep out.
describe("brainOutputFromText — schema failures name the field", () => {
  function envelope(overrides: Record<string, unknown>): string {
    return JSON.stringify({
      mood: "happy", pose: "base", bubble_short: "ok", bubble_long: "all good",
      critique_for_claude: "", severity: "info", confidence: "medium",
      xp_earned_events: [], ...overrides,
    });
  }

  function messageOf(text: string): string {
    try {
      brainOutputFromText(text);
    } catch (err) {
      return (err as Error).message;
    }
    throw new Error("expected brainOutputFromText to throw");
  }

  test("a violated FLOOR names its own field", () => {
    // Was an over-long `reasoning` until 2026-08-31. Over-long values no longer
    // reach the parser — they are trimmed before it, because discarding a whole
    // review over a length was the defect. Floors still reject and cannot be
    // coerced: shortening drops model output, lengthening would invent it. So the
    // field-naming behaviour (#647) is pinned to a failure that still happens.
    const msg = messageOf(envelope({ xp_earned_events: [{ type: "review", amount: -1 }] }));
    expect(msg).toContain("amount");
    expect(msg).toContain("too_small");
  });

  test("the detail is path:code pairs and nothing else", () => {
    const msg = messageOf(envelope({ severity: "catastrophic" }));
    expect(msg).toContain("severity");

    // Asserted as a SHAPE, not as `not.toContain("catastrophic")`. That negative
    // was written first and measured vacuous: zod 4 renders an enum failure as
    // `Invalid option: expected one of "info"|"low"|...` — it lists the ALLOWED
    // values and never the received one, so the negative passed no matter what
    // the implementation did. A guard that cannot fail is not a guard.
    //
    // This asserts the invariant directly: everything after the em dash is
    // `path: code` pairs. Any future formatter that starts appending zod's own
    // `message` — which CAN carry content for `custom` refinements and names
    // stray keys on `unrecognized_keys` — breaks this, which is the point.
    const detail = msg.split(" — ")[1];
    expect(detail).toBeDefined();
    expect(detail).toMatch(/^[\w.()]+: \w+(, [\w.()]+: \w+)*( \(\+\d+ more\))?$/);
  });

  test("a nested evidence failure names the path, not just the array", () => {
    // Was an `evidence.0.snippet` floor until 2026-09-01. A malformed evidence
    // item is now dropped rather than rejected, so the nested-path behaviour
    // (#647) is pinned to a nested failure that still reaches the parser.
    const msg = messageOf(envelope({ xp_earned_events: [{ type: "review", amount: -1 }] }));
    expect(msg).toContain("xp_earned_events.0.amount");
  });

  test("several failures are all named, not just the first", () => {
    const msg = messageOf(envelope({ severity: "nope", confidence: "nope" }));
    expect(msg).toContain("severity");
    expect(msg).toContain("confidence");
  });

  test("still a BrainError, and still says what happened", () => {
    expect(() => brainOutputFromText(envelope({ severity: "nope" }))).toThrow(BrainError);
    expect(messageOf(envelope({ severity: "nope" }))).toContain("schema validation");
  });
});

// The enriched message is only useful if it survives the one interpolation that
// actually reaches telemetry. `normal.ts:239` builds the recorded reason as
// `Brain call failed in NORMAL: ${err}` — template interpolation of an Error,
// not `.message` — so this asserts the real mechanism instead of reasoning that
// it must work.
test("the detail survives the interpolation that reaches telemetry", () => {
  let caught: unknown;
  try {
    brainOutputFromText(
      JSON.stringify({
        mood: "happy", pose: "base", bubble_short: "ok", bubble_long: "",
        critique_for_claude: "", severity: "nope", confidence: "medium",
        xp_earned_events: [],
      }),
    );
  } catch (err) {
    caught = err;
  }
  const recordedReason = `Brain call failed in NORMAL: ${caught}`;
  expect(recordedReason).toContain("severity");
  // And the classifier that reads this string must still recognise it.
  expect(recordedReason.includes("failed schema validation")).toBe(true);
});
