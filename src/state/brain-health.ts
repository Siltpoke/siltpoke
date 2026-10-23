// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
// Copyright (c) 2026 Jiaqi Duan
/**
 * Brain health record — single writer, three readers (doctor 8th check,
 * state-card ⚠ line, daemon health endpoint → dashboard strip).
 *
 * File: `<basePath>/brain-health.json`
 * (basePath = ~/.siltpoke, same convention as vitals).
 *
 * Contingency: missing/corrupt file at read time = fresh
 * closed-breaker state, overwritten atomically on next write; never crash
 * the hook. Write failures are swallowed (never block the critic).
 *
 * Breaker windows:
 *   - resource:  failure #1 → 15min, #2+ consecutive → 60min
 *   - ambiguous: opens after 3 consecutive — 5 → 15 → 60min
 *   - permanent: latched until /siltpoke:siltpoke-wake or a passing doctor re-verify
 *   - throttle:  no breaker (handled by the 1-retry policy)
 *   - any success → full reset (counters + breaker), last_failure RETAINED
 *     so doctor keeps showing the last-failure record.
 */
import { readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { FailureClass } from "../brain/failure-classify";
import { atomicWrite } from "../utils/atomic-write";
import { DEFAULT_QUOTA_DAILY_CAP, loadQuotaDailyCapSync } from "../config/brain-quota-cap-config";
import { loadBudgetConfigSync } from "./budget-config";
import { dayKey } from "./usage";

export interface BrainFailureRecord {
  class: FailureClass;
  exit_code: number | null;
  stderr_excerpt: string;
  ts: string;
  /** Total attempts made for the failing call (1, or 2 after a throttle retry). */
  attempts?: number;
}

export interface BrainBreaker {
  class: FailureClass;
  opened_at: string;
  /** Ignored for `permanent` (latched — open regardless of time). */
  next_eligible_at: string;
}

export interface BrainHealth {
  schema_version: 1;
  last_attempt_ts: string | null;
  last_success_ts: string | null;
  consecutive_failures: number;
  last_failure: BrainFailureRecord | null;
  breaker: BrainBreaker | null;
  /** Daily outer-retry budget (SRE retry-budget analog). Cap: 5/day. */
  retry_budget: { date: string; outer_retries_used: number };
  /**
   * Daily brain-call count for quota-billed providers, KEYED BY PROVIDER
   * NAME (e.g. "codex", "agy") — the runaway brake the token budget gate
   * can't see (a quota provider's zero-usage failures are invisible to
   * `evaluateBudget`'s token sums). Cap: 50/day PER PROVIDER — codex
   * (ChatGPT quota) and agy (Google Code Assist quota) are distinct quota
   * families and must never share a pool; exhausting one must not gate the
   * other. USD providers (claude) never touch this counter. Missing key =
   * that provider has made 0 calls today.
   */
  quota_calls_today: Record<string, { date: string; count: number }>;
}

const FILE = "brain-health.json";
export const OUTER_RETRY_DAILY_CAP = 5;
const MIN = 60_000;

/**
 * The day a cap is keyed on. This was `now.toISOString().slice(0, 10)` — a UTC
 * day — while the token budget keyed on a LOCAL day shifted by `budget.resetAt`
 * (usage.ts `dayKey`). Both were called "per day"; in US Pacific the call cap
 * rolled over mid-afternoon, and editing `resetAt` moved only the other one
 * (spec brain-select-four-gaps §3.4). Now there is one boundary.
 *
 * Callers pass `resetAtMinutes` explicitly; the `try*` wrappers read it from
 * the same config.json the budget does. Default 0 = plain local midnight, used
 * by the pure transitions when no config is in hand.
 */
function dayOf(now: Date, resetAtMinutes = 0): string {
  return dayKey(now, resetAtMinutes);
}

export function freshBrainHealth(): BrainHealth {
  return {
    schema_version: 1,
    last_attempt_ts: null,
    last_success_ts: null,
    consecutive_failures: 0,
    last_failure: null,
    breaker: null,
    retry_budget: { date: "", outer_retries_used: 0 },
    quota_calls_today: {},
  };
}

// ── IO (single writer; corrupt-tolerant reader) ──────────────────────────────

/** True when the value is a string parsing to a finite epoch ms. */
function isValidDateString(value: unknown): boolean {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}

/**
 * Tolerant reader for `quota_calls_today`, migrating the pre-T6 single-scalar
 * shape (`{ date, count }`, one shared pool for ALL quota providers) and any
 * other corrupt value to a fresh empty per-provider map — never crash, never
 * under/over-count. A discarded legacy count is a bounded, safe cost (this
 * counter is a brake, not a ledger; worst case a provider gets one extra
 * day's calls at the OLD shared-cap level before the new per-provider caps
 * take over).
 */
function sanitizeQuotaCallsToday(raw: unknown): Record<string, { date: string; count: number }> {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return {};
  const asRecord = raw as Record<string, unknown>;
  // Pre-T6 shape was a single scalar object with top-level `date`/`count`
  // fields (no provider keying) — distinguishable from the new map because
  // its "count" value is a number, not a nested { date, count } object.
  if (typeof asRecord.date === "string" && typeof asRecord.count === "number") {
    return {};
  }
  const result: Record<string, { date: string; count: number }> = {};
  for (const [providerName, entry] of Object.entries(asRecord)) {
    if (
      entry !== null &&
      typeof entry === "object" &&
      typeof (entry as { date?: unknown }).date === "string" &&
      typeof (entry as { count?: unknown }).count === "number" &&
      Number.isFinite((entry as { count: number }).count)
    ) {
      result[providerName] = {
        date: (entry as { date: string }).date,
        // Same corrupt-tolerance discipline as retry_budget — a
        // negative/float count must never under-count toward the cap.
        count: Math.max(0, Math.floor((entry as { count: number }).count)),
      };
    }
  }
  return result;
}

function parseBrainHealth(raw: string): BrainHealth {
  try {
    const parsed = JSON.parse(raw) as Partial<BrainHealth>;
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      parsed.schema_version !== 1 ||
      typeof parsed.consecutive_failures !== "number"
    ) {
      return freshBrainHealth();
    }
    // Corrupt dates = whole-file-corruption path (contingency: fresh CLOSED
    // state, never a zombie breaker that NaN-compares as silently closed).
    const b = parsed.breaker;
    if (
      b != null &&
      (!isValidDateString(b.opened_at) || !isValidDateString(b.next_eligible_at))
    ) {
      return freshBrainHealth();
    }
    if (parsed.last_failure != null && !isValidDateString(parsed.last_failure.ts)) {
      return freshBrainHealth();
    }
    return {
      ...freshBrainHealth(),
      ...parsed,
      retry_budget:
        typeof parsed.retry_budget?.date === "string" &&
        typeof parsed.retry_budget?.outer_retries_used === "number" &&
        Number.isFinite(parsed.retry_budget.outer_retries_used)
          ? {
              date: parsed.retry_budget.date,
              // Clamp to a non-negative integer — a corrupt negative/float
              // count must not under-count toward the daily cap (review PF2).
              outer_retries_used: Math.max(
                0,
                Math.floor(parsed.retry_budget.outer_retries_used),
              ),
            }
          : { date: "", outer_retries_used: 0 },
      // Tolerant per-provider map read (T6) — migrates the pre-T6
      // single-scalar shape and drops any corrupt entries individually.
      quota_calls_today: sanitizeQuotaCallsToday(parsed.quota_calls_today),
    };
  } catch {
    // Corrupt → fresh closed-breaker state (contingency).
    return freshBrainHealth();
  }
}

