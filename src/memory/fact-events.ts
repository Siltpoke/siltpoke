// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Copyright (c) 2026 Jiaqi Duan
// SYNC: keep semantically in step with
// src/web/client/islands/memory-book-helpers.ts#synthesizeClientEvents
// + #deriveClientSummary — the two functions below are intentionally duplicated
// on the client (server module can't be bundled there). Any logic change here
// MUST be mirrored in the client equivalents, and vice versa.
// Parity is mechanically verified by tests/memory/action-log-parity.test.ts.

import type { Fact, FactEvent } from "./memory";

export type FactSummary = {
  createdAt: string;
  reaffirmCount: number;
  lastReaffirmAt: string | null;
  retiredAt: string | null;
  /** Most-recent event that is not "created" and not "reaffirmed", or null. */
  latestStateChange: { action: string; at: string } | null;
};

export function synthesizeLegacy(fact: Fact): FactEvent[] {
  // Start with stored events or synthesize from legacy fields.
  let evs: FactEvent[];
  if (fact.events.length > 0) {
    evs = fact.events;
  } else {
    evs = [{ action: "created", at: fact.created_at, reason: null }];
    if (fact.status === "active") {
      evs.push({
        action: "approved",
        at: fact.last_confirmed_at ?? fact.created_at,
        reason: null,
      });
    }
  }
  // M1: if the fact is retired/retire_proposed but has no logged retired event,
  // append a synthetic retired event at read-time (never written; reversible).
  if (
    (fact.status === "retired" || fact.status === "retire_proposed") &&
    !evs.some((e) => e.action === "retired")
  ) {
    const retiredAt = fact.invalid_at ?? fact.last_seen_at ?? fact.created_at;
    return [
      ...evs,
      { action: "retired", at: retiredAt, reason: fact.retired_reason ?? null },
    ];
  }
  return evs;
}

export function deriveSummary(fact: Fact): FactSummary {
  const evs = synthesizeLegacy(fact);
  const reaffirms = evs.filter((e) => e.action === "reaffirmed");
  const retired = evs.findLast((e) => e.action === "retired");
  const lastStateEv =
    evs.findLast((e) => e.action !== "created" && e.action !== "reaffirmed") ??
    null;
  return {
    createdAt: fact.created_at,
    // M2: take the max of counted reaffirm events and the stored recall_count so a
    // legacy fact with recall_count > 0 but empty events[] shows the right badge.
    reaffirmCount: Math.max(reaffirms.length, fact.recall_count ?? 0),
    lastReaffirmAt: reaffirms.at(-1)?.at ?? null,
    retiredAt: retired?.at ?? null,
    latestStateChange: lastStateEv
      ? { action: lastStateEv.action, at: lastStateEv.at }
      : null,
  };
}
