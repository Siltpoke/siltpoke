// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Copyright (c) 2026 Jiaqi Duan
/**
 * Memory Book — shared loader for the SSR route and the API route.
 *
 * Extracts the data-loading logic out of mountMemoryLogRoute so both the
 * daemon API handler and the SSR web route can call a single function.
 *
 * Injectable deps (readMemory / loadCritiques) keep the API route tests green:
 * tests pass their own in-memory stubs via MemoryLogDeps; the production SSR
 * route calls loadMemoryEvents(homeBase) with no overrides (uses real disk
 * readers as defaults).
 */
import { readMemory, type CoreMemory } from "./memory";
import { loadAllCritiqueEntries, type CritiqueLogEntry } from "./consolidate";
import { activeEpisodes } from "./episode";
import { activeEventFragments } from "./event-fragment";
import { buildMemoryLog, type MemoryEvent } from "./memory-log";

export interface LoadMemoryEventsDeps {
  readMemory?: (homeBase: string) => Promise<CoreMemory | null>;
  loadCritiques?: (homeBase: string) => Promise<CritiqueLogEntry[]>;
  /**
   * Injection point for the read-time clock (drives the event-fragment expiry
   * filter). Defaults to `new Date()`; tests pass a fixed Date to assert the
   * active/expired split deterministically.
   */
  now?: Date;
}

/**
 * Load and merge all memory event types (facts + critiques + learned_rules)
 * into a single MemoryEvent[] sorted newest-first.
 *
 * @param homeBase  Path to the siltpoke home directory (e.g. ~/.siltpoke).
 * @param deps      Optional overrides for storage readers (for unit testing).
 */
export async function loadMemoryEvents(
  homeBase: string,
  deps?: LoadMemoryEventsDeps,
): Promise<MemoryEvent[]> {
  const _readMemory = deps?.readMemory ?? readMemory;
  const _loadCritiques = deps?.loadCritiques ?? loadAllCritiqueEntries;
  const now = deps?.now ?? new Date();

  const [memory, critiqueEntries] = await Promise.all([
    _readMemory(homeBase),
    _loadCritiques(homeBase),
  ]);

  const facts = memory?.facts ?? [];

  // Event fragments (episodic "what happened" layer). Only non-expired
  // fragments surface (activeEventFragments applies the read-time TTL filter).
  // Guard on event_fragments presence: legacy/partial memory documents (and
  // older injected mocks) predate the collection and would otherwise crash.
  const eventFragments = memory?.event_fragments ? activeEventFragments(memory, now) : [];

  // Synthesized episodes (day-bucketed narratives, see episode.ts). Only
  // non-expired episodes surface (activeEpisodes applies the read-time TTL
  // filter). Guard on `episodes` presence: legacy/partial memory documents
  // (and older injected mocks) predate the collection and would otherwise crash.
  const episodes = memory?.episodes ? activeEpisodes(memory, now) : [];

  // Map learned_rules fields to the MemoryLogInput shape:
  //   rule    → text
  //   source  → source (real provenance, e.g. the dismiss reason); falls back
  //             to category for legacy rules that predate the source field.
  const learnedRules = (memory?.learned_rules ?? []).map((r) => ({
    id: r.id,
    created_at: r.created_at,
    text: r.rule,
    source: r.source ?? r.category ?? null,
  }));

  // v1: reaction=null — bulk critique↔feedback join non-trivial.
  const critiques = critiqueEntries.map((entry) => ({
    id: entry.id,
    ts: entry.ts,
    body: entry.body,
    reaction: null as string | null,
  }));

  return buildMemoryLog({ facts, critiques, learnedRules, eventFragments, episodes });
}