export function readBrainHealth(basePath: string): BrainHealth {
  try {
    return parseBrainHealth(readFileSync(join(basePath, FILE), "utf8"));
  } catch {
    // Missing file → fresh closed-breaker state (contingency).
    return freshBrainHealth();
  }
}

/** Async read variant for callers already inside an async parallel block. */
export async function readBrainHealthAsync(
  basePath: string,
): Promise<BrainHealth> {
  try {
    return parseBrainHealth(await readFile(join(basePath, FILE), "utf8"));
  } catch {
    // Missing file → fresh closed-breaker state (contingency).
    return freshBrainHealth();
  }
}

export function writeBrainHealth(basePath: string, health: BrainHealth): void {
  try {
    atomicWrite(join(basePath, FILE), `${JSON.stringify(health, null, 2)}\n`);
  } catch {
    // Write failures must never block the critic.
  }
}

// ── Pure transitions ─────────────────────────────────────────────────────────

function breakerWindowMin(
  cls: FailureClass,
  consecutiveFailures: number,
): number | null {
  if (cls === "resource") return consecutiveFailures >= 2 ? 60 : 15;
  if (cls === "ambiguous") {
    if (consecutiveFailures < 3) return null;
    if (consecutiveFailures === 3) return 5;
    if (consecutiveFailures === 4) return 15;
    return 60;
  }
  // throttle: no breaker; permanent handled separately (latched).
  return null;
}

