/**
 * Unit tests for evaluateChatSendGate.
 *
 * These tests exercise the REAL gate composition logic with real
 * BudgetConfig + QuietHoursConfig + DailyRollup inputs (no mocks of
 * evaluateBudget or isQuietHour — those are the actual functions from
 * src/state/{budget-config,quiet-hours}.ts).
 *
 * This closes the soft-budget wiring gap: the unit tests in
 * chat-anchor.test.ts mock checkSendGate's RETURN directly, so they never
 * exercise the real evaluateBudget/isQuietHour composition. This file
 * proves the REAL lambda returns the correct shape for each case.
 *
 * Cases covered (by exhaustion):
 *   "ok" stage (tokens well below soft threshold) → null (pass)
 *   "soft" stage (tokens between soft and hard thresholds) → null (soft does NOT block)
 *   "hard" stage (tokens at or above hard threshold) → {blocked:"budget", used_pct}
 *   isQuietHour = true (quiet hours active) → {blocked:"quiet_hours"} regardless of budget
 *   isQuietHour = true + hard budget → quiet_hours wins (same ordering as server.ts)
 *   no quiet hours configured (start/end both null) → not blocked by quiet
 */
import { test, expect, describe } from "bun:test";
import { evaluateChatSendGate } from "../../src/daemon/routes/chat-send-gate";
import type { BudgetConfig } from "../../src/state/budget-config";
import { DEFAULT_BUDGET_CONFIG } from "../../src/state/budget-config";
import type { QuietHoursConfig } from "../../src/state/quiet-hours";
import type { DailyRollup } from "../../src/state/usage";

// ── Fixtures ──────────────────────────────────────────────────────────────────

const NO_QUIET: QuietHoursConfig = { start: null, end: null, timezone: "local" };

/** Quiet hours 23:00–08:00 (wrap-around). "now" at 01:00 is inside; 12:00 is outside. */
const QUIET_WRAP: QuietHoursConfig = { start: "23:00", end: "08:00", timezone: "local" };

const BASE_CONFIG: BudgetConfig = {
  ...DEFAULT_BUDGET_CONFIG,
  dailyTokenLimit: 1_000,
  softWarnAtPercent: 80,
  hardStopAtPercent: 100,
};

function rollup(totalTokens: number): DailyRollup {
  return {
    schemaVersion: 1,
    day: "2026-06-22",
    total_input_tokens: totalTokens,
    total_output_tokens: 0,
    total_cache_tokens: 0,
    total_cost_usd: 0,
    brain_calls: 1,
    reflections: 0,
    computed_at_ms: Date.now(),
  };
}

/** A date at 12:00 — outside QUIET_WRAP's 23:00–08:00 window. */
const NOON = new Date("2026-06-22T12:00:00.000Z"); // local-ish; the isQuietHour impl uses getHours()

/** A Date at a known quiet hour. We use getHours() == 1 (01:00 local). */
function dateAtLocalHour(h: number): Date {
  const d = new Date();
  d.setHours(h, 0, 0, 0);
  return d;
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("evaluateChatSendGate — real composition of evaluateBudget + isQuietHour", () => {
  test("ok stage (tokens well below soft threshold) → null (send proceeds)", () => {
    // 100 tokens / 1000 limit = 10% → "ok"
    const result = evaluateChatSendGate(BASE_CONFIG, rollup(100), NO_QUIET, NOON);
    expect(result).toBeNull();
  });

  test("soft stage (tokens between soft and hard thresholds) → null (soft does NOT block chat)", () => {
    // 850 tokens / 1000 limit = 85% → "soft" (between 80% and 100%)
    // Soft budget must NOT block chat sends (intentional scope).
    const result = evaluateChatSendGate(BASE_CONFIG, rollup(850), NO_QUIET, NOON);
    expect(result).toBeNull();
  });

  test("hard stage (tokens at hard threshold) → {blocked:'budget', used_pct}", () => {
    // 1000 tokens / 1000 limit = 100% → "hard"
    const result = evaluateChatSendGate(BASE_CONFIG, rollup(1_000), NO_QUIET, NOON);
    expect(result).not.toBeNull();
    expect(result?.blocked).toBe("budget");
    // used_pct should be 100 (or very close due to rounding)
    if (result && "used_pct" in result) {
      expect(result.used_pct).toBe(100);
    }
  });

  test("over-budget (tokens exceed hard threshold) → {blocked:'budget'} with used_pct > 100", () => {
    // 1500 tokens / 1000 limit = 150%
    const result = evaluateChatSendGate(BASE_CONFIG, rollup(1_500), NO_QUIET, NOON);
    expect(result?.blocked).toBe("budget");
    if (result && "used_pct" in result) {
      expect(result.used_pct).toBeGreaterThan(100);
    }
  });

  test("quiet hours active → {blocked:'quiet_hours'} regardless of budget stage", () => {
    // Use a date that is inside the 23:00–08:00 quiet window.
    const quietNow = dateAtLocalHour(1); // 01:00 → inside 23:00–08:00
    // Tokens are well below soft (ok stage) — budget does NOT block.
    const result = evaluateChatSendGate(BASE_CONFIG, rollup(100), QUIET_WRAP, quietNow);
    expect(result?.blocked).toBe("quiet_hours");
  });

  test("quiet hours active + hard budget → quiet_hours wins (same ordering as server.ts closure)", () => {
    // quiet_hours is checked FIRST (cheaper) — this mirrors the server.ts gate order.
    const quietNow = dateAtLocalHour(1); // 01:00 → inside quiet window
    // Tokens at hard-stop too
    const result = evaluateChatSendGate(BASE_CONFIG, rollup(1_000), QUIET_WRAP, quietNow);
    expect(result?.blocked).toBe("quiet_hours");
  });

  test("outside quiet hours (12:00 is outside 23:00–08:00) + ok budget → null", () => {
    // Not inside quiet window; budget is ok → pass
    const outsideQuiet = dateAtLocalHour(12); // 12:00 → outside 23:00–08:00
    const result = evaluateChatSendGate(BASE_CONFIG, rollup(100), QUIET_WRAP, outsideQuiet);
    expect(result).toBeNull();
  });

  test("no quiet hours configured (start/end both null) → isQuietHour never blocks", () => {
    // Both start and end null → quiet hours disabled → never blocks
    const anyTime = dateAtLocalHour(2); // 02:00 would be quiet if QUIET_WRAP were used
    const result = evaluateChatSendGate(BASE_CONFIG, rollup(100), NO_QUIET, anyTime);
    expect(result).toBeNull();
  });

  test("zero token limit config → evaluateBudget returns ok (limit 0 = unlimited) → null", () => {
    // The evaluateBudget implementation treats limit 0 as 'unlimited' (ok, 0%)
    const unlimitedConfig: BudgetConfig = { ...BASE_CONFIG, dailyTokenLimit: 0 };
    const result = evaluateChatSendGate(unlimitedConfig, rollup(999_999), NO_QUIET, NOON);
    expect(result).toBeNull();
  });
});
