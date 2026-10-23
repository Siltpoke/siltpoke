// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
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

import { type FileHandle, open } from "node:fs/promises";
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
 * parsed to bubble_short === null) are not activity and never render —
 * unless the row carries an injection alert: a low-confidence review that
 * was blanked from the bubble must still show its warning on the dashboard.
 * Skipped rows pass through (the status filter decides their visibility).
 */
export function isDisplayEligible(c: CriticCall): boolean {
  if (c.injection_alert) return true; // truthy: a hand-built call may omit the field
  return !(c.status === "fired" && c.bubble_short === null);
}

export interface RowFilterOpts {
  status: StatusFilter | null;
  kind: SpeechKind | null;
  /** Range lower bound in epoch ms; null = unbounded. */
  cutoffMs: number | null;
  /** Lowercased query; null = no text filter. */
  q: string | null;
  /** Builder-family filter (Brain select v2); null = all families. */
  family: string | null;
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
  if (f.family && (c.authorFamily || "claude") !== f.family) return false;
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
  /** Builder-family filter (Brain select v2); null = all families. */
  family?: string | null;
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
 * Parsed rows of one brain-calls.jsonl, kept between requests. The log is
 * append-only, so a later read parses only the bytes added since; the live
 * log is 52 MB / 54k lines and a full parse per /timeline request cost
 * ~0.25 s and ~380 MB of garbage (measured 2026-10-16).
 *
 * `offset` is the byte length consumed, always just past a newline, so a
 * half-written last line is re-read once it is finished. The file is parsed
 * afresh when its inode changes, it got shorter, or the first or last 4 KB
 * of the consumed part no longer match (a rewrite in place). A rewrite that
 * keeps both ends and changes only the middle is not noticed; the stop hook
 * only ever appends, so that is accepted. A last line without a newline is
 * parsed on every read but not kept, as the old full read did.
 *
 * A log nobody has read for IDLE_EVICT_MS is dropped, so an idle dashboard
 * does not hold the parsed log (a few hundred MB for the live one); the next
 * read parses it again.
 */
interface ParsedLog {
  dev: number;
  ino: number;
  offset: number;
  check: Buffer;
  rows: DatedCall[];
}

const CHECK_BYTES = 4096;
const IDLE_EVICT_MS = 10 * 60_000;
const parsedLogs = new Map<string, ParsedLog>();
const inFlight = new Map<string, Promise<DatedCall[]>>();
const evictTimers = new Map<string, ReturnType<typeof setTimeout>>();

function scheduleEvict(path: string): void {
  clearTimeout(evictTimers.get(path));
  const timer = setTimeout(() => {
    evictTimers.delete(path);
    parsedLogs.delete(path);
  }, IDLE_EVICT_MS);
  timer.unref?.();
  evictTimers.set(path, timer);
}

function parseDated(line: string): DatedCall | null {
  if (line.length === 0) return null;
  const c = parseLine(line);
  if (!c) return null;
  const t = Date.parse(c.timestamp);
  return Number.isNaN(t) ? null : { c, t };
}

/** First and last CHECK_BYTES of [0, end). */
async function readEnds(fh: FileHandle, end: number): Promise<Buffer> {
  const headLen = Math.min(end, CHECK_BYTES);
  const tailStart = Math.max(headLen, end - CHECK_BYTES);
  const buf = Buffer.alloc(headLen + (end - tailStart));
  if (headLen > 0) await fh.read(buf, 0, headLen, 0);
  if (end > tailStart) await fh.read(buf, headLen, end - tailStart, tailStart);
  return buf;
}

async function refreshParsedLog(path: string): Promise<DatedCall[]> {
  let fh: FileHandle;
  try {
    fh = await open(path, "r");
  } catch {
    parsedLogs.delete(path);
    return [];
  }
  try {
    const st = await fh.stat();
    let log = parsedLogs.get(path);
    const stale =
      !log ||
      log.dev !== st.dev ||
      log.ino !== st.ino ||
      st.size < log.offset ||
      !(await readEnds(fh, log.offset)).equals(log.check);
    if (stale || !log) {
      log = { dev: st.dev, ino: st.ino, offset: 0, check: Buffer.alloc(0), rows: [] };
      parsedLogs.set(path, log);
    }
    let unterminated: DatedCall | null = null;
    if (st.size > log.offset) {
      const buf = Buffer.alloc(st.size - log.offset);
      await fh.read(buf, 0, buf.length, log.offset);
      const lastNewline = buf.lastIndexOf(0x0a);
      if (lastNewline >= 0) {
        for (const line of buf.subarray(0, lastNewline).toString("utf8").split("\n")) {
          const row = parseDated(line);
          if (row) log.rows.push(row);
        }
        log.offset += lastNewline + 1;
        log.check = await readEnds(fh, log.offset);
      }
      unterminated = parseDated(buf.subarray(lastNewline + 1).toString("utf8"));
    }
    return unterminated ? [...log.rows, unterminated] : log.rows;
  } finally {
    await fh.close();
  }
}

/** One refresh per log at a time; concurrent requests share it. */
function parsedRows(path: string): Promise<DatedCall[]> {
  const running = inFlight.get(path);
  if (running) return running;
  const p = refreshParsedLog(path).finally(() => {
    inFlight.delete(path);
    scheduleEvict(path);
  });
  inFlight.set(path, p);
  return p;
}

/**
 * Keep display-eligible rows inside the range, collect the project list
 * (derived BEFORE status/kind/q/project so the picker stays stable while
 * those filters narrow the rows), then apply the shared row predicate.
 * Returned rows are sorted chronologically (stable — ties keep file order),
 * removing any reliance on strict append order.
 */
function collectPassingRows(
  rows: DatedCall[],
  cutoffMs: number | null,
  filters: RowFilterOpts,
  projectsSet: Set<string>,
): DatedCall[] {
  const passing: DatedCall[] = [];
  for (const { c, t } of rows) {
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
  const rows = await parsedRows(path);
  const filters: RowFilterOpts = {
    status: opts.status,
    kind: opts.kind,
    // Range is enforced in the scan on the parsed epoch — no double parse.
    cutoffMs: null,
    q: opts.query ? opts.query.trim().toLowerCase() || null : null,
    family: opts.family ?? null,
  };

  const projectsSet = new Set<string>();
  const eligible = collectPassingRows(
    rows,
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
    // Copies: callers attach v2 / diff_text / user_action to page rows, and
    // the kept rows must not carry those into the next request.
    calls: passing.slice(start, end).map((e) => ({ ...e.c })),
    hasOlder: start > 0,
    hasNewer: end < passing.length,
    total: passing.length,
    projects: Array.from(projectsSet).sort(),
  };
}
