// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
// Copyright (c) 2026 Jiaqi Duan
/**
 * Episodic-fragment capture — EventFragment schema + pure collection
 * operations. $0 LLM, no IO, no Date.now() (callers inject `now`).
 *
 * Event fragments are the EPISODIC layer (what happened) kept DISTINCT from the
 * semantic `facts[]` layer (who the user is). They live in their
 * own `event_fragments[]` collection so fact-recall paths never read them.
 *
 * Leaf-module discipline: this module imports `memory.ts` ONLY as a type
 * (erased at runtime), exactly like `entity.ts` / `decay.ts`. `memory.ts`
 * runtime-imports `eventFragmentSchema` here (to build `coreMemorySchema`), so a
 * runtime back-edge from here into `memory.ts` would form a cycle that trips a
 * temporal-dead-zone error whenever this module is imported first (e.g. in unit
 * tests). That is why `eventId` is inlined rather than importing `newId` from
 * `memory.ts` — same `${prefix}-${hex}` scheme (prefix "ev"), no runtime edge.
 */
import { randomBytes } from "node:crypto";
import { z } from "zod";
import { entityRefSchema } from "./entity";
import type { CoreMemory } from "./memory";

/** Faster than facts' 60d staleness — episodic material ages out sooner. */
export const EVENT_TTL_DAYS = 30;

const MS_PER_DAY = 86_400_000;

export const eventSourceSchema = z.object({
  kind: z.enum(["commit", "critique", "session", "chat"]),
  ref: z.string(), // commit sha / critique id / session id
});
export type EventSource = z.infer<typeof eventSourceSchema>;

export const eventFragmentSchema = z.object({
  id: z.string(),
  text: z.string().max(280), // short event narrative, third-person
  created_at: z.string(), // ISO — when recorded (consolidate run time)
  occurred_at: z.string(), // ISO — when the event happened (temporal provenance)
  expires_at: z.string(), // ISO — created_at + EVENT_TTL_DAYS
  sources: z.array(eventSourceSchema).min(1), // grounding — ≥1 source
  entities: z.array(entityRefSchema).default([]),
  confidence: z.number().min(0).max(1).default(0.7),
  learned_from_stream: z.enum(["commit", "critique", "chat"]),
});
export type EventFragment = z.infer<typeof eventFragmentSchema>;

/**
 * A fragment before it is committed to the store: everything except the fields
 * `applyEventFragments` assigns (`id`, `created_at`, `expires_at`). Mirrors the
 * `FactDraft` pattern in `transitions.ts`.
 */
export type EventFragmentDraft = Omit<
  EventFragment,
  "id" | "created_at" | "expires_at"
>;

/** Mirrors `memory.ts` newId("ev"); inlined to keep this a leaf module (see header). */
function eventId(): string {
  return `ev-${randomBytes(4).toString("hex")}`;
}

/** Grouping/dedup key: trim + lowercase + collapse whitespace (mirrors entityKey / memory.normalize). */
function normalizeText(text: string): string {
  return text.trim().toLowerCase().replace(/\s+/g, " ");
}

/**
 * Append `incoming` fragment drafts to `memory.event_fragments`, assigning each
 * an `id` + `created_at` (= `now`) + `expires_at` (= `now` + EVENT_TTL_DAYS).
 *
 * Dedup by normalized text (trim + lowercase + collapse whitespace) against both
 * the existing store AND earlier drafts in the same batch — a fragment whose
 * normalized text already exists is skipped (event fragments carry no
 * recall_count to reaffirm, unlike facts). Pure/immutable: `memory` is never
 * mutated; a NEW CoreMemory (and new `event_fragments` array) is returned.
 */
export function applyEventFragments(
  memory: CoreMemory,
  incoming: readonly EventFragmentDraft[],
  now: Date,
): CoreMemory {
  const createdAt = now.toISOString();
  const expiresAt = new Date(now.getTime() + EVENT_TTL_DAYS * MS_PER_DAY).toISOString();
  const seen = new Set(memory.event_fragments.map((f) => normalizeText(f.text)));

  const additions: EventFragment[] = [];
  for (const d of incoming) {
    const key = normalizeText(d.text);
    if (seen.has(key)) continue;
    seen.add(key);
    additions.push({ ...d, id: eventId(), created_at: createdAt, expires_at: expiresAt });
  }

  return { ...memory, event_fragments: [...memory.event_fragments, ...additions] };
}

/**
 * Code-side source-ref grounding (the untrusted-LLM fix). The extractor's
 * `sources[].ref` values are LLM-generated: commit shas are real (the `%H` sha is
 * rendered in the prompt) but critique/chat refs are FABRICATED (those signals
 * reach the extractor id-less today). Per the project's "LLM output as
 * untrusted input" rule, keep only drafts anchored to a VERIFIABLE real id.
 *
 * `knownRefs` = the set of verifiable ids the caller can vouch for (currently: the
 * commit shas from the run's coding activity — the only reliably-citable real id
 * in this context). A source counts as VERIFIED only when BOTH hold:
 *   - `s.kind === "commit"` (currently the only grounded kind), AND
 *   - `knownRefs.has(s.ref)`.
 * The `kind` check matters: `knownRefs` holds commit shas, so an LLM emitting
 * `{ kind: "critique", ref: <a-real-commit-sha> }` would otherwise pass on the
 * ref alone and be stored with WRONG provenance (labelled critique, actually a
 * commit). Requiring the kind to match keeps the stored provenance honest.
 * For each draft:
 *   - drop individual `sources` entries that are not verified (never store a
 *     fabricated ref, nor a real ref under a mislabelled kind);
 *   - keep the draft ONLY if ≥1 source survives (every stored fragment has
 *     ≥1 verifiable real source). A draft left with 0 verified sources is dropped.
 *
 * Current effect: commit-grounded coding events survive; critique/chat drafts
 * (unverifiable refs) are dropped — broadening the verified-source domain beyond
 * commit-only (see extract-events.ts header caveat) is future work.
 * Pure/immutable: inputs are never mutated; returns a NEW
 * array of NEW drafts. Does NOT silently swallow — the caller logs the
 * dropped-unverifiable count (mirrors the summarizer drop-logging convention).
 */
export function groundEventDrafts(
  drafts: readonly EventFragmentDraft[],
  knownRefs: ReadonlySet<string>,
): EventFragmentDraft[] {
  // Currently commit is the only grounded kind. This predicate could broaden
  // (e.g. accept kind:"critique"/"session" against their own known-id sets).
  const isVerified = (s: EventSource): boolean =>
    s.kind === "commit" && knownRefs.has(s.ref);

  const grounded: EventFragmentDraft[] = [];
  for (const d of drafts) {
    const verifiedSources = d.sources.filter(isVerified);
    if (verifiedSources.length === 0) continue;
    grounded.push({ ...d, sources: verifiedSources });
  }
  return grounded;
}

/**
 * Read-time expiry filter: the fragments whose `expires_at` is still
 * in the future (> `now`). Expired fragments are NOT deleted from the store —
 * they stay as raw material for future episode-synthesis lineage (spec OQ3).
 * Mirrors `decay.isExpired`'s `<= now` cutoff (active = the complement).
 */
export function activeEventFragments(memory: CoreMemory, now: Date): EventFragment[] {
  return memory.event_fragments.filter(
    (f) => new Date(f.expires_at).getTime() > now.getTime(),
  );
}
