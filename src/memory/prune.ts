// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
// Copyright (c) 2026 Jiaqi Duan
/**
 * Pruning helpers for stale pending facts.
 *
 * PQ6 — active-fact pruning superseded by the decay sweep (decay.ts handles
 *        stale active facts via proposeDecayedFacts → retire_proposed flow).
 * PQ7 — inbox state machine (pending + >30d → retired as implicit rejection)
 *        This module owns ONLY PQ7 pending-expiry.
 *
 * PruneResult.factsPruned is retained for consolidate back-compat; always 0.
 *
 * Pure functions — no IO, no Date.now(). Pass `now: Date` for testability.
 * Never mutates input memory; always returns a new CoreMemory object.
 */

import type { CoreMemory } from "./memory";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type PruneResult = {
  factsPruned: number;
  pendingPruned: number;
};

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;

// ---------------------------------------------------------------------------
// Main function
// ---------------------------------------------------------------------------

export function pruneStaleFacts(
  memory: CoreMemory,
  now: Date,
): { memory: CoreMemory; result: PruneResult } {
  const nowMs = now.getTime();
  const result: PruneResult = {
    factsPruned: 0,
    pendingPruned: 0,
  };

  const facts = memory.facts.map((fact) => {
    if (fact.status === "pending") {
      const ageMs = nowMs - new Date(fact.created_at).getTime();
      if (ageMs > THIRTY_DAYS_MS) {
        result.pendingPruned++;
        return {
          ...fact,
          status: "retired" as const,
          retired_reason: "pending_too_long" as const,
        };
      }
      return fact;
    }
    // active facts → handled by proposeDecayedFacts (decay.ts); retired/
    // retire_proposed untouched here.
    return fact;
  });

  return {
    memory: { ...memory, facts },
    result,
  };
}
