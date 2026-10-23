// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
// Copyright (c) 2026 Jiaqi Duan
/**
 * Is the index this Code Map is drawn from still the code on disk?
 *
 * "Diagram is current" used to compare the diagram with the index only. On
 * 2026-10-15 agent-runtime's index predated a whole new folder, the diagram
 * was re-generated from that old index, and the button still said "Diagram is
 * current" while GET /api/repo-graph/staleness answered "88% out of date".
 * This module turns that endpoint's verdict into what the page may claim, and
 * the header line that says the code moved on. Kept out of `repo-graph.ts` so
 * that pinned file only grows by its wiring lines.
 */
import type { StalenessVerdict } from "../../../repo-graph/staleness-verdict";

/**
 * - pending: the check has not answered yet — claim nothing.
 * - fresh:   the index matches the code.
 * - behind:  files changed, appeared or disappeared since indexing.
 * - unknown: the check failed or could not read every file — claim nothing.
 */
export type IndexFreshness = "pending" | "fresh" | "behind" | "unknown";

/** `null` = the check itself failed. */
export function freshnessOf(v: StalenessVerdict | null): IndexFreshness {
  if (v === null) return "unknown";
  if (v.level === "fresh") return "fresh";
  if (v.level === "drifting" || v.level === "stale") return "behind";
  return "unknown";
}

/** The header line for an index that is behind, or null otherwise. The
 * "— re-index" tail only when the page can actually re-index (it knows the
 * repo's path); otherwise the line must not look like a working link. */
export function indexStaleLine(v: StalenessVerdict | null, canReindex = true): string | null {
  if (freshnessOf(v) !== "behind" || v === null) return null;
  const { content_changed, unindexed_files, deleted_still_indexed } = v.counts;
  const parts: string[] = [];
  if (content_changed > 0) parts.push(`${content_changed} ${content_changed === 1 ? "file" : "files"} edited`);
  if (unindexed_files > 0) parts.push(`${unindexed_files} new`);
  if (deleted_still_indexed > 0) parts.push(`${deleted_still_indexed} deleted`);
  return `· code changed since this map was indexed: ${parts.join(", ")}${canReindex ? " — re-index" : ""}`;
}

/**
 * The line a file or function panel adds when the index is behind, or "".
 * Its line count, symbol count and line numbers all come from the index, and
 * nothing on the panel said so (defect [84]: a three-month-old index showed
 * numbers that no longer matched the file).
 */
export function panelIndexNote(f: IndexFreshness): string {
  return f === "behind"
    ? '<div class="p-note" data-index-behind><span class="warn">From the index — some of the code has changed since it was built, so these numbers may be out of date. Re-index to refresh.</span></div>'
    : "";
}

/** GET the verdict for one repo; null when the request or its body fails. */
export async function fetchIndexVerdict(repoHash: string, fetchFn: typeof fetch = fetch): Promise<StalenessVerdict | null> {
  try {
    const res = await fetchFn(`/api/repo-graph/staleness?repo=${encodeURIComponent(repoHash)}`);
    if (!res.ok) return null;
    const body = (await res.json()) as { success?: boolean; data?: StalenessVerdict | null };
    // A body without a verdict level is a failed check, not a verdict.
    return body.success && typeof body.data?.level === "string" ? body.data : null;
  } catch {
    return null;
  }
}
