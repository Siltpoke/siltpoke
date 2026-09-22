// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
// Copyright (c) 2026 Jiaqi Duan
/**
 * A brain failure must reach the user as a sentence, not as JSON debris — and
 * must not be dropped on the floor.
 *
 * WHY — audit defect `[4]` (an internal design note).
 * Two symptoms, one cause. The hook logged
 *
 *   HARD_SUPPRESS — Brain call failed in PASSIVE_BUBBLE:
 *   BrainError: [brain-failure …] claude -p exited with code 1:
 *
 * with nothing after the colon, because the message interpolated `stderr`
 * alone — while `claude -p --output-format json` puts the reason on STDOUT.
 * The dashboard, which concatenated stderr and stdout raw, showed the same
 * failure as
 *
 *   ⚠ brain stopped after 1 permanent failure — e:{"success","api_error_status":null,
 *   "result":"Not logged in · Please run /login · clear with …
 *
 * The real reason — `Not logged in` — was recorded both times. One side threw
 * it away; the other pasted the envelope around it into a user-facing line.
 */
import { describe, expect, test } from "bun:test";
import { explainBrainFailure } from "../../src/brain/failure-reason";

/** What `claude -p --output-format json` actually writes when auth is missing. */
const NOT_LOGGED_IN = JSON.stringify({
  type: "result",
  subtype: "error",
  is_error: true,
  api_error_status: null,
  result: "Not logged in · Please run /login",
});

