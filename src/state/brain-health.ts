// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
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
 *   - permanent: latched until /siltpoke-wake or a passing doctor re-verify
 *   - throttle:  no breaker (handled by the 1-retry policy)
 *   - any success → full reset (counters + breaker), last_failure RETAINED
 *     so doctor keeps showing the last-failure record.
 */
import { readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { atomicWrite } from "../utils/atomic-write";
import type { FailureClass } from "../brain/failure-classify";

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
}

const FILE = "brain-health.json";
export const OUTER_RETRY_DAILY_CAP = 5;
const SIGNAL_AGE_OUT_MS = 24 * 60 * 60 * 1000;
const MIN = 60_000;

function dayOf(now: Date): string {
  return now.toISOString().slice(0, 10);
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
  };
}

// ── IO (single writer; corrupt-tolerant reader) ──────────────────────────────

/** True when the value is a string parsing to a finite epoch ms. */
function isValidDateString(value: unknown): boolean {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
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
  // pre-check) — permanent clears ONLY via /siltpoke-wake or doctor re-verify.
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
      reason: `permanent failure latched since ${b.opened_at} — clear via /siltpoke-wake or a passing doctor re-verify`,
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

export function canOuterRetry(health: BrainHealth, now: Date): boolean {
  const today = dayOf(now);
  const used =
    health.retry_budget.date === today ? health.retry_budget.outer_retries_used : 0;
  return used < OUTER_RETRY_DAILY_CAP;
}

export function consumeOuterRetry(health: BrainHealth, now: Date): BrainHealth {
  const today = dayOf(now);
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
  const fresh = readBrainHealth(basePath);
  if (!canOuterRetry(fresh, now)) return false;
  writeBrainHealth(basePath, consumeOuterRetry(fresh, now));
  return true;
}

// ── Surfacing predicate (card ⚠ line + dashboard strip) ──────────────────────

export interface UnhealthySignal {
  show: boolean;
  /** One-liner for the card / strip, "" when show=false. */
  line: string;
}

/**
 * Shared predicate for the state-card ⚠ line and the dashboard health strip:
 * surface when consecutive_failures ≥ 2 OR the failing class is permanent
 * (which surfaces at the FIRST failure). 24h age-out; clears automatically
 * when a success resets consecutive_failures to 0.
 */
export function brainUnhealthySignal(
  health: BrainHealth,
  now: Date,
): UnhealthySignal {
  const f = health.last_failure;
  if (f === null || health.consecutive_failures < 1) return { show: false, line: "" };
  const escalated =
    health.consecutive_failures >= 2 || f.class === "permanent";
  if (!escalated) return { show: false, line: "" };
  const ageMs = now.getTime() - Date.parse(f.ts);
  if (!Number.isFinite(ageMs) || ageMs > SIGNAL_AGE_OUT_MS) {
    return { show: false, line: "" };
  }
  const reason = f.stderr_excerpt.trim().length > 0
    ? f.stderr_excerpt.trim().slice(0, 80)
    : `exit ${f.exit_code ?? "?"}, no stderr`;
  return {
    show: true,
    line: `⚠ brain: ${f.class} ×${health.consecutive_failures} — ${reason}`,
  };
}
