// Brain health record: single writer, corrupt-tolerant reader, pure
// breaker/retry-budget transitions.
import { test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  freshBrainHealth,
  readBrainHealth,
  readBrainHealthAsync,
  writeBrainHealth,
  recordFailure,
  recordSuccess,
  clearBreaker,
  isBreakerOpen,
  canOuterRetry,
  consumeOuterRetry,
  canConsumeQuotaCall,
  consumeQuotaCall,
  tryConsumeQuotaCall,
  brainUnhealthySignal,
  QUOTA_CALL_DAILY_CAP,
  type BrainHealth,
} from "../../src/state/brain-health";

let tmp: string;
beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "siltpoke-brain-health-"));
});
afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

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

// ── reader contingency: missing/corrupt → fresh closed-breaker state ────────

test("missing file reads as fresh closed-breaker state (contingency)", () => {
  const h = readBrainHealth(tmp);
  expect(h.schema_version).toBe(1);
  expect(h.breaker).toBeNull();
  expect(h.consecutive_failures).toBe(0);
  expect(isBreakerOpen(h, T0).open).toBe(false);
});

test("corrupt file reads as fresh closed-breaker state, does not throw (contingency)", () => {
  writeFileSync(join(tmp, "brain-health.json"), "{not json!!");
  const h = readBrainHealth(tmp);
  expect(h.breaker).toBeNull();
  expect(h.consecutive_failures).toBe(0);
});

test("F2 valid schema_version but garbage breaker next_eligible_at reads as FRESH state (no zombie breaker)", () => {
  const zombie = {
    ...fail(freshBrainHealth(), "resource"),
    breaker: {
      class: "resource",
      opened_at: iso(T0),
      next_eligible_at: "not-a-date!!",
    },
  };
  writeFileSync(join(tmp, "brain-health.json"), JSON.stringify(zombie));
  const h = readBrainHealth(tmp);
  expect(h.breaker).toBeNull();
  expect(h.consecutive_failures).toBe(0);
  expect(h.last_failure).toBeNull();
  expect(isBreakerOpen(h, T0).open).toBe(false);
});

test("PF2 corrupt negative/float outer_retries_used clamps to a non-negative integer (cap not under-counted)", () => {
  const corrupt = {
    ...freshBrainHealth(),
    retry_budget: { date: "2026-06-11", outer_retries_used: -3.7 },
  };
  writeFileSync(join(tmp, "brain-health.json"), JSON.stringify(corrupt));
  const h = readBrainHealth(tmp);
  expect(h.retry_budget.outer_retries_used).toBe(0);
  // NaN count → invalid → fresh zeroed budget, never NaN into canOuterRetry.
  const nan = {
    ...freshBrainHealth(),
    retry_budget: { date: "2026-06-11", outer_retries_used: Number.NaN },
  };
  writeFileSync(join(tmp, "brain-health.json"), JSON.stringify(nan)); // NaN → null in JSON
  const h2 = readBrainHealth(tmp);
  expect(h2.retry_budget.outer_retries_used).toBe(0);
});

test("F2 garbage breaker opened_at reads as fresh state", () => {
  const zombie = {
    ...fail(freshBrainHealth(), "resource"),
    breaker: {
      class: "resource",
      opened_at: "garbage",
      next_eligible_at: iso(plusMin(T0, 15)),
    },
  };
  writeFileSync(join(tmp, "brain-health.json"), JSON.stringify(zombie));
  expect(readBrainHealth(tmp).breaker).toBeNull();
});

test("F2 garbage last_failure.ts reads as fresh state", () => {
  const corrupt = {
    ...fail(freshBrainHealth(), "ambiguous"),
    last_failure: {
      class: "ambiguous",
      exit_code: 1,
      stderr_excerpt: "x",
      ts: "yesterday-ish",
    },
  };
  writeFileSync(join(tmp, "brain-health.json"), JSON.stringify(corrupt));
  expect(readBrainHealth(tmp).last_failure).toBeNull();
});

test("F2 valid breaker dates still read through untouched", () => {
  const h = fail(freshBrainHealth(), "resource");
  writeBrainHealth(tmp, h);
  const back = readBrainHealth(tmp);
  expect(back.breaker?.class).toBe("resource");
  expect(isBreakerOpen(back, plusMin(T0, 14)).open).toBe(true);
});

