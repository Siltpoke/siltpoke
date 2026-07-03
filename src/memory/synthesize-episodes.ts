// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Copyright (c) 2026 Jiaqi Duan
/**
 * Episode synthesis — isolated Haiku call that narrates a
 * code-formed day-bucket cluster into an episode narrative.
 *
 * Mirrors `extract-events.ts`'s isolation pattern: an injectable brain-call
 * dependency, a NEVER-THROWS contract (a malformed payload or a rejected
 * brain call degrades that ONE cluster to "no draft" — other clusters and the
 * rest of consolidate proceed), and a LENIENT output schema (the
 * seam-bug lesson: real Haiku emits out-of-shape values; a strict schema
 * drops the whole candidate, caught only in live smoke, not unit tests).
 *
 * The LLM's ONLY job is `narrative` + `entity_labels` — cluster
 * membership and `time_span` are ALWAYS code-computed from the fragments
 * already selected by `clusterByDay`, never asked of or trusted from the
 * model (anti-confab). This module also never reads `memory.episodes`
 * into a prompt — synthesis is grounded ONLY in raw `event_fragments`, never
 * re-fed from a prior narrative.
 */
import { z } from "zod";
import { extractJsonString } from "../brain/brain";
import {
  clusterByDay,
  EPISODE_MIN_MEMBERS,
  type EpisodeDraft,
  type EpisodeTimeSpan,
  sameMemberSet,
} from "./episode";
import { activeEventFragments, type EventFragment } from "./event-fragment";
import type { CoreMemory } from "./memory";

const NARRATIVE_MAX = 280;
const DEFAULT_MODEL = "claude-haiku-4-5-20251001";
const DEFAULT_TIMEOUT_MS = 60_000;

const EPISODE_SYSTEM_PROMPT =
  "You are Siltpoke's episode narrator. You are given an already-formed cluster " +
  "of events for a single day — you do NOT choose which events belong together, " +
  "you only write a short cohesive narrative summarizing exactly the events given.";

// ---------------------------------------------------------------------------
// Injectable brain call
// ---------------------------------------------------------------------------

/**
 * The injectable synthesis dependency: prompt in, raw model text out. The
 * ORCHESTRATOR (not this function) owns JSON-parsing + schema validation, so
 * tests can stub this with a bare string (malformed or well-formed) without
 * needing to reach into `../brain/brain`'s richer result shape.
 */
export type SynthesizeFn = (prompt: string) => Promise<string>;

/** Default `SynthesizeFn`: an isolated `claude-haiku-4-5-20251001` call via
 * `callBrainText` (plain-text variant — the narrative is free prose the
 * orchestrator wraps in an expected JSON envelope prompt-side, matching the
 * `callBrainText` module doc's rationale for small-model JSON unreliability
 * on short-prose asks). Lazily imported so unit tests that stub `synthesizeFn`
 * never touch `../brain/brain` (mirrors `extract-events.ts`). */
async function defaultSynthesizeFn(prompt: string): Promise<string> {
  const { callBrainText } = await import("../brain/brain");
  const { text } = await callBrainText({
    systemPrompt: EPISODE_SYSTEM_PROMPT,
    contextBundle: prompt,
    model: DEFAULT_MODEL,
    timeoutMs: DEFAULT_TIMEOUT_MS,
  });
  return text;
}

// ---------------------------------------------------------------------------
// Prompt assembly
// ---------------------------------------------------------------------------

/**
 * Render a code-formed day-bucket cluster into the synthesis prompt. Makes
 * explicit that the model writes ONLY a narrative + optional entity
 * labels — membership and dates are already decided, never asked of it.
 */
export function assembleEpisodePrompt(
  cluster: readonly EventFragment[],
  dayKeyValue: string,
  language: string,
): string {
  const parts: string[] = [];

  parts.push(`EVENTS ON ${dayKeyValue} (${cluster.length} total, already grouped — do not add/remove/reorder):`);
  for (const f of cluster) {
    const entityNames = f.entities.map((e) => e.name).join(", ") || "(none)";
    parts.push(`- ${f.text} [entities: ${entityNames}]`);
  }

  parts.push(
    "",
    `Summarize ONLY these ${cluster.length} events into ONE cohesive narrative of`,
    `100-250 characters, written in ${language}. You are NOT choosing which events`,
    "belong together and you do NOT know or need dates — that is already decided",
    "by the caller. Do not invent events, sources, or details not listed above.",
    "",
    'Emit JSON only: { "narrative": "...", "entity_labels": ["...", ...] }',
    `- narrative: the cohesive story, 100-250 chars (hard cap ${NARRATIVE_MAX}).`,
    "- entity_labels: optional short labels for the entities/themes involved (may be empty).",
  );

  return parts.join("\n");
}

// ---------------------------------------------------------------------------
// Lenient output schema (regression fix: tolerate a "dirty" real payload)
// ---------------------------------------------------------------------------

/**
 * Deliberately LENIENT (the seam-bug lesson): a strict schema
 * that rejects the whole object on one bad field would drop a perfectly
 * usable narrative because of an unrelated malformed `entity_labels`. Extra/
 * unexpected top-level fields are tolerated for free (zod's default object
 * behavior strips, never rejects, unknown keys).
 *
 * `narrative` over the hard cap is TRUNCATED, not dropped (documented choice
 * — see synthesize-episodes.ts module header): an
 * overlong narrative is still real, grounded content, not a shape/semantic
 * corruption like a non-JSON payload; truncating salvages the Haiku spend
 * instead of discarding a whole cluster's synthesis over a length overrun.
 * If the field is missing or not a string at all, the catch falls back to
 * `""` — the orchestrator treats an empty narrative as unusable and skips
 * that cluster (never stores an empty-narrative episode).
 */
