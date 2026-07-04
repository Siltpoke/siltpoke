// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
// Copyright (c) 2026 Jiaqi Duan
/**
 * action-log-client — pure log-building helpers for the per-fact expanded rail.
 *
 * Extracted from memory-book-helpers when that file exceeded the 400-line soft cap.
 * No project imports — this is a leaf module (no circular risk).
 *
 * Consumed by memory-book-helpers.ts (re-exported) and MemoryActionLog.tsx (SSR).
 */

/**
 * Per-fact event record — mirrors Fact.events[] (FactEvent in memory.ts).
 * Defined here (leaf module, no project imports) so this file stays client-bundle-safe.
 */
export interface FactEvent {
  action: "created" | "approved" | "reaffirmed" | "retired" | "reactivated";
  at: string;
  reason: string | null;
}

/**
 * One row in the expanded action-log rail.
 *
 * Two row kinds:
 *   1. Event row  (isSupersede absent): action + dateLabel = "YYYY-MM-DD HH:mm"
 *   2. Supersede sub-row (isSupersede: true): indented link to the partner fact.
 *
 * Legacy reaffirms (recall_count > 0, no per-event timestamps): a synthetic
 * reaffirmed row with dateLabel = "×N" (no timestamp available).
 */
export interface LogRow {
  action: string;
  /**
   * "YYYY-MM-DD HH:mm" for real events.
   * "×N"              for legacy-reaffirm synthetic rows.
   * ""                for supersede sub-rows (text lives in supersedeText).
   */
  dateLabel: string;
  /** true → indented supersede sub-line (not a timed event). */
  isSupersede?: true;
  /** Which direction the link points. */
  supersedeType?: "supersedes" | "superseded_by";
  /** Partner fact text (truncated ~40 chars in display). */
  supersedeText?: string | null;
  /** Partner fact id (passed to jumpToFact on click). */
  supersedeId?: string | null;
}

/** Format an ISO timestamp as "YYYY-MM-DD HH:mm" in the BROWSER's local timezone. */
function formatEventDate(at: string): string {
  const d = new Date(at);
  if (isNaN(d.getTime())) {
    // Fallback: UTC-slice for malformed strings.
    const datePart = at.length >= 10 ? at.slice(0, 10) : at;
    const timePart = at.length >= 16 ? at.slice(11, 16) : "";
    return timePart ? `${datePart} ${timePart}` : datePart;
  }
  const y = d.getFullYear();
  const mo = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  const h = String(d.getHours()).padStart(2, "0");
  const min = String(d.getMinutes()).padStart(2, "0");
  return `${y}-${mo}-${day} ${h}:${min}`;
}

/**
 * Build LogRow[] for the expanded action-log rail.
 *
 * Rules:
 *   - `created` events are OMITTED (time lives on the timeline-axis gutter).
 *   - Order: newest→oldest (reversed from stored events[]).
 *   - Each reaffirmed event → its own individual row with date+time.
 *   - Legacy facts (legacyReaffirmCount > 0, no reaffirm events): one synthetic
 *     `★重申 ×N` row appended at the end (no timestamp available).
 *
 * Does NOT inject supersede sub-rows — call injectSupersedeRows for that.
 */
export function buildLogRows(
  events: FactEvent[],
  legacyReaffirmCount?: number,
  legacyReaffirmAt?: string | null,
): LogRow[] {
  // Filter out 'created', reverse to newest→oldest.
  const filtered = events.filter((e) => e.action !== "created");
  const reversed = [...filtered].reverse();

  const rows: LogRow[] = reversed.map((ev) => ({
    action: ev.action,
    dateLabel: formatEventDate(ev.at),
  }));

  // Inject a synthetic legacy-reaffirm row when recall_count > 0 but no per-event
  // reaffirm timestamps exist (pre-events-log data). Appended at end (oldest).
  // The COUNT is shown by the header ★重申 ×N badge, so this row shows ONLY the
  // date (last_confirmed_at = most recent reaffirm); ×N kept solely as a fallback
  // when no timestamp exists at all (else the row would be dateless + countless).
  const hasReaffirmEvents = events.some((e) => e.action === "reaffirmed");
  if (!hasReaffirmEvents && legacyReaffirmCount && legacyReaffirmCount > 0) {
    rows.push({
      action: "reaffirmed",
      dateLabel: legacyReaffirmAt
        ? formatEventDate(legacyReaffirmAt)
        : `×${legacyReaffirmCount}`,
    });
  }

  return rows;
}

/**
 * Inject supersede sub-rows into a pre-built LogRow[].
 *
 * Superseding fact (supersedesText set):
 *   → sub-row inserted after the first (newest) log row (or at index 0 if empty).
 *
 * Superseded fact (supersededByText set):
 *   → sub-row inserted after the `retired` row, or after index 0 if not found.
 *
 * Returns a NEW array — does not mutate the input.
 */
export function injectSupersedeRows(
  rows: LogRow[],
  supersedesText: string | null,
  supersedesId: string | null | undefined,
  supersededByText: string | null,
  supersededById: string | null | undefined,
): LogRow[] {
  const result = [...rows];

  if (supersedesText && supersedesId) {
    const insertAt = Math.min(1, result.length);
    result.splice(insertAt, 0, {
      action: "supersede",
      dateLabel: "",
      isSupersede: true,
      supersedeType: "supersedes",
      supersedeText: supersedesText,
      supersedeId: supersedesId,
    });
  }

  if (supersededByText && supersededById) {
    const retiredIdx = result.findIndex((r) => r.action === "retired");
    const insertAt =
      retiredIdx >= 0 ? retiredIdx + 1 : Math.min(1, result.length);
    result.splice(insertAt, 0, {
      action: "supersede",
      dateLabel: "",
      isSupersede: true,
      supersedeType: "superseded_by",
      supersedeText: supersededByText,
      supersedeId: supersededById,
    });
  }

  return result;
}