test("write/read roundtrip is atomic-overwrite", () => {
  const h = fail(freshBrainHealth(), "resource");
  writeBrainHealth(tmp, h);
  expect(existsSync(join(tmp, "brain-health.json"))).toBe(true);
  const back = readBrainHealth(tmp);
  expect(back.consecutive_failures).toBe(1);
  expect(back.last_failure?.class).toBe("resource");
});

// ── breaker windows ───────────────────────────────────────────────────

test("resource failure #1 opens breaker for 15min", () => {
  const h = fail(freshBrainHealth(), "resource");
  expect(h.breaker?.class).toBe("resource");
  expect(isBreakerOpen(h, plusMin(T0, 14)).open).toBe(true);
  expect(isBreakerOpen(h, plusMin(T0, 16)).open).toBe(false);
});

test("resource failure #2 consecutive escalates to 60min", () => {
  const h = fail(fail(freshBrainHealth(), "resource"), "resource");
  expect(isBreakerOpen(h, plusMin(T0, 59)).open).toBe(true);
  expect(isBreakerOpen(h, plusMin(T0, 61)).open).toBe(false);
});

test("ambiguous failures 1-2 do NOT open the breaker", () => {
  const h = fail(fail(freshBrainHealth(), "ambiguous"), "ambiguous");
  expect(h.breaker).toBeNull();
});

test("ambiguous failure #3 opens 5min, #4 15min, #5 60min", () => {
  let h = freshBrainHealth();
  h = fail(fail(fail(h, "ambiguous"), "ambiguous"), "ambiguous");
  expect(isBreakerOpen(h, plusMin(T0, 4)).open).toBe(true);
  expect(isBreakerOpen(h, plusMin(T0, 6)).open).toBe(false);
  h = fail(h, "ambiguous");
  expect(isBreakerOpen(h, plusMin(T0, 14)).open).toBe(true);
  expect(isBreakerOpen(h, plusMin(T0, 16)).open).toBe(false);
  h = fail(h, "ambiguous");
  expect(isBreakerOpen(h, plusMin(T0, 59)).open).toBe(true);
  expect(isBreakerOpen(h, plusMin(T0, 61)).open).toBe(false);
});

test("throttle failures never open the breaker (retry policy handles them)", () => {
  const h = fail(fail(fail(freshBrainHealth(), "throttle"), "throttle"), "throttle");
  expect(h.breaker).toBeNull();
  expect(h.consecutive_failures).toBe(3);
});

test("permanent failure latches the breaker — open regardless of elapsed time", () => {
  const h = fail(freshBrainHealth(), "permanent");
  expect(h.breaker?.class).toBe("permanent");
  expect(isBreakerOpen(h, plusMin(T0, 60 * 24 * 365)).open).toBe(true);
});

test("F4 latched permanent breaker SURVIVES a subsequent non-permanent failure (clears only via wake/doctor)", () => {
  const latched = fail(freshBrainHealth(), "permanent");
  const originalBreaker = latched.breaker;
  expect(originalBreaker?.class).toBe("permanent");

  // e.g. an ambiguous failure recorded via the /siltpoke-review path (no
  // breaker pre-check) — must NOT replace/drop the permanent latch.
  const after = fail(latched, "ambiguous", plusMin(T0, 5));
  expect(after.breaker).toEqual(originalBreaker!); // latch unchanged
  expect(after.consecutive_failures).toBe(2); // counters still record
  expect(after.last_failure?.class).toBe("ambiguous");
  expect(isBreakerOpen(after, plusMin(T0, 60 * 24)).open).toBe(true); // still latched
});

test("F4 a new PERMANENT failure still refreshes the permanent latch", () => {
  const latched = fail(freshBrainHealth(), "permanent");
  const after = fail(latched, "permanent", plusMin(T0, 5));
  expect(after.breaker?.class).toBe("permanent");
  expect(after.breaker?.opened_at).toBe(iso(plusMin(T0, 5)));
});

// ── success = full reset, but last-failure record retained ────────────