export const episodeNarrativeSchema = z.object({
  narrative: z
    .string()
    .max(NARRATIVE_MAX)
    .catch((ctx) => {
      const value = ctx.value;
      if (typeof value === "string" && value.length > NARRATIVE_MAX) {
        return value.slice(0, NARRATIVE_MAX);
      }
      return "";
    }),
  entity_labels: z.array(z.string()).catch([]),
});
export type EpisodeNarrative = z.infer<typeof episodeNarrativeSchema>;

// ---------------------------------------------------------------------------
// Orchestrator
// ---------------------------------------------------------------------------

export interface SynthesizeEpisodesOptions {
  /** Injectable Haiku call — defaults to the real `callBrainText` wiring;
   * tests stub this (no live Haiku call in unit tests). */
  synthesizeFn?: SynthesizeFn;
  /** Single authoritative "now" for the whole synthesis pass (matches the
   * rest of the memory pipeline's inject-don't-call-Date.now() convention). */
  now: Date;
  /** Narrative language (follows `config.language`, matches chat/critique). */
  language: string;
}


/** min/max `occurred_at` across the cluster's members (computed from
 * the members, never from the LLM, never flattened to a single value). */
function computeTimeSpan(cluster: readonly EventFragment[]): EpisodeTimeSpan {
  let start = cluster[0]!.occurred_at;
  let end = cluster[0]!.occurred_at;
  for (const f of cluster) {
    if (new Date(f.occurred_at).getTime() < new Date(start).getTime()) {
      start = f.occurred_at;
    }
    if (new Date(f.occurred_at).getTime() > new Date(end).getTime()) {
      end = f.occurred_at;
    }
  }
  return { start, end };
}

/**
 * Cluster active event fragments by day (`clusterByDay`), and for each
 * bucket with >= EPISODE_MIN_MEMBERS members that is NEW or CHANGED versus
 * `memory.episodes`, call `synthesizeFn` to narrate it (cost guard —
 * an unchanged day makes zero calls). Returns episode DRAFTS only;
 * `applyEpisodes` assigns id/version/timestamps when these are merged
 * into the store.
 *
 * NEVER THROWS: a malformed payload, a non-JSON payload, or a rejected
 * `synthesizeFn` call degrades ONLY the offending cluster to "no draft" —
 * every other cluster is still attempted, and the overall call degrades to
 * `[]` in the worst case (e.g. clustering itself somehow throws), never
 * propagating an error into the caller (matches `extractEventFragments`).
 */
export async function synthesizeEpisodes(
  memory: CoreMemory,
  opts: SynthesizeEpisodesOptions,
): Promise<EpisodeDraft[]> {
  const synthesizeFn = opts.synthesizeFn ?? defaultSynthesizeFn;
  const drafts: EpisodeDraft[] = [];

  let clusters: Map<string, EventFragment[]>;
  try {
    clusters = clusterByDay(activeEventFragments(memory, opts.now));
  } catch (err) {
    console.error(
      `[siltpoke memory] episode synthesis: clustering failed; degrading to 0 episodes: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
    return [];
  }

  // Existing episodes keyed by day_key — used ONLY for member-set diffing
  // (skip-if-unchanged) and NEVER passed into a prompt (anti-confab: no
  // re-feeding a prior narrative back into synthesis).
  // `?? []` guards a legacy/pre-schema store where `episodes` is absent
  // (schema-loaded memory defaults to [], but a raw doc may lack it) —
  // never-throws contract.
  const existingByDayKey = new Map((memory.episodes ?? []).map((e) => [e.day_key, e]));

  for (const [day, members] of clusters) {
    if (members.length < EPISODE_MIN_MEMBERS) continue;

    const memberIds = members.map((f) => f.id);
    const existing = existingByDayKey.get(day);
    if (existing && sameMemberSet(existing.member_fragment_ids, memberIds)) {
      continue; // member set unchanged -> skip entirely, no Haiku call
    }

    try {
      const prompt = assembleEpisodePrompt(members, day, opts.language);
      const raw = await synthesizeFn(prompt);

      let parsedJson: unknown;
      try {
        // Strip a ```json fence before parsing — real Haiku routinely wraps
        // JSON in a code fence (the seam-bug class this module guards).
        // extractJsonString is idempotent on already-clean JSON.
        parsedJson = JSON.parse(extractJsonString(raw));
      } catch {
        console.error(
          `[siltpoke memory] episode synthesis: non-JSON output for day ${day}; skipping cluster`,
        );
        continue;
      }

      const parsed = episodeNarrativeSchema.safeParse(parsedJson);
      if (!parsed.success) {
        console.error(
          `[siltpoke memory] episode synthesis: malformed output shape for day ${day}; skipping cluster`,
        );
        continue;
      }

      const narrative = parsed.data.narrative.trim();
      if (narrative.length === 0) {
        console.error(
          `[siltpoke memory] episode synthesis: empty/unusable narrative for day ${day}; skipping cluster`,
        );
        continue;
      }

      drafts.push({
        day_key: day,
        member_fragment_ids: memberIds,
        time_span: computeTimeSpan(members),
        narrative,
        entity_labels: parsed.data.entity_labels,
      });
    } catch (err) {
      console.error(
        `[siltpoke memory] episode synthesis: brain call failed for day ${day}; skipping cluster: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      continue;
    }
  }

  return drafts;
}
