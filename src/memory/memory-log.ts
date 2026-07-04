// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
// Copyright (c) 2026 Jiaqi Duan
/**
 * Memory Book — pure normalizer that merges siltpoke's 3 durable memory
 * stores into one timestamp-sorted event stream.
 *
 * Entirely pure: no I/O, no Date.now(), deterministic from input.
 */

import type { EntityRef } from "./entity";
import type { Episode } from "./episode";
import type { EventFragment } from "./event-fragment";
import type { Fact, FactEvent } from "./memory";
import { isRubricNoiseCritique } from "./rubric-noise";

export type MemoryEventType = "semantic" | "episodic" | "procedural";
export type MemoryEventStatus = "active" | "pending" | "retired";

export interface MemoryEvent {
  ts: string;           // ISO; sort key
  type: MemoryEventType;
  text: string;
  why: string | null;   // save_reason | reaction | rule-source
  status: MemoryEventStatus;
  id: string;
  /**
   * Number of times this fact was reaffirmed (reused via Fact.recall_count).
   * Drives the "★ 重申 ×N" badge in the Memory Book. Only facts carry it;
   * episodic/procedural events are always 0.
   */
  recall_count: number;
  /**
   * ISO timestamp of the most recent reaffirmation (Fact.last_confirmed_at).
   * Drives the date suffix on the "★ 重申 ×N" badge. Only facts carry it;
   * episodic/procedural events are always null.
   */
  last_confirmed_at: string | null;
  /**
   * Per-fact append-only action log. Passed through to the client
   * island so the action-log footer (MemoryActionLog) can render without a
   * second network call. Non-fact rows (episodic/procedural) carry [].
   */
  events: FactEvent[];
  /**
   * Supersede pointer — id of the fact this one replaced (Fact.supersedes).
   * null for non-semantic rows or when not a replacement.
   */
  supersedes: string | null;
  /**
   * Supersede pointer — id of the fact that replaced this one
   * (Fact.superseded_by). null for non-semantic rows or when not superseded.
   */
  superseded_by: string | null;
  /**
   * Provenance stream that produced this fact (Fact.learned_from.stream).
   * "user" = hand-typed, "commit" = auto-learned from git commits,
   * "chat" / "critique" / "dismissal" / "remember" = other capture paths.
   * null for non-semantic rows (episodic/procedural) and for seed/legacy facts
   * that predate provenance tracking. Optional so legacy test fixtures that
   * predate this field keep compiling without modification.
   */
  stream?: string | null;
  /**
   * Communication-style vs personal-profile classification (Fact.kind) — drives
   * the 🎯 style / 💬 profile / ❓ untagged badge + the click-to-re-tag affordance
   * on /memory. "style" facts shape code critiques; "profile" stay chat-only.
   * null/undefined = untagged. Non-fact rows (episodic/procedural) carry undefined.
   * Optional so legacy fixtures keep compiling.
   */
  kind?: "style" | "profile" | null;
  /**
   * Named entities this fact is about (Fact.entities) — drives the
   * /memory "by entity" view via groupByEntity (src/memory/entity.ts).
   * null/undefined for non-fact rows (episodic/procedural) and untagged facts.
   */
  entities?: EntityRef[] | null;
}

export interface MemoryLogInput {
  facts: Fact[];
  critiques: Array<{ id: string; ts: string; body: string; reaction?: string | null }>;
  learnedRules: Array<{ id: string; created_at: string; text: string; source?: string | null }>;
  /**
   * Event fragments (the EPISODIC "what happened" layer) surfaced ALONGSIDE
   * critiques under `type:"episodic"`. Optional so legacy callers/tests that
   * predate this field keep compiling (treated as [] when omitted). Callers pass
   * the read-time-filtered (non-expired) set via activeEventFragments().
   */
  eventFragments?: EventFragment[];
  /**
   * Synthesized episodes (day-bucketed narratives over event fragments, see
   * episode.ts) surfaced ALONGSIDE event fragments + critiques under
   * `type:"episodic"`. Optional so legacy callers/tests that predate this
   * field keep compiling (treated as [] when omitted). Callers pass the
   * read-time-filtered (non-expired) set via activeEpisodes().
   */
  episodes?: Episode[];
}

/**
 * Short human-readable source summary for an event fragment → the row's `why`
 * ("为什么" line). Each source is `<kind> <ref>` (ref truncated to 8 chars, the
 * length of a short commit sha). Returns null when there are no sources (the
 * schema requires ≥1, so this is defensive only).
 */