describe("explainBrainFailure", () => {
  test("pulls the reason out of a JSON result event on stdout", () => {
    const r = explainBrainFailure({ exitCode: 1, stderr: "", stdout: NOT_LOGGED_IN });
    expect(r).toBe("Not logged in · Please run /login");
  });

  test("the reason never carries JSON punctuation into a user-facing line", () => {
    const r = explainBrainFailure({ exitCode: 1, stderr: "", stdout: NOT_LOGGED_IN });
    expect(r).not.toContain('{"');
    expect(r).not.toContain("is_error");
    expect(r).not.toContain("api_error_status");
  });

  test("prefers an explicit `error` field over `result`", () => {
    const stdout = JSON.stringify({
      type: "result",
      is_error: true,
      error: "Credit balance is too low",
      result: "",
    });
    expect(explainBrainFailure({ exitCode: 1, stderr: "", stdout })).toBe(
      "Credit balance is too low",
    );
  });

  test("falls back to stderr when there is no JSON to read", () => {
    const r = explainBrainFailure({
      exitCode: 127,
      stderr: "claude: command not found",
      stdout: "",
    });
    expect(r).toBe("claude: command not found");
  });

  test("uses plain stdout when it is not JSON and stderr is empty", () => {
    const r = explainBrainFailure({ exitCode: 1, stderr: "", stdout: "something broke" });
    expect(r).toBe("something broke");
  });

  test("a spawn error wins — the process never ran", () => {
    const r = explainBrainFailure({
      exitCode: null,
      stderr: "",
      stdout: "",
      spawnError: "ENOENT: no such file or directory",
    });
    expect(r).toContain("ENOENT");
  });

  test("says so honestly when there is genuinely nothing", () => {
    // The old message ended in a bare colon here. Anything is better, but it
    // must not pretend to a reason it does not have.
    const r = explainBrainFailure({ exitCode: 1, stderr: "", stdout: "" });
    expect(r.trim().length).toBeGreaterThan(0);
    expect(r).toMatch(/no output/i);
    expect(r).toContain("1");
  });

  test("never ends on a dangling colon, whatever the input", () => {
    for (const input of [
      { exitCode: 1, stderr: "", stdout: "" },
      { exitCode: 1, stderr: "   ", stdout: "\n\n" },
      { exitCode: null, stderr: "", stdout: "" },
      { exitCode: 1, stderr: "", stdout: NOT_LOGGED_IN },
    ]) {
      expect(explainBrainFailure(input).trim()).not.toMatch(/[:·—-]$/);
    }
  });

  test("is bounded — a huge body cannot flood a statusline", () => {
    const r = explainBrainFailure({ exitCode: 1, stderr: "x".repeat(9000), stdout: "" });
    expect(r.length).toBeLessThanOrEqual(500);
  });

  test("raw output keeps its TAIL, a distilled reason keeps its HEAD", () => {
    // Two directions on purpose. An error payload's informative part sits at
    // the end behind a boilerplate preamble — pinned by
    // `tests/brain/brain-guarded.test.ts`, which predates this module and
    // which this change must not quietly reverse. A sentence like
    // "Not logged in · Please run /login" is ruined by dropping its opening.
    const raw = explainBrainFailure(
      { exitCode: 1, stderr: `preamble ${"x".repeat(220)} INFORMATIVE-TAIL`, stdout: "" },
      200,
    );
    expect(raw.endsWith("INFORMATIVE-TAIL")).toBe(true);
    expect(raw.startsWith("preamble")).toBe(false);

    const sentence = explainBrainFailure(
      {
        exitCode: 1,
        stderr: "",
        stdout: JSON.stringify({
          type: "result",
          is_error: true,
          result: `Not logged in ${"y".repeat(300)}`,
        }),
      },
      200,
    );
    expect(sentence.startsWith("Not logged in")).toBe(true);
  });

  test("the caller's cap is honoured, not just the default", () => {
    const r = explainBrainFailure({ exitCode: 1, stderr: "z".repeat(900), stdout: "" }, 40);
    expect(r.length).toBe(40);
  });

  test("collapses newlines so a one-line surface stays one line", () => {
    const r = explainBrainFailure({
      exitCode: 1,
      stderr: "first line\nsecond line\n\nthird",
      stdout: "",
    });
    expect(r).not.toContain("\n");
    expect(r).toContain("first line");
    expect(r).toContain("third");
  });

  // ── a completed answer is not a failure reason ────────────────────────────

  test("a COMPLETED, non-error payload is never presented as the reason", () => {
    // The realistic case: `brain.ts` kills the subprocess at its timeout, and
    // the model had already flushed a whole successful result event. Exit 143.
    // The model's answer is emphatically not why the call failed.
    const answered = JSON.stringify({
      type: "result",
      subtype: "success",
      is_error: false,
      result: "The refactor looks fine; no findings.",
    });
    const r = explainBrainFailure({ exitCode: 143, stderr: "", stdout: answered });
    expect(r).not.toContain("refactor looks fine");
    expect(r).toContain("143");
    expect(r).toMatch(/already answered/i);
  });

  test("…and its raw JSON is not pasted instead (the debris this module prevents)", () => {
    const answered = JSON.stringify({
      type: "result",
      is_error: false,
      result: "some answer",
    });
    const r = explainBrainFailure({ exitCode: 143, stderr: "", stdout: answered });
    for (const debris of ['{"', "is_error", '"result"', "type"]) {
      expect(r).not.toContain(debris);
    }
  });

  test("a real stderr reason still wins over a completed payload", () => {
    const answered = JSON.stringify({ type: "result", is_error: false, result: "answer" });
    const r = explainBrainFailure({
      exitCode: 143,
      stderr: "Killed: timeout after 90s",
      stdout: answered,
    });
    expect(r).toBe("Killed: timeout after 90s");
  });

  test("an absent is_error still counts as a reason (control for the two above)", () => {
    // Only an EXPLICIT `is_error: false` disqualifies a `result`. Payloads that
    // omit the field stay eligible — the classifier does not require it either,
    // and without this control the assertions above would also pass if the
    // `result` path had simply been deleted.
    const r = explainBrainFailure({
      exitCode: 1,
      stderr: "",
      stdout: JSON.stringify({ type: "result", result: "Not logged in" }),
    });
    expect(r).toBe("Not logged in");
  });

  // ── the shape production actually sends ──────────────────────────────────

  test("reads the VERBOSE event ARRAY, which is what claude -p really writes", () => {
    // `brain.ts` always passes `--output-format json --verbose`, which emits an
    // array of stream events, not a bare result object. Every other fixture
    // here uses the simplified single-object shape.
    const stream = JSON.stringify([
      { type: "system", subtype: "init" },
      { type: "assistant", message: { content: [{ type: "text", text: "…" }] } },
      {
        type: "result",
        subtype: "error",
        is_error: true,
        result: "Not logged in · Please run /login",
      },
    ]);
    expect(explainBrainFailure({ exitCode: 1, stderr: "", stdout: stream })).toBe(
      "Not logged in · Please run /login",
    );
  });

  // ── the cap is a public parameter, so it is enforced ──────────────────────

  test("max = 0 does not empty a reason, and does not unbound a raw body", () => {
    // `"abc".slice(-0)` is `"abc"` — a zero cap used to return the WHOLE body
    // on the raw path while emptying the distilled path. Neither caller can
    // pass 0 today; the guarantee is enforced rather than assumed.
    const distilled = explainBrainFailure(
      { exitCode: 1, stderr: "", stdout: JSON.stringify({ type: "result", result: "Not logged in" }) },
      0,
    );
    expect(distilled).toBe("Not logged in");

    const raw = explainBrainFailure({ exitCode: 1, stderr: "A".repeat(900), stdout: "" }, 0);
    expect(raw.length).toBe(500);
  });

  test("a negative or non-finite max falls back to the default", () => {
    for (const bad of [-5, Number.NaN, Number.POSITIVE_INFINITY]) {
      const r = explainBrainFailure({ exitCode: 1, stderr: "Not logged in", stdout: "" }, bad);
      expect(r).toBe("Not logged in");
    }
  });

  test("the result is never empty, for any input tried here", () => {
    const inputs = [
      { exitCode: 1, stderr: "", stdout: "" },
      { exitCode: null, stderr: "   ", stdout: "\n" },
      { exitCode: 143, stderr: "", stdout: JSON.stringify({ type: "result", is_error: false, result: "x" }) },
    ];
    for (const facts of inputs) {
      for (const max of [0, -1, 1, 500]) {
        expect(explainBrainFailure(facts, max).trim().length).toBeGreaterThan(0);
      }
    }
  });
});
