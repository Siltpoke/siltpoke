// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Copyright (c) 2026 Jiaqi Duan
/**
 * critic-event-log — parser for ~/.siltpoke/brain-calls.jsonl + usage.json.
 *
 * Surfaces what the Critic page renders: recent fires, skip-reason histogram,
 * budget gauge state, and a top-down gate diagnostic ("why is critic silent
 * RIGHT NOW?").
 *
 * Tolerant of malformed lines (per-line try/catch, skip on error).
 *
 * File split: types live in `critic-event-log-types.ts`; JSONL line
 * parsers live in `critic-event-log-parse.ts`; the shared row predicate +
 * predicate-counted turn window live in `critic-event-log-window.ts`.
 * This file owns the I/O + aggregation + the public read entry
 * (`readCriticTelemetry`).
 */

import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { aggregatePreferenceStats } from "../preference-log/stats";
import { loadTriggerConfig } from "../router/trigger-modes";
import {
  type BudgetConfig,
  type BudgetDecision,
  evaluateBudget,
  loadBudgetConfig,
} from "./budget-config";
import type { CriticCall, CriticGateState, CriticTelemetry, ReadTelemetryOpts, SkipBreakdown, SortOrder, SpeechKind, StatusFilter, TelemetryTotals, TimeRange, UserAction, UserActionStats } from "./critic-event-log-types";
import {
  type BrainCallsPage,
  isDisplayEligible,
  matchesRowFilters,
  parseLine,
  type RowFilterOpts,
  readBrainCallsPage,
} from "./critic-event-log-window";
import {
  isQuietHour,
  loadQuietHoursConfig,
  type QuietHoursConfig,
} from "./quiet-hours";
import type { DailyRollup } from "./usage";
import { loadV2Sidecar } from "./v2-sidecar";

export type { CallStatus, CriticCall, CriticEvidence, CriticGateState, CriticTelemetry, ReadTelemetryOpts, SkipBreakdown, SortOrder, SpeechKind, StatusFilter, TelemetryTotals, TimeRange, UserAction, UserActionStats } from "./critic-event-log-types";
// Re-export the type surface so existing consumers keep compiling.
export { classifySpeechKind } from "./critic-event-log-types";
export type { BrainCallsPage, BrainCallsPageOpts } from "./critic-event-log-window";
export { isDisplayEligible, readBrainCallsPage } from "./critic-event-log-window";

/** Optional time bounds for the readBrainCalls window (Load-older pagination). */
export interface BrainCallsWindowOpts {
  /**
   * Lower bound (inclusive — same semantics as applyFilters' rangeStart
   * check): rows with timestamp < rangeCutoff never enter the window. On a
   * chronologically appended file this also enables the backward-scan
   * early exit.
   */
  rangeCutoff?: Date | null;
  /** Exclusive upper bound: only rows strictly older than `before` are collected. */
  before?: Date | null;
}

export interface BrainCallsWindow {
  /** Collected rows, newest first (same ordering contract as before). */
  calls: CriticCall[];
  /**
   * True when at least one more window-passing row exists beyond (older
   * than) the returned window. False when the scan exhausted the file or
   * hit the rangeCutoff (sorted file ⇒ nothing older can pass).
   */
  hasMore: boolean;
}

/**
 * Unbounded callers keep the exact tail-limit behavior: the last `limit`
 * LINES (a malformed line consumes a slot), parsed, newest first. hasMore
 * is additive — a backward peek past the slice for one parseable row; the
 * returned rows are untouched.
 */
function readTailWindow(lines: string[], limit: number): BrainCallsWindow {
  const calls: CriticCall[] = [];
  for (const line of lines.slice(-limit)) {
    const call = parseLine(line);
    if (call) calls.push(call);
  }
  calls.reverse();
  let hasMore = false;
  for (let i = lines.length - limit - 1; i >= 0; i--) {
    if (parseLine(lines[i] as string)) {
      hasMore = true;
      break;
    }
  }
  return { calls, hasMore };
}

/**
 * Time-bounded window: backward scan from the tail (newest → oldest).
 * Rows with unparseable timestamps cannot be placed against a bound — they
 * are skipped (never break the scan: only a PARSEABLE timestamp below the
 * cutoff proves nothing older can pass).
 */
