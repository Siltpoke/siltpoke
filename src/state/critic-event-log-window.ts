// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Copyright (c) 2026 Jiaqi Duan
/**
 * critic-event-log — shared row predicate + predicate-counted turn window.
 *
 * Peeled out of critic-event-log.ts (same split pattern as `-types` /
 * `-parse`) to keep the pagination window logic — predicate + cursor slice
 * + one-pass counting — self-contained and independently testable.
 *
 * `matchesRowFilters` is the SINGLE per-row filter source both the legacy
 * post-window applyFilters and the in-scan turn window evaluate — window
 * accounting can never diverge from what renders.
 */

import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { parseCall } from "./critic-event-log-parse";
import type { CriticCall, SpeechKind, StatusFilter } from "./critic-event-log-types";

/** Parse one JSONL line; null on malformed input (per-line tolerance). */
export function parseLine(line: string): CriticCall | null {
  try {
    return parseCall(JSON.parse(line));
  } catch {
    return null; // malformed line
  }
}

/**
 * Display-eligibility rule shared by the row-assembly step and the turn
 * window: fired rows without a bubble (empty/missing/suppressed — all
 * parsed to bubble_short === null) are not activity and never render.
 * Skipped rows pass through (the status filter decides their visibility).
 */
export function isDisplayEligible(c: CriticCall): boolean {
  return !(c.status === "fired" && c.bubble_short === null);
}

export interface RowFilterOpts {
  status: StatusFilter | null;
  kind: SpeechKind | null;
  /** Range lower bound in epoch ms; null = unbounded. */
  cutoffMs: number | null;
  /** Lowercased query; null = no text filter. */
  q: string | null;
}

/**
 * Status-facet match. "errors" is a synthetic facet, not a row status:
 * brain-failure rows parse as skipped/brain_error and are identified by
 * error_message.
 */
function matchesStatus(c: CriticCall, status: StatusFilter | null): boolean {
  if (status === "errors") return c.error_message !== null;
  return !status || c.status === status;
}

export function matchesRowFilters(c: CriticCall, f: RowFilterOpts): boolean {
  if (!matchesStatus(c, f.status)) return false;
  if (f.kind && c.speech_kind !== f.kind) return false;
  if (f.cutoffMs !== null) {
    const t = new Date(c.timestamp).getTime();
    if (Number.isNaN(t) || t < f.cutoffMs) return false;
  }
  if (f.q) {
    const hay =
      `${c.bubble_short ?? ""}\n${c.bubble_long ?? ""}\n${c.critique_for_claude ?? ""}`.toLowerCase();
    if (!hay.includes(f.q)) return false;
  }
  return true;
}

/** Options for the predicate-counted turn window (timeline pagination). */
export interface BrainCallsPageOpts {
  /** Page size in DISPLAY-ELIGIBLE rows (not lines). */
  limit: number;
  /** Range lower bound (inclusive); null = all time. */
  rangeCutoff: Date | null;
  /** Exclusive upper cursor: page holds the newest rows strictly older. */
  before?: Date | null;
  /** Exclusive lower cursor: page holds the oldest rows strictly newer. */
  after?: Date | null;
  /** First-page anchor when no cursor is given (sort drives it). */
  anchor: "newest" | "oldest";
  status: StatusFilter | null;
  kind: SpeechKind | null;
  /** Raw text query (trimmed/lowercased internally); null = none. */
  query: string | null;
  /** Project (cwd basename) filter; unknown values filter nothing. */
  project: string | null;
}

export interface BrainCallsPage {
  /** Page rows, CHRONOLOGICAL (oldest → newest). Caller orders for render. */
  calls: CriticCall[];
  /** More predicate-passing rows exist older than the page. */
  hasOlder: boolean;
  /** More predicate-passing rows exist newer than the page. */
  hasNewer: boolean;
  /** Total predicate-passing rows across the whole range (honest totals). */
  total: number;
  /** Distinct projects across range-passing display rows (pre-project-filter). */
  projects: string[];
}

interface DatedCall {
  c: CriticCall;
  t: number;
}

/**
 * Linear scan: parse every line, keep display-eligible rows with parseable
 * timestamps inside the range, collect the project list (derived BEFORE
 * status/kind/q/project so the picker stays stable while those filters
 * narrow the rows), then apply the shared row predicate. Returned rows are
 * sorted chronologically (stable — ties keep file order), removing any
 * reliance on strict append order.
 */
