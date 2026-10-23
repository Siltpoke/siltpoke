// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
// Copyright (c) 2026 Jiaqi Duan
/**
 * "Today" as the user's own calendar day, for what the report and the status
 * card SHOW.
 *
 * Timestamps are stored as UTC ISO strings. Slicing their first ten characters
 * gives the UTC day, so in California every evening's activity counted as
 * tomorrow and "today" emptied at 5 pm (chat mainline review leftover C2). The
 * daily caps and the token budget already key on the local day (`dayKey` in
 * src/state/usage.ts); this puts the displays on the same boundary.
 *
 * Stored day keys (the pet's action log, its streak) are a separate question:
 * their writers and readers would have to change together.
 */
import { dayKey } from "../state/usage";

/**
 * The local day (YYYY-MM-DD) a timestamp falls on, or null if it does not
 * parse. `resetAtMinutes` shifts the boundary as the budget's `resetAt` does,
 * so a per-project "today" matches the totals beside it.
 */
export function localDayOf(ts: string, resetAtMinutes = 0): string | null {
  const t = Date.parse(ts);
  return Number.isFinite(t) ? dayKey(new Date(t), resetAtMinutes) : null;
}

/** The last `days` local days ending today, oldest first. */
export function lastLocalDays(now: Date, days: number): string[] {
  const out: string[] = [];
  for (let back = days - 1; back >= 0; back--) {
    const d = new Date(now);
    d.setDate(d.getDate() - back);
    out.push(dayKey(d));
  }
  return out;
}