function scanBoundedWindow(
  lines: string[],
  limit: number,
  rangeCutoff: Date | null,
  before: Date | null,
): BrainCallsWindow {
  const calls: CriticCall[] = [];
  let hasMore = false;
  for (let i = lines.length - 1; i >= 0; i--) {
    const call = parseLine(lines[i] as string);
    if (!call) continue;
    const t = Date.parse(call.timestamp);
    if (Number.isNaN(t)) continue;
    if (before !== null && t >= before.getTime()) continue;
    if (rangeCutoff !== null && t < rangeCutoff.getTime()) break;
    if (calls.length >= limit) {
      // One more passing row exists beyond the full window — the peek.
      hasMore = true;
      break;
    }
    calls.push(call);
  }
  return { calls, hasMore };
}

export async function readBrainCalls(
  basePath: string,
  limit = 50,
  opts: BrainCallsWindowOpts = {},
): Promise<BrainCallsWindow> {
  const path = join(basePath, "brain-calls.jsonl");
  if (!existsSync(path)) return { calls: [], hasMore: false };
  const raw = await readFile(path, "utf8");
  const lines = raw.split("\n").filter((l) => l.length > 0);
  const rangeCutoff = opts.rangeCutoff ?? null;
  const before = opts.before ?? null;
  return rangeCutoff === null && before === null
    ? readTailWindow(lines, limit)
    : scanBoundedWindow(lines, limit, rangeCutoff, before);
}

/**
 * Best-effort load of v2 sidecar data for fired calls. Mutates
 * `calls[i].v2` in place. Only runs for `fired` calls (skipped entries
 * never produce a critique file). Bounded to the filtered set.
 * Silently ignores any load failure.
 */
async function attachV2Sidecars(basePath: string, calls: CriticCall[]): Promise<void> {
  // v2 sidecars are written to `stateBase` which is `${cwd}/.siltpoke` when cwd
  // is known, falling back to homeBase (the basePath passed in here).
  // Bug 1 fix: use critique_id (exact lookup) when available; only fall back to
  // session_id scan for legacy entries that predate the per-row critique_id write.
  // For old entries without critique_id, load nothing rather than the wrong sidecar.
  await Promise.all(
    calls
      .filter((c) => c.status === "fired")
      .map(async (c) => {
        // Exact ID lookup — fast and unambiguous.
        if (c.critique_id) {
          if (c.cwd) {
            const projectLocal = join(c.cwd, ".siltpoke");
            const v2 = await loadV2Sidecar(c.critique_id, null, projectLocal);
            if (v2) {
              c.v2 = v2;
              return;
            }
          }
          c.v2 = await loadV2Sidecar(c.critique_id, null, basePath);
          return;
        }
        // Legacy entry: no critique_id — skip sidecar to avoid wrong mapping.
      }),
  );
}

/**
 * Best-effort read of diff snapshot files referenced by calls. Mutates
 * `calls[i].diff_text` in place. Capped per-file at 32KB.
 */
async function attachDiffTexts(basePath: string, calls: CriticCall[]): Promise<void> {
  // 512KB to match writeCriticSnapshot disk cap. Was 32KB which truncated
  // multi-file diffs mid-block → /history showed "5 files" for what Haiku
  // saw as 15. With raised cap + boundary-aware truncation on write, the
  // reader can surface the full disk content unless extremely large.
  const MAX_BYTES = 512 * 1024;
  const dir = join(basePath, "critic-snapshots");
  await Promise.all(
    calls.map(async (c) => {
      if (!c.diff_snapshot_id) return;
      const filePath = join(dir, c.diff_snapshot_id);
      if (!existsSync(filePath)) return;
      try {
        const raw = await readFile(filePath, "utf8");
        // Aligned truncation on read: cut at last `diff --git` boundary so
        // the file-list parser doesn't fragment a half-file block.
        if (raw.length <= MAX_BYTES) {
          c.diff_text = raw;
        } else {
          const window = raw.slice(0, MAX_BYTES);
          const lastBoundary = window.lastIndexOf("\ndiff --git ");
          c.diff_text = lastBoundary > 0
            ? `${window.slice(0, lastBoundary)}\n--- truncated: more files in original snapshot ---\n`
            : `${window}\n--- truncated ---\n`;
        }
      } catch {
        // ignore — diff_text stays null
      }
    }),
  );
}