test("success resets counters + breaker but RETAINS last_failure for doctor", () => {
  let h = fail(fail(freshBrainHealth(), "resource"), "resource");
  h = recordSuccess(h, iso(plusMin(T0, 90)));
  expect(h.consecutive_failures).toBe(0);
  expect(h.breaker).toBeNull();
  expect(h.last_success_ts).toBe(iso(plusMin(T0, 90)));
  expect(h.last_failure?.class).toBe("resource"); // retained with timestamp
  expect(isBreakerOpen(h, plusMin(T0, 91)).open).toBe(false);
});

// ── F5: clearBreaker + async reader ──────────────────────────────────────────

test("F5 clearBreaker clears ONLY the breaker — counters and last_failure intentionally survive", () => {
  const h = fail(fail(freshBrainHealth(), "resource"), "resource");
  const cleared = clearBreaker(h);
  expect(cleared.breaker).toBeNull();
  expect(cleared.consecutive_failures).toBe(2); // wake = "try now", not "healthy"
  expect(cleared.last_failure?.class).toBe("resource");
  expect(h.breaker).not.toBeNull(); // input untouched (immutability)
});

test("F5 readBrainHealthAsync matches the sync reader (roundtrip + missing-file contingency)", async () => {
  expect(await readBrainHealthAsync(tmp)).toEqual(freshBrainHealth()); // missing
  const h = fail(freshBrainHealth(), "resource");
  writeBrainHealth(tmp, h);
  expect(await readBrainHealthAsync(tmp)).toEqual(readBrainHealth(tmp));
  writeFileSync(join(tmp, "brain-health.json"), "{not json!!");
  expect((await readBrainHealthAsync(tmp)).breaker).toBeNull(); // corrupt
});

// ── daily outer-retry budget (5/day) ───────────────────────────────────

test("outer-retry budget allows 5 per day then refuses", () => {
  let h = freshBrainHealth();
  for (let i = 0; i < 5; i++) {
    expect(canOuterRetry(h, T0)).toBe(true);
    h = consumeOuterRetry(h, T0);
  }
  expect(canOuterRetry(h, T0)).toBe(false);
});

test("outer-retry budget resets on date rollover", () => {
  let h = freshBrainHealth();
  for (let i = 0; i < 5; i++) h = consumeOuterRetry(h, T0);
  const nextDay = new Date("2026-06-12T01:00:00.000Z");
  expect(canOuterRetry(h, nextDay)).toBe(true);
});

// ── daily quota-call cap (50/day, quota-billed providers, T4/AC8) ──────
// Keyed per-provider-name (T6): agy (Google Code Assist) and codex (ChatGPT)
// are DISTINCT quota families and must draw on independent daily caps, not
// a shared pool.

test("quota-call cap allows 50 per day then refuses (codex)", () => {
  let h = freshBrainHealth();
  for (let i = 0; i < 50; i++) {
    expect(canConsumeQuotaCall(h, "codex", T0)).toBe(true);
    h = consumeQuotaCall(h, "codex", T0);
  }
  expect(canConsumeQuotaCall(h, "codex", T0)).toBe(false);
});

test("quota-call cap resets on date rollover (codex)", () => {
  let h = freshBrainHealth();
  for (let i = 0; i < 50; i++) h = consumeQuotaCall(h, "codex", T0);
  const nextDay = new Date("2026-06-12T01:00:00.000Z");
  expect(canConsumeQuotaCall(h, "codex", nextDay)).toBe(true);
});

test("tryConsumeQuotaCall re-reads fresh and persists the consumed slot", () => {
  expect(tryConsumeQuotaCall(tmp, "codex", T0)).toBe(true);
  expect(readBrainHealth(tmp).quota_calls_today.codex).toEqual({
    date: T0.toISOString().slice(0, 10),
    count: 1,
  });
});

test("tryConsumeQuotaCall refuses once the cap is already exhausted (fresh re-read, not caller's stale snapshot)", () => {
  writeBrainHealth(tmp, {
    ...freshBrainHealth(),
    quota_calls_today: { codex: { date: T0.toISOString().slice(0, 10), count: 50 } },
  });
  expect(tryConsumeQuotaCall(tmp, "codex", T0)).toBe(false);
  // Refusal must not further increment the persisted count.
  expect(readBrainHealth(tmp).quota_calls_today.codex?.count).toBe(50);
});

