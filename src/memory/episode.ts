// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
// Copyright (c) 2026 Jiaqi Duan
/**
 * Episode synthesis — Episode schema + pure collection
 * operations. $0, no IO, no LLM, no `Date.now()` (callers inject `now`).
 *
 * Episodes are a NEW collection (`episodes[]`) that clusters the
 * `event_fragments[]` captured by the fragment-capture path into day-bucketed narratives. They live
 * in their own collection — never a Fact/fragment discriminator — so the
 * fact-recall and event-fragment-recall paths stay untouched (mirrors the
 * event_fragments-vs-facts separation rationale in event-fragment.ts).
 *
 * Leaf-module discipline: this module imports `memory.ts` ONLY as a type
 * (erased at runtime), exactly like `event-fragment.ts`. `memory.ts`
 * runtime-imports `episodeSchema` here (to build `coreMemorySchema`), so a
 * runtime back-edge from here into `memory.ts` would form a cycle. That is
 * why `episodeId` is inlined rather than importing `newId` from `memory.ts`
 * — same `${prefix}-${hex}` scheme (prefix "ep"), no runtime edge.
 */
import { randomBytes } from "node:crypto";
import { z } from "zod";
import type { EventFragment } from "./event-fragment";
import type { CoreMemory } from "./memory";

/** 12x the 30d fragment TTL (event-fragment.ts EVENT_TTL_DAYS) — the narrative
 * is the durable artifact; member fragments may expire but stay in store
 * (lineage), so `member_fragment_ids` keep resolving via `resolveMembers`. */
export const EPISODE_TTL_DAYS = 365;

/** Anti-confab floor: an episode must cite >=2 grounding fragments. A
 * day-bucket with exactly 1 fragment is not "clusterable" — the lone fragment
 * still shows as its own event row, no episode is synthesized for it. */
export const EPISODE_MIN_MEMBERS = 2;

const MS_PER_DAY = 86_400_000;

export const episodeTimeSpanSchema = z.object({
  start: z.string(), // ISO — min member occurred_at
  end: z.string(), // ISO — max member occurred_at
});
export type EpisodeTimeSpan = z.infer<typeof episodeTimeSpanSchema>;

export const episodeSchema = z.object({
  id: z.string(),
  day_key: z.string(), // "YYYY-MM-DD" — the bucket identity, one episode per active day
  member_fragment_ids: z.array(z.string()).min(EPISODE_MIN_MEMBERS), // grounding
  time_span: episodeTimeSpanSchema, // NOT flattened — preserved intentionally
  narrative: z.string().max(280), // LLM-written, 100-250 target
  entity_labels: z.array(z.string()).default([]),
  version: z.number().int().min(1),
  created_at: z.string(),
  updated_at: z.string(),
  expires_at: z.string(), // ISO — created_at + EPISODE_TTL_DAYS
});
export type Episode = z.infer<typeof episodeSchema>;

/**
 * An episode before it is committed to the store: everything a synthesis
 * pass produces for a cluster except the fields `applyEpisodes` assigns
 * (`id`, `version`, `created_at`, `updated_at`, `expires_at`). Mirrors the
 * `EventFragmentDraft` pattern in event-fragment.ts.
 */
export interface EpisodeDraft {
  day_key: string;
  member_fragment_ids: string[];
  time_span: EpisodeTimeSpan;
  narrative: string;
  entity_labels: string[];
}

/** Mirrors `memory.ts` newId("ep"); inlined to keep this a leaf module (see header). */
function episodeId(): string {
  return `ep-${randomBytes(4).toString("hex")}`;
}

/**
 * The clustering boundary: the calendar date of an ISO timestamp, read in
 * the HOST-LOCAL timezone. siltpoke is a local-first pet — the daemon always
 * runs on the user's own machine, so host-local IS the user's timezone, and an
 * episode groups a user's real working day ("what I did on my Tuesday") rather
 * than a UTC day that would split a late-night local session across two
 * buckets. (Tests pin `TZ=UTC` for determinism; production uses the user's TZ.)
 */