export function buildBreakdown(calls: CriticCall[]): SkipBreakdown {
  const counts: Record<string, number> = {};
  for (const c of calls) {
    const key = c.status === "fired" ? "FIRED" : c.skip_reason ?? "unknown";
    counts[key] = (counts[key] ?? 0) + 1;
  }
  return { counts, total: calls.length };
}

export function buildActionStats(calls: CriticCall[]): UserActionStats {
  let acked = 0;
  let dismissed = 0;
  let untouched = 0;
  let total = 0;
  for (const c of calls) {
    if (c.status !== "fired") continue;
    total++;
    if (c.user_action === "acked") acked++;
    else if (c.user_action === "dismissed") dismissed++;
    else untouched++;
  }
  return { acked, dismissed, untouched_fired: untouched, total_fired: total };
}

/**
 * Filter-contextual token/cost sums. Runs over the FILTERED window,
 * same as buildBreakdown/buildActionStats. Skipped rows carry `tokens: null`;
 * legacy usage-less FIRED rows carry a ZEROED tokens object with
 * `cost_usd: null` (parse defaults `raw.usage ?? {}` fields to 0) — either
 * way the row contributes 0, never NaN.
 * Raw sums; display rounding is the UI's concern.
 */
export function buildTotals(calls: CriticCall[]): TelemetryTotals {
  let tokens = 0;
  let cost = 0;
  for (const c of calls) {
    if (c.tokens) {
      tokens +=
        c.tokens.input + c.tokens.output + c.tokens.cache_read + c.tokens.cache_create;
    }
    if (typeof c.cost_usd === "number" && Number.isFinite(c.cost_usd)) {
      cost += c.cost_usd;
    }
  }
  return { tokens, cost_usd: cost };
}

async function readRollup(basePath: string): Promise<DailyRollup | null> {
  const path = join(basePath, "usage.json");
  if (!existsSync(path)) return null;
  try {
    const raw = await readFile(path, "utf8");
    return JSON.parse(raw) as DailyRollup;
  } catch {
    return null;
  }
}

export function computeGateState(
  budget: BudgetDecision,
  budgetConfig: BudgetConfig,
  quietConfig: QuietHoursConfig,
  now: Date,
): CriticGateState {
  const checks: CriticGateState["checks"] = [];

  const inQuiet = isQuietHour(now, quietConfig);
  checks.push({
    name: "quiet hours",
    pass: !inQuiet,
    detail: inQuiet
      ? `In quiet window ${quietConfig.start}–${quietConfig.end}`
      : quietConfig.start === null || quietConfig.end === null
        ? "Not configured (always pass)"
        : `Outside ${quietConfig.start}–${quietConfig.end}`,
  });

  const budgetPass = budget.stage === "ok";
  checks.push({
    name: "budget",
    pass: budgetPass,
    detail: `${budget.used_pct.toFixed(1)}% used (soft ${budgetConfig.softWarnAtPercent}% / hard ${budgetConfig.hardStopAtPercent}%) — stage: ${budget.stage}`,
  });

  const firstFail = checks.find((c) => !c.pass);
  return {
    blocking: firstFail?.name ?? null,
    detail: firstFail?.detail ?? "All gates open — critic should fire on next Stop hook.",
    checks,
  };
}

interface UserActionEntry {
  session_id: string;
  timestamp: string;
  action: "dismiss" | "ack" | "clear";
  at: string;
}

/**
 * Read append-only critic-actions.jsonl. Returns a map keyed by
 * "session_id|timestamp" → latest UserAction. Tolerates missing/malformed
 * file. Last-write-wins per (session,ts) pair.
 */
export async function readUserActions(
  basePath: string,
): Promise<Map<string, UserAction>> {
  const map = new Map<string, UserAction>();
  const path = join(basePath, "critic-actions.jsonl");
  if (!existsSync(path)) return map;
  const raw = await readFile(path, "utf8");
  for (const line of raw.split("\n")) {
    if (!line) continue;
    try {
      const e = JSON.parse(line) as UserActionEntry;
      if (typeof e.session_id !== "string" || typeof e.timestamp !== "string") continue;
      if (e.action !== "dismiss" && e.action !== "ack" && e.action !== "clear") continue;
      const key = `${e.session_id}|${e.timestamp}`;
      if (e.action === "clear") {
        map.delete(key);
      } else {
        map.set(key, e.action === "dismiss" ? "dismissed" : "acked");
      }
    } catch {
      // skip malformed
    }
  }
  return map;
}

