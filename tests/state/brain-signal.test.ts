// When and how an unhealthy brain is surfaced (card line + dashboard strip +
// the statusline's latched bubble). Moved out of brain-health.test.ts with
// the predicate itself.
import { test, expect } from "bun:test";
import {
  freshBrainHealth,
  recordFailure,
  recordSuccess,
  clearBreaker,
  isBreakerOpen,
  type BrainHealth,
} from "../../src/state/brain-health";
import { brainUnhealthySignal, latchedSinceMs } from "../../src/state/brain-signal";

const T0 = new Date("2026-06-11T10:00:00.000Z");
const iso = (d: Date) => d.toISOString();
const plusMin = (d: Date, m: number) => new Date(d.getTime() + m * 60_000);

function fail(
  h: BrainHealth,
  cls: "throttle" | "resource" | "permanent" | "ambiguous",
  ts: Date = T0,
): BrainHealth {
  return recordFailure(h, {
    class: cls,
    exit_code: 1,
    stderr_excerpt: "x",
    ts: iso(ts),
  });
}

// ── surfacing predicate (card line + dashboard strip) ──────────────

test("one transient failure does NOT surface; two consecutive do", () => {
  let h = fail(freshBrainHealth(), "ambiguous");
  expect(brainUnhealthySignal(h, plusMin(T0, 1)).show).toBe(false);
  h = fail(h, "ambiguous");
  const sig = brainUnhealthySignal(h, plusMin(T0, 1));
  expect(sig.show).toBe(true);
  expect(sig.line).toContain("ambiguous");
});

test("permanent class surfaces at the FIRST failure", () => {
  const h = fail(freshBrainHealth(), "permanent");
  const sig = brainUnhealthySignal(h, plusMin(T0, 1));
  expect(sig.show).toBe(true);
  expect(sig.line).toContain("permanent");
});

test("signal ages out after 24h", () => {
  const h = fail(fail(freshBrainHealth(), "resource"), "resource");
  expect(brainUnhealthySignal(h, plusMin(T0, 25 * 60)).show).toBe(false);
});

/**
 * The strip used to read `⚠ brain: resource ×4 — <80 chars of raw stderr>` for
 * a full 24 hours after the last failure, in the present tense, while the
 * breaker was open and NOTHING had been attempted since. Observed live: four
 * failures at 15:34Z, `last_attempt_ts` still 15:34Z an hour later, breaker
 * open the whole time — and the banner said the brain was failing. "I am not
 * currently trying" had no rendering, so it rendered as "I am failing".
 */
test("while the breaker is open the strip says PAUSED, and how long is left", () => {
  // A realistic excerpt: what the live record actually held was a JSON tail.
  const RAW = '"errors":["[ede_diagnostic] result_type=user"]';
  let h = recordFailure(freshBrainHealth(), { class: "resource", exit_code: 143, stderr_excerpt: RAW, ts: iso(T0) });
  h = recordFailure(h, { class: "resource", exit_code: 143, stderr_excerpt: RAW, ts: iso(T0) });
  // resource, 2nd consecutive → 60min window. 20 minutes in, 40 left.
  const sig = brainUnhealthySignal(h, plusMin(T0, 20));
  expect(sig.show).toBe(true);
  expect(sig.line).toContain("paused");
  expect(sig.line).toContain("40m");
  // The count is still worth showing; the raw stderr is not — it moves to the
  // hover detail so the strip stops leading with a JSON fragment.
  expect(sig.line).toContain("2");
  expect(sig.line).not.toContain("ede_diagnostic");
  expect(sig.detail).toContain("ede_diagnostic");
});

test("once the breaker window has passed the strip stops claiming to be paused", () => {
  const h = fail(fail(freshBrainHealth(), "resource"), "resource");
  // 90 minutes in: past the 60min window, still inside the 24h age-out.
  const sig = brainUnhealthySignal(h, plusMin(T0, 90));
  expect(sig.show).toBe(true);
  expect(sig.line).not.toContain("paused");
  // ...and says when the failures actually were, so a stale strip cannot read
  // as a live one.
  expect(sig.line).toContain("1h");
});

test("a permanent failure is latched, not on a timer — it never shows a countdown", () => {
  const h = recordFailure(freshBrainHealth(), {
    class: "permanent", exit_code: 1, stderr_excerpt: "Invalid API key", ts: iso(T0),
  });
  const sig = brainUnhealthySignal(h, plusMin(T0, 20));
  expect(sig.show).toBe(true);
  expect(sig.line).toContain("permanent");
  expect(sig.line).not.toMatch(/retrying in/);
  expect(sig.line).toContain("/siltpoke:siltpoke-wake");
  // The reason stays IN the line for this class only — it is the action, and
  // the statusline card renders this string with nowhere to put a tooltip.
  expect(sig.line).toContain("Invalid API key");
});

/**
 * Audit [48]. The 24h age-out measured from the last failure, and a latched
 * breaker stops every later attempt — so the last failure never gets newer.
 * One day in, the strip went away while reviews were still being skipped.
 * Measured on the maintainer's machine: latched 2026-09-29T18:45Z, cleared by
 * hand about a day and a half later, 562 turns skipped, nothing on screen for
 * the last third of it.
 */
test("a latched breaker keeps surfacing past 24h — it is still stopping reviews", () => {
  const h = fail(freshBrainHealth(), "permanent");
  for (const hours of [25, 36, 24 * 30]) {
    const now = plusMin(T0, hours * 60);
    // The premise first: reviews really are still blocked at this point.
    expect(isBreakerOpen(h, now).open).toBe(true);
    const sig = brainUnhealthySignal(h, now);
    expect(sig.show).toBe(true);
    expect(sig.line).toContain("/siltpoke:siltpoke-wake");
  }
});

test("a latched breaker still surfaces past 24h when the newest failure is a different class", () => {
  // The /siltpoke-review path has no breaker pre-check, so it can record an
  // ambiguous failure on top of the latch. The latch survives (F4 above) and
  // the strip must not start reading the newer record's class instead.
  let h = fail(freshBrainHealth(), "permanent");
  h = fail(h, "ambiguous");
  expect(h.breaker?.class).toBe("permanent");
  expect(brainUnhealthySignal(h, plusMin(T0, 36 * 60)).show).toBe(true);
});

test("once the latch is cleared the 24h age-out applies again", () => {
  const h = clearBreaker(fail(freshBrainHealth(), "permanent"));
  // Inside the window the cleared record still shows, as a past-tense line...
  expect(brainUnhealthySignal(h, plusMin(T0, 60)).show).toBe(true);
  // ...and a day later it is gone. Without this the fix above could be
  // "never age out anything permanent", which would pin a stale strip forever.
  expect(brainUnhealthySignal(h, plusMin(T0, 25 * 60)).show).toBe(false);
});

test("signal clears automatically on next success (no user ack)", () => {
  let h = fail(fail(freshBrainHealth(), "resource"), "resource");
  h = recordSuccess(h, iso(plusMin(T0, 5)));
  expect(brainUnhealthySignal(h, plusMin(T0, 6)).show).toBe(false);
});
