// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Copyright (c) 2026 Jiaqi Duan
/**
 * Deterministic semantic-fact decay. $0 LLM, no IO, no Date.now().
 *
 * decayScore = recency × confidence × recallFactor
 *   - recency      = exp(-ageDays / HALF_LIFE_DAYS), ageDays from last_seen_at (≥0)
 *   - confidence   = fact.confidence (0..1)
 *   - recallFactor = 1 + ln(1 + recall_count)   (0 recalls → factor 1, never 0)
 *
 * Below DECAY_THRESHOLD a fact is a candidate for *proposed* retirement
 * (see proposeDecayedFacts). Pinned facts are never scored for retirement.
 */

import type { CoreMemory, Fact } from "./memory";

export const HALF_LIFE_DAYS = 30;
// Propose-cutoff: lower = gentler (high-confidence facts survive longer).
// At half-life 30d: conf-0.95 fact at 90d scores exp(-3)×0.95 ≈ 0.0473 → survives (above 0.03).
// conf-0.5 fact at 90d scores exp(-3)×0.5 ≈ 0.0249 → still proposed (below 0.03).
export const DECAY_THRESHOLD = 0.03;

// A `durable` fact whose last reconfirmation is older than this is flagged
// stale (read-time only; never mutates stored confidence). Default 60d, tune later.
export const STALENESS_DAYS = 60;

const MS_PER_DAY = 86_400_000;

export function decayScore(fact: Fact, now: Date): number {
  const ageMs = now.getTime() - new Date(fact.last_seen_at).getTime();
  const ageDays = Math.max(0, ageMs / MS_PER_DAY);
  const recency = Math.exp(-ageDays / HALF_LIFE_DAYS);
  const recallFactor = 1 + Math.log1p(fact.recall_count);
  return recency * fact.confidence * recallFactor;
}

/**
 * Pin precedence — the single source of truth shared by all three
 * lifecycle mechanisms (decay, expiry, staleness). A `pinned` fact is sacred:
 * never decay-retired, never expired, never flagged stale, regardless of its
 * `stability` or `expires_at`. Mirrors the original decay.ts guard (was an
 * inline `fact.pinned` check) and is now referenced by the sweep AND isStale.
 */
export function isPinExempt(fact: Fact): boolean {
  return fact.pinned;
}

/**
 * Expiry — a `time-bound` fact whose `expires_at` is at/before `now`.
 * A `time-bound` fact with `expires_at: null` has no expiry date → it cannot
 * expire (returns false, never throws). Non-`time-bound` facts never expire.
 */
export function isExpired(fact: Fact, now: Date): boolean {
  if (fact.stability !== "time-bound") return false;
  if (fact.expires_at === null) return false;
  return new Date(fact.expires_at).getTime() <= now.getTime();
}

export type DecayResult = { proposed: number };

/**
 * Deterministic lifecycle sweep. Marks active, non-pinned facts as
 * `retire_proposed` (soft tombstone — kept in store, revivable via
 * keepFactCore, human-confirmed via confirmRetireFactCore) when EITHER:
 *   - the fact is a time-bound fact past its `expires_at` (expiry), OR
 *   - its decay score has fallen below DECAY_THRESHOLD (decay).
 * Pin-exemption is enforced once at the top via isPinExempt, so it
 * covers both the expiry and the decay branch.
 */
export function proposeDecayedFacts(
  memory: CoreMemory,
  now: Date,
): { memory: CoreMemory; result: DecayResult } {
  let proposed = 0;
  const facts = memory.facts.map((fact) => {
    if (fact.status !== "active" || isPinExempt(fact)) return fact;
    // Expiry → soft tombstone (reuse the retire_proposed path, never delete).
    if (isExpired(fact, now)) {
      proposed++;
      return { ...fact, status: "retire_proposed" as const };
    }
    if (decayScore(fact, now) >= DECAY_THRESHOLD) return fact;
    proposed++;
    return { ...fact, status: "retire_proposed" as const };
  });
  return { memory: { ...memory, facts }, result: { proposed } };
}

/**
 * Staleness — read-time predicate. A `durable`, non-pinned fact is
 * stale when its last reconfirmation is older than STALENESS_DAYS. When a fact
 * has never been reconfirmed (`last_confirmed_at: null`) we fall back to its
 * `created_at`. Pure read-time check: NEVER mutates stored `confidence`.
 */
export function isStale(fact: Fact, now: Date): boolean {
  if (fact.stability !== "durable") return false;
  if (isPinExempt(fact)) return false;
  const anchor = fact.last_confirmed_at ?? fact.created_at;
  const ageMs = now.getTime() - new Date(anchor).getTime();
  return ageMs > STALENESS_DAYS * MS_PER_DAY;
}

/**
 * Staleness lister — the read-time surface for "which active facts
 * should be flagged for reconfirmation". Returns the active facts that isStale
 * judges stale, leaving the store (and each fact's confidence) untouched.
 */
export function staleFacts(memory: CoreMemory, now: Date): Fact[] {
  return memory.facts.filter((f) => f.status === "active" && isStale(f, now));
}