function attachUserActions(calls: CriticCall[], map: Map<string, UserAction>): void {
  for (const c of calls) {
    const key = `${c.session_id}|${c.timestamp}`;
    const a = map.get(key);
    if (a) c.user_action = a;
  }
}

function rangeStart(now: Date, range: TimeRange): Date | null {
  if (range === "all") return null;
  if (range === "today") {
    const d = new Date(now);
    d.setUTCHours(0, 0, 0, 0);
    return d;
  }
  const days = range === "7d" ? 7 : 30;
  return new Date(now.getTime() - days * 24 * 60 * 60 * 1000);
}

function applyFilters(
  calls: CriticCall[],
  opts: {
    status: StatusFilter | null;
    kind: SpeechKind | null;
    range: TimeRange;
    query: string | null;
    now: Date;
  },
): CriticCall[] {
  const { status, kind, query, now, range } = opts;
  const cutoff = rangeStart(now, range);
  const f: RowFilterOpts = {
    status,
    kind,
    cutoffMs: cutoff ? cutoff.getTime() : null,
    q: query ? query.toLowerCase() : null,
  };
  return calls.filter((c) => matchesRowFilters(c, f));
}

/** Common shape both window assemblies feed into the telemetry result. */
interface AssembledWindow {
  recent: CriticCall[];
  projects: string[];
  hasMore: boolean;
  hasNewer: boolean;
  totalInRange: number | null;
  windowOldestTs: string | null;
  windowNewestTs: string | null;
}

/**
 * Turn window assembly: every filter already applied IN the scan — the
 * page IS the rendered set; pager anchors come from the page edges.
 */
function assembleTurnsWindow(
  page: BrainCallsPage,
  activeSort: SortOrder,
  actionsMap: Map<string, UserAction>,
): AssembledWindow {
  const recent = [...page.calls]; // chronological
  const windowOldestTs = recent[0]?.timestamp ?? null;
  const windowNewestTs = recent[recent.length - 1]?.timestamp ?? null;
  if (activeSort !== "oldest") recent.reverse(); // newest-first render default
  attachUserActions(recent, actionsMap);
  return {
    recent,
    projects: page.projects,
    hasMore: page.hasOlder,
    hasNewer: page.hasNewer,
    totalInRange: page.total,
    windowOldestTs,
    windowNewestTs,
  };
}

/**
 * Legacy line-window assembly — byte-identical to the pre-pagination
 * behavior (the Home feed caller relies on it): filters apply AFTER the
 * raw window; the older anchor comes from the RAW window's oldest row
 * (pre-filter) so pagination stays monotonic and remains reachable when
 * post-window filters hide every row of a window.
 */
function assembleLinesWindow(
  window: BrainCallsWindow,
  actionsMap: Map<string, UserAction>,
  f: {
    activeProject: string | null;
    activeStatus: StatusFilter | null;
    activeKind: SpeechKind | null;
    activeRange: TimeRange;
    activeQuery: string | null;
    activeSort: SortOrder;
    now: Date;
  },
): AssembledWindow {
  const allCallsRaw = window.calls;
  const windowOldestTs = allCallsRaw[allCallsRaw.length - 1]?.timestamp ?? null;

  // Fired rows with no bubble (empty string, missing field,
  // or write-side bubble_suppressed — all parsed to bubble_short === null)
  // are not activity — filter them out of history at the assembly layer so
  // legacy "(no bubble)" rows disappear. Skipped rows pass through.
  const allCalls = allCallsRaw.filter(isDisplayEligible);

  attachUserActions(allCalls, actionsMap);

  // Distinct project list across the full window (before filter).
  const projects = Array.from(new Set(allCalls.map((c) => c.project))).sort();

  // Project filter first (chip-driven), then status/kind/range/query.
  const projectFiltered =
    f.activeProject && projects.includes(f.activeProject)
      ? allCalls.filter((c) => c.project === f.activeProject)
      : allCalls;
  const recent = applyFilters(projectFiltered, {
    status: f.activeStatus,
    kind: f.activeKind,
    range: f.activeRange,
    query: f.activeQuery,
    now: f.now,
  });

  // readBrainCalls returns newest-first by file order; flip on request.
  if (f.activeSort === "oldest") {
    recent.reverse();
  }
  return {
    recent,
    projects,
    hasMore: window.hasMore,
    hasNewer: false,
    totalInRange: null,
    windowOldestTs,
    windowNewestTs: null,
  };
}

