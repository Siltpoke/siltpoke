// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
// Copyright (c) 2026 Jiaqi Duan
/**
 * When and how an unhealthy brain is shown to the user. Split out of
 * `brain-health.ts`, which owns the record and its transitions; this file
 * only reads one.
 */
import type { BrainHealth } from "./brain-health";

const SIGNAL_AGE_OUT_MS = 24 * 60 * 60 * 1000;

// ── Surfacing predicate (card ⚠ line + dashboard strip) ──────────────────────

/**
 * Epoch ms since which the reviewer has been latched off, or null when it is
 * not. A breaker on a timer is NOT this: it reopens by itself.
 */
export function latchedSinceMs(health: BrainHealth): number | null {
  const b = health.breaker;
  if (b === null || b.class !== "permanent") return null;
  const at = Date.parse(b.opened_at);
  return Number.isFinite(at) ? at : null;
}

export interface UnhealthySignal {
  show: boolean;
  /** One-liner for the card / strip, "" when show=false. */
  line: string;
  /** The raw failure excerpt, for a `title`/tooltip. Empty when show=false.
   *  It used to lead the line; a JSON tail is what a debugger wants and what
   *  everyone else has to read past. */
  detail: string;
}

/** "40m" / "1h" / "1h 30m". Minutes are rounded, hours are not folded away:
 *  `Math.round(90/60)` is 2, and a strip that turns an hour and a half into
 *  "2h" is wrong in the direction that matters for a countdown. */
function coarseDuration(ms: number): string {
  const mins = Math.max(0, Math.round(ms / 60_000));
  if (mins < 60) return `${mins}m`;
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return m === 0 ? `${h}h` : `${h}h ${m}m`;
}

/**
 * Shared predicate for the state-card ⚠ line and the dashboard health strip:
 * surface when consecutive_failures ≥ 2 OR the failing class is permanent
 * (which surfaces at the FIRST failure). 24h age-out, except while the
 * breaker is latched; clears automatically when a success resets
 * consecutive_failures to 0.
 *
 * The line distinguishes THREE states, because the first version had only one
 * and said the wrong thing for most of the time it was on screen. It read
 * `⚠ brain: resource ×4 — <80 chars of raw stderr>` in the present tense for a
 * full day after the last failure. Observed live: four failures at 15:34Z,
 * `last_attempt_ts` still 15:34Z an hour later, the breaker open that whole
 * hour — so nothing had even been attempted, and the strip was reporting a
 * live fault. "I am not currently trying" had no rendering, so it rendered as
 * "I am failing".
 *
 *   - breaker open on a timer → PAUSED, with the time left. The honest present
 *     tense: the brain is not failing, it is not being called.
 *   - breaker latched (permanent) → says so, and names the way out. A
 *     countdown here would be a lie; nothing expires.
 *   - breaker closed, failures still counted → past tense with an age, so a
 *     strip left over from this morning cannot read as one from this minute.
 *
 * The raw excerpt moves to `detail` (a tooltip) in all three.
 */
export function brainUnhealthySignal(
  health: BrainHealth,
  now: Date,
): UnhealthySignal {
  const f = health.last_failure;
  const NONE: UnhealthySignal = { show: false, line: "", detail: "" };
  if (f === null || health.consecutive_failures < 1) return NONE;
  const escalated =
    health.consecutive_failures >= 2 || f.class === "permanent";
  if (!escalated) return NONE;
  const ageMs = now.getTime() - Date.parse(f.ts);
  if (!Number.isFinite(ageMs)) return NONE;
  // The age-out is for a record nothing is acting on any more. A latched
  // breaker is still skipping every review, and because it skips them the
  // last failure never gets newer — so aging it out hid the one state that
  // cannot end by itself (audit [48]).
  const latched = health.breaker?.class === "permanent";
  if (!latched && ageMs > SIGNAL_AGE_OUT_MS) return NONE;

  const detail = f.stderr_excerpt.trim().length > 0
    ? f.stderr_excerpt.trim().slice(0, 200)
    : `exit ${f.exit_code ?? "?"}, no stderr`;
  const n = health.consecutive_failures;
  const times = `${n} ${f.class} failure${n === 1 ? "" : "s"}`;

  const b = health.breaker;
  if (b !== null && b.class === "permanent") {
    // The ONE case that keeps the reason in the line. A permanent failure is
    // an auth/flag problem where the reason IS the action — `/siltpoke:siltpoke-wake`
    // does nothing about an invalid API key — and the statusline card renders
    // this same string with no tooltip to put it in.
    return {
      show: true,
      line: `⚠ brain stopped after ${times} — ${detail.slice(0, 80)} · clear with /siltpoke:siltpoke-wake or a passing doctor`,
      detail,
    };
  }
  const remainingMs = b === null ? 0 : Date.parse(b.next_eligible_at) - now.getTime();
  if (b !== null && Number.isFinite(remainingMs) && remainingMs > 0) {
    return {
      show: true,
      line: `⚠ brain paused after ${times} — retrying in ${coarseDuration(remainingMs)}`,
      detail,
    };
  }
  return {
    show: true,
    line: `⚠ brain: ${times}, last ${coarseDuration(ageMs)} ago — the next call will retry`,
    detail,
  };
}