function collectPassingRows(
  raw: string,
  cutoffMs: number | null,
  filters: RowFilterOpts,
  projectsSet: Set<string>,
): DatedCall[] {
  const passing: DatedCall[] = [];
  for (const line of raw.split("\n")) {
    if (line.length === 0) continue;
    const c = parseLine(line);
    if (!c) continue;
    const t = Date.parse(c.timestamp);
    if (Number.isNaN(t)) continue;
    if (cutoffMs !== null && t < cutoffMs) continue;
    if (!isDisplayEligible(c)) continue;
    projectsSet.add(c.project);
    if (!matchesRowFilters(c, filters)) continue;
    passing.push({ c, t });
  }
  passing.sort((a, b) => a.t - b.t);
  return passing;
}

/**
 * Page slice bounds [start, end) over the chronological passing rows.
 * `before` pages older (newest rows strictly below the bound), `after`
 * pages newer (oldest rows strictly above it); with no cursor the anchor
 * picks an end of the range.
 */
function pageSliceBounds(
  passing: DatedCall[],
  opts: BrainCallsPageOpts,
): { start: number; end: number } {
  const beforeMs = opts.before?.getTime() ?? null;
  const afterMs = opts.after?.getTime() ?? null;
  if (beforeMs !== null && !Number.isNaN(beforeMs)) {
    let hi = passing.findIndex((e) => e.t >= beforeMs);
    if (hi === -1) hi = passing.length;
    // hi === 0 (before older than everything) → empty page with hasNewer
    // true: a caller can page back toward newer. Non-dead, deliberately kept.
    return { start: Math.max(0, hi - opts.limit), end: hi };
  }
  if (afterMs !== null && !Number.isNaN(afterMs)) {
    const lo = passing.findIndex((e) => e.t > afterMs);
    // Nothing newer than the cursor (out-of-range hand-crafted `after`) would
    // otherwise give an empty page with a spurious hasOlder and NO hasNewer —
    // a real dead end. Clamp to the newest window instead.
    if (lo === -1) {
      return { start: Math.max(0, passing.length - opts.limit), end: passing.length };
    }
    return { start: lo, end: Math.min(passing.length, lo + opts.limit) };
  }
  if (opts.anchor === "oldest") {
    return { start: 0, end: Math.min(passing.length, opts.limit) };
  }
  return { start: Math.max(0, passing.length - opts.limit), end: passing.length };
}

/**
 * Predicate-counted turn window: `limit` counts rows that would actually
 * RENDER under the active filters — gate-skip floods and no-bubble rows
 * never consume slots. One linear parse of the file per request (the file
 * is already fully read per request; predicates in-scan are cheap).
 *
 * Rows with unparseable timestamps are excluded: cursors and anchors are
 * chronological, so a row without a valid time cannot be placed.
 * `before` takes precedence when both cursors are set (our pager hrefs
 * only ever emit one).
 */
export async function readBrainCallsPage(
  basePath: string,
  opts: BrainCallsPageOpts,
): Promise<BrainCallsPage> {
  const path = join(basePath, "brain-calls.jsonl");
  if (!existsSync(path)) {
    return { calls: [], hasOlder: false, hasNewer: false, total: 0, projects: [] };
  }
  const raw = await readFile(path, "utf8");
  const filters: RowFilterOpts = {
    status: opts.status,
    kind: opts.kind,
    // Range is enforced in the scan on the parsed epoch — no double parse.
    cutoffMs: null,
    q: opts.query ? opts.query.trim().toLowerCase() || null : null,
  };

  const projectsSet = new Set<string>();
  const eligible = collectPassingRows(
    raw,
    opts.rangeCutoff?.getTime() ?? null,
    filters,
    projectsSet,
  );

  // Same validity guard as the legacy path: a project value not present in
  // the window filters nothing (bogus params can't blank the page).
  const project = opts.project && projectsSet.has(opts.project) ? opts.project : null;
  const passing = project ? eligible.filter((e) => e.c.project === project) : eligible;

  const { start, end } = pageSliceBounds(passing, opts);
  return {
    calls: passing.slice(start, end).map((e) => e.c),
    hasOlder: start > 0,
    hasNewer: end < passing.length,
    total: passing.length,
    projects: Array.from(projectsSet).sort(),
  };
}