export function recordFailure(
  health: BrainHealth,
  failure: BrainFailureRecord,
): BrainHealth {
  const consecutive = health.consecutive_failures + 1;

  // A latched permanent breaker survives differently-classed failures (e.g.
  // an ambiguous failure via the /siltpoke-review path, which has no breaker
  // pre-check) — permanent clears ONLY via /siltpoke:siltpoke-wake or doctor re-verify.
  if (health.breaker?.class === "permanent" && failure.class !== "permanent") {
    return {
      ...health,
      last_attempt_ts: failure.ts,
      consecutive_failures: consecutive,
      last_failure: failure,
    };
  }

  let breaker: BrainBreaker | null = null;

  if (failure.class === "permanent") {
    breaker = {
      class: "permanent",
      opened_at: failure.ts,
      next_eligible_at: failure.ts, // ignored — latched
    };
  } else {
    const windowMin = breakerWindowMin(failure.class, consecutive);
    if (windowMin !== null) {
      const openedMs = Date.parse(failure.ts);
      breaker = {
        class: failure.class,
        opened_at: failure.ts,
        next_eligible_at: new Date(openedMs + windowMin * MIN).toISOString(),
      };
    }
  }

  return {
    ...health,
    last_attempt_ts: failure.ts,
    consecutive_failures: consecutive,
    last_failure: failure,
    breaker,
  };
}

/**
 * Clear the breaker ONLY — `consecutive_failures` intentionally survives:
 * clearing (wake / doctor re-verify) means "try now", not "declare healthy";
 * the next failure reopens the breaker at the escalated window.
 */
export function clearBreaker(health: BrainHealth): BrainHealth {
  return { ...health, breaker: null };
}

/** Any success → full reset; last_failure retained for doctor. */
export function recordSuccess(health: BrainHealth, ts: string): BrainHealth {
  return {
    ...health,
    last_attempt_ts: ts,
    last_success_ts: ts,
    consecutive_failures: 0,
    breaker: null,
  };
}

export interface BreakerStatus {
  open: boolean;
  /** Human-readable reason for the open breaker (skip-record telemetry). */
  reason: string | null;
}

export function isBreakerOpen(health: BrainHealth, now: Date): BreakerStatus {
  const b = health.breaker;
  if (b === null) return { open: false, reason: null };
  if (b.class === "permanent") {
    return {
      open: true,
      reason: `permanent failure latched since ${b.opened_at} — clear via /siltpoke:siltpoke-wake or a passing doctor re-verify`,
    };
  }
  if (now.getTime() < Date.parse(b.next_eligible_at)) {
    return {
      open: true,
      reason: `${b.class} breaker open until ${b.next_eligible_at}`,
    };
  }
  return { open: false, reason: null };
}

// ── Daily outer-retry budget (cap 5/day) ─────────────────────────────────────

export function canOuterRetry(
  health: BrainHealth,
  now: Date,
  resetAtMinutes = 0,
): boolean {
  const today = dayOf(now, resetAtMinutes);
  const used =
    health.retry_budget.date === today ? health.retry_budget.outer_retries_used : 0;
  return used < OUTER_RETRY_DAILY_CAP;
}

export function consumeOuterRetry(
  health: BrainHealth,
  now: Date,
  resetAtMinutes = 0,
): BrainHealth {
  const today = dayOf(now, resetAtMinutes);
  const used =
    health.retry_budget.date === today ? health.retry_budget.outer_retries_used : 0;
  return {
    ...health,
    retry_budget: { date: today, outer_retries_used: used + 1 },
  };
}

/**
 * Read-check-consume in one step: re-reads the health file FRESH (never a
 * caller-supplied stale snapshot), aborts (false) if the daily cap is already
 * reached, otherwise persists the consumed slot and returns true.
 * Residual ms-window read→write race is accepted — worst case is one extra
 * outer retry beyond the 5/day cap (bounded cost: a single Brain call).
 */