export async function readCriticTelemetry(
  basePath: string,
  now: Date = new Date(),
  opts: ReadTelemetryOpts = {},
): Promise<CriticTelemetry> {
  const limit = opts.limit ?? 200;
  const activeProject = opts.project ?? null;
  const activeStatus = opts.status ?? null;
  const activeKind = opts.kind ?? null;
  const activeRange: TimeRange = opts.range ?? "all";
  const rawQuery = typeof opts.query === "string" ? opts.query.trim() : "";
  const activeQuery = rawQuery.length > 0 ? rawQuery : null;
  const activeSort: SortOrder = opts.sort ?? "newest";
  const before = opts.before ?? null;
  const after = opts.after ?? null;
  const turnsMode = opts.windowMode === "turns";
  // Range lower bound computed BEFORE the read so the window itself is
  // range-passing. applyFilters keeps its own range check — rows
  // already satisfy it, so it stays a harmless single source of truth.
  const rangeCutoff = rangeStart(now, activeRange);

  const [callsWindow, pageWindow, rollup, budgetConfig, triggerConfig, quietConfig, actionsMap, preferenceStats] =
    await Promise.all([
      turnsMode
        ? Promise.resolve(null)
        : readBrainCalls(basePath, limit, { rangeCutoff, before }),
      turnsMode
        ? readBrainCallsPage(basePath, {
            limit,
            rangeCutoff,
            before,
            after,
            anchor: activeSort === "oldest" ? "oldest" : "newest",
            status: activeStatus,
            kind: activeKind,
            query: activeQuery,
            project: activeProject,
          })
        : Promise.resolve(null),
      readRollup(basePath),
      loadBudgetConfig(basePath),
      loadTriggerConfig(basePath),
      loadQuietHoursConfig(basePath),
      readUserActions(basePath),
      aggregatePreferenceStats({ path: join(basePath, "preference-log.jsonl"), days: 30 }).catch(() => null),
    ]);

  const { recent, projects, hasMore, hasNewer, totalInRange, windowOldestTs, windowNewestTs } =
    pageWindow
      ? assembleTurnsWindow(pageWindow, activeSort, actionsMap)
      : assembleLinesWindow(callsWindow as BrainCallsWindow, actionsMap, {
          activeProject,
          activeStatus,
          activeKind,
          activeRange,
          activeQuery,
          activeSort,
          now,
        });

  // Best-effort: attach v2 sidecar data + (optionally) diff_text bodies.
  // Diff bodies are skipped by default for list views — they balloon the SSR
  // HTML (hundreds of KB per row). Detail / API routes that need a single
  // call's diff should pass attachDiffText: true OR load it on demand via
  // /api/critique/:critique_id/diff.
  const wantDiffs = opts.attachDiffText ?? false;
  await Promise.all([
    wantDiffs ? attachDiffTexts(basePath, recent) : Promise.resolve(),
    attachV2Sidecars(basePath, recent),
  ]);

  const budgetDecision = rollup
    ? evaluateBudget(rollup, budgetConfig)
    : { stage: "ok" as const, used_pct: 0, remaining_tokens: budgetConfig.dailyTokenLimit };

  const breakdown = buildBreakdown(recent);
  const actionStats = buildActionStats(recent);
  const totals = buildTotals(recent);
  const gateState = computeGateState(budgetDecision, budgetConfig, quietConfig, now);

  const homeBasename = opts.homeDir
    ? (opts.homeDir.split("/").filter((p) => p.length > 0).pop() ?? null)
    : null;

  return {
    recent,
    breakdown,
    budget: {
      ...budgetDecision,
      config: budgetConfig,
      rollup,
    },
    triggerConfig,
    quietConfig,
    gateState,
    projects,
    activeProject,
    activeStatus,
    activeKind,
    activeRange,
    activeSort,
    activeQuery,
    actionStats,
    totals,
    preferenceStats,
    homeBasename,
    hasMore,
    hasNewer,
    totalInRange,
    windowOldestTs,
    windowNewestTs,
  };
}
