// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
// Copyright (c) 2026 Jiaqi Duan
/**
 * Past chats, as the pane left of the chat column shows them: grouped Today /
 * Yesterday / This week / Earlier, one line each — the title, and the time
 * (Today, Yesterday) or the date (older). The pane opens and closes with the
 * header's clock button only, the way Runs opens to the right.
 */

/** The pane's width plus its 1 px divider line; the panel grows by this. */
export const HISTORY_PANE_PX = 241;

export interface HistoryRow {
  id: string;
  title: string;
  /** "14:05" for Today/Yesterday, "Oct 15" for older, "" when unknown. */
  when: string;
}

export interface HistoryGroup {
  label: "Today" | "Yesterday" | "This week" | "Earlier";
  rows: HistoryRow[];
}

interface Listed {
  id: string;
  title?: string;
  label: string;
  createdAt?: string | null;
}

function startOfDay(d: Date): number {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
}

/**
 * Group conversations (already newest first) by local calendar day. A missing
 * or unreadable date goes under Earlier with no time.
 */
export function groupHistory(convs: readonly Listed[], now: Date = new Date()): HistoryGroup[] {
  const groups: HistoryGroup[] = [];
  for (const c of convs) {
    const at = readDate(c.createdAt);
    const label = dayLabel(at ? startOfDay(at) : Number.NEGATIVE_INFINITY, now);
    const row = { id: c.id, title: c.title || c.label, when: at ? whenText(at, label) : "" };
    const last = groups.at(-1);
    if (last?.label === label) last.rows.push(row);
    else groups.push({ label, rows: [row] });
  }
  return groups;
}

function readDate(iso: string | null | undefined): Date | null {
  const d = iso ? new Date(iso) : null;
  return d && !Number.isNaN(d.getTime()) ? d : null;
}

/** Midnight `back` calendar days before `now` — by date, not by 24 h steps, so a DST day stays one day. */
function daysBack(now: Date, back: number): number {
  return new Date(now.getFullYear(), now.getMonth(), now.getDate() - back).getTime();
}

function dayLabel(day: number, now: Date): HistoryGroup["label"] {
  if (day >= daysBack(now, 0)) return "Today";
  if (day >= daysBack(now, 1)) return "Yesterday";
  if (day >= daysBack(now, 6)) return "This week";
  return "Earlier";
}

function whenText(at: Date, label: HistoryGroup["label"]): string {
  // h23, not hour12:false: the latter prints midnight as "24:05" in Chrome.
  return label === "Today" || label === "Yesterday"
    ? at.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit", hourCycle: "h23" })
    : at.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}