export function tryConsumeOuterRetry(basePath: string, now: Date): boolean {
  const { resetAtMinutes } = loadBudgetConfigSync(basePath);
  const fresh = readBrainHealth(basePath);
  if (!canOuterRetry(fresh, now, resetAtMinutes)) return false;
  writeBrainHealth(basePath, consumeOuterRetry(fresh, now, resetAtMinutes));
  return true;
}

// ── Daily quota-call cap (brake for quota-billed providers, AC8) ─────────────
// Keyed per-provider-name (T6): codex and agy are independent quota families
// and must never share a pool — exhausting one must not gate the other.
// Since defect [49] a key is a BUCKET, not always a bare provider name: chat
// counts under `chat:<provider>` (the caller builds the key — see
// `quotaBucket` in src/brain/brain-guarded.ts). Nothing here parses a key.

export function canConsumeQuotaCall(
  health: BrainHealth,
  providerName: string,
  now: Date,
  cap: number = DEFAULT_QUOTA_DAILY_CAP,
  resetAtMinutes = 0,
): boolean {
  const today = dayOf(now, resetAtMinutes);
  const entry = health.quota_calls_today[providerName];
  const used = entry?.date === today ? entry.count : 0;
  return cap === 0 || used < cap;
}

/** How many calls `key` has made today — 0 when its entry is from another day. */
export function quotaUsedToday(
  health: BrainHealth,
  key: string,
  now: Date,
  resetAtMinutes = 0,
): number {
  const entry = health.quota_calls_today[key];
  return entry?.date === dayOf(now, resetAtMinutes) ? entry.count : 0;
}

export function consumeQuotaCall(
  health: BrainHealth,
  providerName: string,
  now: Date,
  resetAtMinutes = 0,
): BrainHealth {
  const today = dayOf(now, resetAtMinutes);
  const entry = health.quota_calls_today[providerName];
  const used = entry?.date === today ? entry.count : 0;
  return {
    ...health,
    quota_calls_today: {
      ...health.quota_calls_today,
      [providerName]: { date: today, count: used + 1 },
    },
  };
}

/**
 * Read-check-consume in one step — same fresh-reread-consume-at-decision-time
 * discipline as `tryConsumeOuterRetry`: re-reads the file fresh (never a
 * caller-supplied stale snapshot), aborts (false) if THIS provider's daily
 * cap is already reached, otherwise persists the consumed slot and returns
 * true. Residual ms-window read→write race is accepted (bounded cost: one
 * extra call beyond the cap; this is a brake, not a ledger). Other
 * providers' entries in the map are untouched — independent pools.
 *
 * `cap` defaults to the REVIEW cap whatever the key is. A caller counting in
 * another bucket (`chat:<provider>`) must pass that bucket's cap.
 */
export function tryConsumeQuotaCall(
  basePath: string,
  providerName: string,
  now: Date,
  cap: number = loadQuotaDailyCapSync(basePath),
): boolean {
  const { resetAtMinutes } = loadBudgetConfigSync(basePath);
  const fresh = readBrainHealth(basePath);
  if (!canConsumeQuotaCall(fresh, providerName, now, cap, resetAtMinutes)) return false;
  writeBrainHealth(basePath, consumeQuotaCall(fresh, providerName, now, resetAtMinutes));
  return true;
}

/**
 * Give back one call consumed today — for a call whose process never started
 * (install audit §110 W5, Windows Run 4: reviewer set to codex, codex not
 * installed, `Executable not found`, and `quota_calls_today` still said 1).
 * The cap counts calls made; a spawn that failed before the process existed
 * made none. Never below 0; a slot from a previous day is not touched.
 */
export function refundQuotaCall(basePath: string, key: string, now: Date): void {
  const { resetAtMinutes } = loadBudgetConfigSync(basePath);
  const fresh = readBrainHealth(basePath);
  const today = dayOf(now, resetAtMinutes);
  const entry = fresh.quota_calls_today[key];
  if (entry === undefined || entry.date !== today || entry.count <= 0) return;
  writeBrainHealth(basePath, {
    ...fresh,
    quota_calls_today: { ...fresh.quota_calls_today, [key]: { date: today, count: entry.count - 1 } },
  });
}
