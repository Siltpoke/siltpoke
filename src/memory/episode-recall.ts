// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Copyright (c) 2026 Jiaqi Duan
/**
 * Episode recall — select synthesized episodes to weave into the chat
 * prompt + build the injection block. Pure leaf: types + date math + string
 * build only. No I/O, no network, no Brain call, no `Date.now()` (callers
 * inject `now`). Mirrors the recall.ts anti-over-steer discipline.
 */
import type { Episode } from "./episode";

const MS_PER_DAY = 86_400_000;

/** Cap on episodes recalled into a single chat prompt (lost-in-the-middle). */
export const EPISODE_RECALL_MAX = 3;
/** Recency window (by `time_span.end`); older episodes are not recalled. */
export const EPISODE_RECALL_MAX_AGE_DAYS = 14;

/** Local-calendar-day floor (host-local midnight) as epoch ms. */
function localMidnight(d: Date): number {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
}

/**
 * Recency phrased in the user's own calendar day (not raw 24h): "today" |
 * "yesterday" | "N days ago". Host-local (a local-first pet speaks in the
 * user's day). Same/future day reads "today".
 */
export function relativeDay(end: Date | string, now: Date): string {
  const endDate = typeof end === "string" ? new Date(end) : end;
  const days = Math.round((localMidnight(now) - localMidnight(endDate)) / MS_PER_DAY);
  if (days <= 0) return "today";
  if (days === 1) return "yesterday";
  return `${days} days ago`;
}

/**
 * Select synthesized episodes to recall into the chat prompt. PURE selection —
 * caller passes the `activeEpisodes(...)` result (already expiry-filtered).
 *
 *   - empty / all-stale input -> `[]` (honest abstain, not an error).
 *   - recency-gate by `time_span.end`: drop anything older than `maxAgeDays`.
 *   - an episode with a missing/malformed `time_span.end` is skipped (NaN ms),
 *     never throws.
 *   - keep the `max` MOST-RECENT by `end`, returned OLDEST-FIRST (most-recent
 *     last, closest to the query per lost-in-the-middle).
 *
 * `opts.query` is accepted for a later relevance pass but UNUSED for now
 * (the paired `scoreEpisode` hook is intentionally NOT seeded yet;
 * recency-only selection ships now, scoring slots in when the corpus grows).
 */
export function selectRecallEpisodes(
  episodes: Episode[],
  now: Date,
  opts?: { maxAgeDays?: number; max?: number; query?: string },
): Episode[] {
  const maxAgeDays = opts?.maxAgeDays ?? EPISODE_RECALL_MAX_AGE_DAYS;
  const max = opts?.max ?? EPISODE_RECALL_MAX;
  const nowMs = now.getTime();
  const cutoffMs = maxAgeDays * MS_PER_DAY;

  const fresh: { e: Episode; endMs: number }[] = [];
  for (const e of episodes) {
    const endMs = new Date(e.time_span?.end ?? "").getTime();
    if (Number.isNaN(endMs)) continue; // malformed/missing -> skip, never throw
    if (nowMs - endMs > cutoffMs) continue; // stale -> abstain
    fresh.push({ e, endMs });
  }

  // Stable sort (ES2019+, guaranteed on Bun/JSC): episodes sharing an identical
  // `endMs` keep input order — the deterministic tie-break requires it.
  fresh.sort((a, b) => b.endMs - a.endMs); // most-recent first
  return fresh
    .slice(0, max) // the `max` most-recent
    .reverse() // oldest-first (most-recent last)
    .map((x) => x.e);
}

// Anti-over-steer framing (mirrors recall.ts). Episodes are RECENT-WORK
// background, offered as an optional opener, never a script. Low-authority
// tone: the model may raise AT MOST ONE, and only as a checkable question it
// could be wrong about — not an assertion, and never a recitation of the block.
const FRAMING = [
  "The above is background context about what the user recently worked on.",
  "At most ONE of these may be worth gently surfacing, and only if it genuinely fits what they are asking right now.",
  "If you surface one, phrase it as a light, checkable question (e.g. \"weren't you just working on X?\"), never as a confident assertion.",
  "Do not recite these back, do not invent any detail beyond the narrative shown, and do not mention this context block itself.",
  "If nothing here fits, ignore it completely.",
].join(" ");

/**
 * Render selected episodes into an `<episode_recall>` block for the chat system
 * prompt. Empty selection -> `""` (no scaffold, no broken prompt — not an
 * empty tag). Each line: `- [{relativeDay}, {day_key}] {narrative}`. The
 * anti-over-steer framing is appended after the block.
 *
 * Returns the block alone (no leading separator); the caller composes spacing.
 */
export function buildEpisodeRecallBlock(selected: Episode[], now: Date): string {
  if (selected.length === 0) return "";
  const lines = selected
    .map((e) => `- [${relativeDay(e.time_span.end, now)}, ${e.day_key}] ${sanitize(e.narrative)}`)
    .join("\n");
  return `<episode_recall>\n${lines}\n</episode_recall>\n\n${FRAMING}`;
}

/**
 * Neutralize angle brackets in the LLM-synthesized narrative before it re-enters
 * the prompt — a stray `</episode_recall>` in a narrative would otherwise break
 * out of the block and inject uncontrolled text (LLM output = untrusted input,
 * even from our own synthesizer).
 */
function sanitize(narrative: string): string {
  return narrative.replace(/[<>]/g, "");
}