test("corrupt negative/float quota_calls_today[provider].count clamps to a non-negative integer (cap not under-counted)", () => {
  const corrupt = {
    ...freshBrainHealth(),
    quota_calls_today: { codex: { date: "2026-06-11", count: -3.7 } },
  };
  writeFileSync(join(tmp, "brain-health.json"), JSON.stringify(corrupt));
  expect(readBrainHealth(tmp).quota_calls_today.codex?.count).toBe(0);
});

// ── T6: per-provider independence + old-shape migration ────────────────

test("T6: agy calls do NOT consume codex's cap, and vice-versa — exhausting one leaves the other at full cap", () => {
  let h = freshBrainHealth();
  // Exhaust codex's entire daily cap.
  for (let i = 0; i < QUOTA_CALL_DAILY_CAP; i++) h = consumeQuotaCall(h, "codex", T0);
  expect(canConsumeQuotaCall(h, "codex", T0)).toBe(false);
  // agy is untouched — independent pool, still full cap remaining.
  expect(canConsumeQuotaCall(h, "agy", T0)).toBe(true);

  // Now exhaust agy's cap too — codex must stay exhausted (unaffected by agy).
  for (let i = 0; i < QUOTA_CALL_DAILY_CAP; i++) h = consumeQuotaCall(h, "agy", T0);
  expect(canConsumeQuotaCall(h, "agy", T0)).toBe(false);
  expect(canConsumeQuotaCall(h, "codex", T0)).toBe(false); // still exhausted, not doubly so
});

test("T6: both agy and codex default to QUOTA_CALL_DAILY_CAP on a fresh record", () => {
  const h = freshBrainHealth();
  expect(canConsumeQuotaCall(h, "agy", T0)).toBe(true);
  expect(canConsumeQuotaCall(h, "codex", T0)).toBe(true);
  // Draining agy to exactly the cap boundary doesn't touch codex's count.
  let hh = h;
  for (let i = 0; i < QUOTA_CALL_DAILY_CAP; i++) hh = consumeQuotaCall(hh, "agy", T0);
  expect(hh.quota_calls_today.codex).toBeUndefined();
  expect(hh.quota_calls_today.agy?.count).toBe(QUOTA_CALL_DAILY_CAP);
});

test("T6: tryConsumeQuotaCall keeps agy and codex pools independent through the file round-trip", () => {
  for (let i = 0; i < QUOTA_CALL_DAILY_CAP; i++) {
    expect(tryConsumeQuotaCall(tmp, "codex", T0)).toBe(true);
  }
  expect(tryConsumeQuotaCall(tmp, "codex", T0)).toBe(false); // codex exhausted
  expect(tryConsumeQuotaCall(tmp, "agy", T0)).toBe(true); // agy still fresh
  const health = readBrainHealth(tmp);
  expect(health.quota_calls_today.codex?.count).toBe(QUOTA_CALL_DAILY_CAP);
  expect(health.quota_calls_today.agy?.count).toBe(1);
});

test("T6: old pre-migration single-scalar quota_calls_today shape ({date,count}) reads tolerantly as an empty per-provider map, never crashes", () => {
  const legacyShape = {
    ...freshBrainHealth(),
    quota_calls_today: { date: "2026-06-11", count: 37 },
  };
  writeFileSync(join(tmp, "brain-health.json"), JSON.stringify(legacyShape));
  const h = readBrainHealth(tmp);
  expect(h.quota_calls_today).toEqual({});
  // Both providers read as fresh (full cap available) after the migration.
  expect(canConsumeQuotaCall(h, "codex", T0)).toBe(true);
  expect(canConsumeQuotaCall(h, "agy", T0)).toBe(true);
});

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
  expect(sig.line).toContain("/siltpoke-wake");
  // The reason stays IN the line for this class only — it is the action, and
  // the statusline card renders this string with nowhere to put a tooltip.
  expect(sig.line).toContain("Invalid API key");
});

test("signal clears automatically on next success (no user ack)", () => {
  let h = fail(fail(freshBrainHealth(), "resource"), "resource");
  h = recordSuccess(h, iso(plusMin(T0, 5)));
  expect(brainUnhealthySignal(h, plusMin(T0, 6)).show).toBe(false);
});
