// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
// Copyright (c) 2026 Jiaqi Duan
/**
 * The sentence under a timeline row whose review was skipped because the daily
 * call cap was used up (defect `[70]`). Before it, that row was a bare grey
 * `quota_cap` tag: nothing said why reviews stopped or where to change it.
 *
 * Three cases, because a row can be old and the cap can have changed since:
 *  - row from TODAY (same `dayKey` as now, with `budget.resetAt`) and a cap is
 *    set: the full sentence — number, reset moment, where to change it;
 *  - row from an EARLIER day: neutral, no "today", no "paused", no number;
 *  - no cap set now (0, on purpose or not): says so instead of quoting a number.
 */
import type { CriticCall, CriticTelemetry } from "../../../state/api";
import { dayKey } from "../../../state/usage";

const WHERE = "To change the limit, open the Settings page and edit the Critic daily cap.";

function clock(resetAtMinutes: number): string {
  if (resetAtMinutes === 0) return "midnight";
  const h = String(Math.floor(resetAtMinutes / 60) % 24).padStart(2, "0");
  const m = String(resetAtMinutes % 60).padStart(2, "0");
  return `${h}:${m}`;
}

export function quotaCapNote(cap: number, resetAtMinutes: number, sameDay = true): string {
  if (cap === 0) {
    return "This review was skipped because the daily review limit was reached. There is no limit set now (Critic, on the Settings page), so new reviews can run.";
  }
  if (!sameDay) {
    return `The daily review limit was reached that day, so this review was skipped. ${WHERE}`;
  }
  return `Today's review limit (${cap} calls) was reached, so reviews are paused. The count starts again at ${clock(resetAtMinutes)} your time. ${WHERE}`;
}

/** The note for one rail row, or null when it is not a quota_cap skip (or the cap is unknown). */
export function quotaCapNoteFor(c: CriticCall, t: CriticTelemetry, now: Date): string | null {
  if (c.status === "fired" || c.skip_reason !== "quota_cap" || t.reviewDailyCap === undefined) return null;
  const reset = t.budget.config.resetAtMinutes;
  const sameDay = dayKey(new Date(c.timestamp), reset) === dayKey(now, reset);
  return quotaCapNote(t.reviewDailyCap, reset, sameDay);
}