export function dayKey(occurredAt: string): string {
  const d = new Date(occurredAt);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

/**
 * Group fragments by `dayKey(occurred_at)`. This is a PURE reshape — it does
 * NOT apply the `EPISODE_MIN_MEMBERS` floor, so singleton-day buckets are
 * still present in the returned map (callers, e.g. `synthesizeEpisodes`,
 * decide what to narrate). The `EPISODE_MIN_MEMBERS` floor is enforced as a
 * hard boundary in `applyEpisodes` below (defense-in-depth: even a buggy
 * upstream draft can never write a <2-member episode to the store).
 */
export function clusterByDay(
  fragments: readonly EventFragment[],
): Map<string, EventFragment[]> {
  const clusters = new Map<string, EventFragment[]>();
  for (const f of fragments) {
    const key = dayKey(f.occurred_at);
    const bucket = clusters.get(key);
    if (bucket) {
      bucket.push(f);
    } else {
      clusters.set(key, [f]);
    }
  }
  return clusters;
}

/** Order-independent set equality for member-id comparison ("member set unchanged"). */
export function sameMemberSet(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false;
  const setA = new Set(a);
  for (const id of b) {
    if (!setA.has(id)) return false;
  }
  return true;
}

/**
 * Merge episode drafts into `memory.episodes`, keyed by `day_key`:
 *   - new `day_key` -> create (version 1, id/created_at/updated_at assigned,
 *     `expires_at` = created_at + EPISODE_TTL_DAYS).
 *   - existing `day_key`, SAME member set -> unchanged (no version bump, no
 *     `updated_at` change — idempotent, no-op re-apply).
 *   - existing `day_key`, CHANGED member set -> update members + time_span +
 *     narrative + entity_labels, `version++`, `updated_at` = now.
 * A prior episode is NEVER deleted — only created or updated in place.
 * A draft with fewer than `EPISODE_MIN_MEMBERS` members is silently dropped
 * (never stored; mirrors the dedup-skip pattern in `applyEventFragments`).
 * Pure/immutable: `memory` is never mutated; a NEW CoreMemory (and new
 * `episodes` array) is returned.
 */
export function applyEpisodes(
  memory: CoreMemory,
  drafts: readonly EpisodeDraft[],
  now: Date,
): CoreMemory {
  const nowIso = now.toISOString();
  const episodes = [...(memory.episodes ?? [])];
  const indexByDayKey = new Map(episodes.map((e, i) => [e.day_key, i]));

  for (const d of drafts) {
    if (d.member_fragment_ids.length < EPISODE_MIN_MEMBERS) continue;

    const idx = indexByDayKey.get(d.day_key);
    if (idx === undefined) {
      const created: Episode = {
        id: episodeId(),
        day_key: d.day_key,
        member_fragment_ids: [...d.member_fragment_ids],
        time_span: { ...d.time_span },
        narrative: d.narrative,
        entity_labels: [...d.entity_labels],
        version: 1,
        created_at: nowIso,
        updated_at: nowIso,
        expires_at: new Date(now.getTime() + EPISODE_TTL_DAYS * MS_PER_DAY).toISOString(),
      };
      episodes.push(created);
      indexByDayKey.set(d.day_key, episodes.length - 1);
      continue;
    }

    const existing = episodes[idx]!;
    if (sameMemberSet(existing.member_fragment_ids, d.member_fragment_ids)) {
      continue; // idempotent: no version bump, no updated_at change
    }

    episodes[idx] = {
      ...existing,
      member_fragment_ids: [...d.member_fragment_ids],
      time_span: { ...d.time_span },
      narrative: d.narrative,
      entity_labels: [...d.entity_labels],
      version: existing.version + 1,
      updated_at: nowIso,
    };
  }

  return { ...memory, episodes };
}

/**
 * Read-time expiry filter: the episodes whose `expires_at` is still in the
 * future (> `now`). Expired episodes are NOT deleted from the store — they
 * stay as historical material. Mirrors `activeEventFragments`'s `<= now` cutoff
 * (active = the complement) and `decay.isExpired`.
 */
export function activeEpisodes(memory: CoreMemory, now: Date): Episode[] {
  return (memory.episodes ?? []).filter(
    (e) => new Date(e.expires_at).getTime() > now.getTime(),
  );
}

/**
 * Resolve an episode's `member_fragment_ids` against `memory.event_fragments`.
 * Resolves against the FULL store (not `activeEventFragments`) because expired
 * fragments are kept for lineage and must still resolve. A missing or
 * already-pruned member id is silently skipped — never throws (mirrors the
 * never-throws posture of the rest of the episodic pipeline).
 */
export function resolveMembers(memory: CoreMemory, episode: Episode): EventFragment[] {
  const byId = new Map((memory.event_fragments ?? []).map((f) => [f.id, f]));
  const resolved: EventFragment[] = [];
  for (const id of episode.member_fragment_ids) {
    const f = byId.get(id);
    if (f) resolved.push(f);
  }
  return resolved;
}