function eventFragmentWhy(fragment: EventFragment): string | null {
  if (fragment.sources.length === 0) return null;
  const parts = fragment.sources.map((s) => {
    const ref = s.ref.length > 8 ? s.ref.slice(0, 8) : s.ref;
    return `${s.kind} ${ref}`;
  });
  return `from ${parts.join(", ")}`;
}

/**
 * Short human-readable label for a synthesized episode → the row's `why`
 * ("为什么" line). Distinguishes an episode-narrative row (this cluster is a
 * SYNTHESIS over N event fragments, not a single event) from an individual
 * event-fragment row's `eventFragmentWhy` source citation. Format:
 * "episode · 3 events on 2026-07-01".
 */
function episodeWhy(episode: Episode): string {
  const n = episode.member_fragment_ids.length;
  return `episode · ${n} events on ${episode.day_key}`;
}

function factStatus(status: Fact["status"]): MemoryEventStatus {
  if (status === "active") return "active";
  if (status === "pending") return "pending";
  // "retired" | "retire_proposed" → retired
  return "retired";
}

export function buildMemoryLog(input: MemoryLogInput): MemoryEvent[] {
  const semanticEvents: MemoryEvent[] = input.facts.map((f) => ({
    ts: f.created_at,
    type: "semantic",
    text: f.text,
    why: f.save_reason,
    status: factStatus(f.status),
    id: f.id,
    recall_count: f.recall_count,
    last_confirmed_at: f.last_confirmed_at,
    events: f.events,
    supersedes: f.supersedes,
    superseded_by: f.superseded_by,
    stream: f.learned_from?.stream ?? null,
    kind: f.kind ?? null,
    entities: f.entities ?? null,
  }));

  const episodicEvents: MemoryEvent[] = input.critiques
    .filter((c) => !isRubricNoiseCritique(c.body))
    .map((c) => ({
      ts: c.ts,
      type: "episodic",
      text: c.body,
      why: c.reaction ?? null,
      status: "active" as MemoryEventStatus,
      id: c.id,
      recall_count: 0,
      last_confirmed_at: null,
      events: [] as FactEvent[],
      supersedes: null,
      superseded_by: null,
      stream: null,
    }));

  // Event fragments as additional episodic rows (coexist with critiques).
  // ts = occurred_at (the event's real occurrence time — temporal provenance,
  // NOT created_at/record time). stream + entities carried so the /memory island
  // renders the provenance badge + by-entity grouping.
  const eventFragmentEvents: MemoryEvent[] = (input.eventFragments ?? []).map((f) => ({
    ts: f.occurred_at,
    type: "episodic",
    text: f.text,
    why: eventFragmentWhy(f),
    status: "active" as MemoryEventStatus,
    id: f.id,
    recall_count: 0,
    last_confirmed_at: null,
    events: [] as FactEvent[],
    supersedes: null,
    superseded_by: null,
    stream: f.learned_from_stream,
    entities: f.entities,
  }));

  // Synthesized episodes as additional episodic rows (coexist with event
  // fragments + critiques). ts = time_span.end (the newest member's occurrence
  // time — newest-first sort parity with the individual fragment rows it
  // summarizes), NOT created_at/updated_at (record time). entity_labels
  // (string[]) mapped to EntityRef[] shape so the /memory island's by-entity
  // grouping (groupByEntity, entity.ts) can pick episodes up the same way it
  // does fact/event-fragment rows.
  const episodeEvents: MemoryEvent[] = (input.episodes ?? []).map((ep) => ({
    ts: ep.time_span.end,
    type: "episodic",
    text: ep.narrative,
    why: episodeWhy(ep),
    status: "active" as MemoryEventStatus,
    id: ep.id,
    recall_count: 0,
    last_confirmed_at: null,
    events: [] as FactEvent[],
    supersedes: null,
    superseded_by: null,
    stream: null,
    entities: ep.entity_labels.map((name) => ({ name })),
  }));

  const proceduralEvents: MemoryEvent[] = input.learnedRules.map((r) => ({
    ts: r.created_at,
    type: "procedural",
    text: r.text,
    why: r.source ?? null,
    status: "active" as MemoryEventStatus,
    id: r.id,
    recall_count: 0,
    last_confirmed_at: null,
    events: [] as FactEvent[],
    supersedes: null,
    superseded_by: null,
    stream: null,
  }));

  const all = [
    ...semanticEvents,
    ...episodicEvents,
    ...eventFragmentEvents,
    ...episodeEvents,
    ...proceduralEvents,
  ];
  // Sort newest-first; ISO strings compare lexicographically.
  all.sort((a, b) => (a.ts > b.ts ? -1 : a.ts < b.ts ? 1 : 0));
  return all;
}
