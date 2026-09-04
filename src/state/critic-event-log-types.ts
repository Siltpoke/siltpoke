// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
// Copyright (c) 2026 Jiaqi Duan
/**
 * critic-event-log — type surface.
 *
 * Public types + the `classifySpeechKind` helper (pure, no I/O) peeled out
 * of critic-event-log.ts so the main file stays under the
 * file-length warn threshold.
 */

import type { EvidenceLabel } from "../critic/evidence-guard";
import type { AuditAbsenceKind } from "./audit-absence";
import type { PreferenceStats } from "../preference-log/stats";
import type { BudgetConfig, BudgetDecision } from "./budget-config";
import type { QuietHoursConfig } from "./quiet-hours";
import type { DailyRollup } from "./usage";
import type { V2SidecarData } from "./v2-sidecar";

export type CallStatus = "fired" | "skipped";

/**
 * Status FILTER values — the row statuses plus the synthetic "errors"
 * facet. "errors" is not a third CallStatus: brain-failure rows (the
 * handle-stop catch paths write `error_message` lines) parse as
 * status=skipped / skip_reason="brain_error" so every binary
 * fired-vs-skipped consumer keeps working; the errors filter selects them
 * by `error_message !== null` instead.
 */
export type StatusFilter = CallStatus | "errors";

/**
 * Classify a fired call's speech kind from Brain schema severity + critique presence.
 *
 * Brain schema severity enum (src/brain/schema.ts): info | low | medium | high.
 *
 *  - severity=high                                                → critical
 *  - severity=low|medium  OR  has critique_for_claude             → warning
 *  - else (severity=info, no critique)                            → comment
 *
 * Only meaningful for fired calls; skipped calls return null.
 */
export type SpeechKind = "comment" | "warning" | "critical";
export function classifySpeechKind(
  status: CallStatus,
  severity: string | null,
  critiqueText: string | null,
): SpeechKind | null {
  if (status !== "fired") return null;
  // critiqueText reference avoids unused-var lint; kept on the signature
  // for callers that pass it from older paths.
  void critiqueText;
  const sev = (severity ?? "").toLowerCase();
  if (sev === "high") return "critical";
  if (sev === "medium" || sev === "med") return "warning";
  // low / info / null all fall through to comment — Brain emits "low" as
  // its default for benign critiques, so treating low as warning lights up
  // every happy critique with an amber dot.
  return "comment";
}

/** User action recorded against a brain-call entry. */
export type UserAction = "dismissed" | "acked";

export type TimeRange = "today" | "7d" | "30d" | "all";

export interface CriticEvidence {
  /** Free-form evidence shape from Brain (we don't strictly type it). */
  [k: string]: unknown;
}

export interface CriticCall {
  timestamp: string;
  session_id: string;
  cwd: string | null;
  /** Short folder name derived from cwd basename. "(global)" when null. */
  project: string;
  status: CallStatus;
  skip_reason: string | null;
  bubble_short: string | null;
  /** Brain output bubble_long — longer narrative. null when not fired. */
  bubble_long: string | null;
  /** Brain output critique_for_claude — actionable critique text. */
  critique_for_claude: string | null;
  severity: string | null;
  /** Confidence label: low / medium / high. */
  confidence: string | null;
  /** Brain output evidence array (file/line/snippet refs when present). */
  evidence: CriticEvidence[];
  /** Critic gating decision: NORMAL / PASSIVE_BUBBLE / HARD_SUPPRESS (string from telemetry — high/medium/low in current code). */
  gating_decision: string | null;
  /**
   * WHY this row has no audit trail, derived in code from the row's own
   * `m112_accepted` / `m112_reason` / `m112_guard_reason`.
   *
   * Exists because the timeline used to render one fixed "this review pre-dates
   * pipeline wire OR ran on legacy path" for every absence — including reviews
   * that had run minutes earlier — while the accurate reason sat unread on the
   * same row. See `src/state/audit-absence.ts` and
   * an internal design note §2.4.
   */
  audit_absence: AuditAbsenceKind;
  /**
   * How much of this review's evidence the check could confirm, from
   * `m112_evidence_label`. `null` on every row written before 2026-08-19 and on
   * every row that never reached the check (skips, HARD_SUPPRESS, passive
   * bubbles) — "nobody recorded an answer" and "the answer was `verified`" are
   * different facts and must not collapse.
   *
   * Deliberately NOT folded into `audit_absence`. That union answers "why is
   * the audit trail missing" and is rendered inside empty audit blocks; a value
   * meaning "shown, but two quotes were dropped" would be printed there as the
   * explanation for a rubric checklist with no results. Separate question, separate
   * field, separate component (`EvidenceMark`).
   */
  evidence_label: EvidenceLabel | null;
  /**
   * How many cited items the evidence check dropped as unverifiable on this
   * review. 0 on every row that predates the check labelling instead of
   * deleting (before 2026-08-19 such a review was discarded, so there was no
   * row to put a count on) and on every review whose citations all checked out.
   *
   * `evidence` above holds only the items that DID check out, so the pair
   * reads as "n shown, m dropped" — which is the whole point of carrying the
   * count separately rather than inferring it from an array length.
   */
  evidence_unverified: number;
  /**
   * How much of the changed diff this review was actually shown, as
   * `shown / total` hunks. `null` on every row where the whole diff fitted the
   * budget, and on every row written before 2026-08-20.
   *
   * Counted by siltpoke, NOT declared by the reviewer. The prompt does ask the
   * reviewer to state its coverage in `reasoning`, and nothing verifies that
   * it did — `schema.ts` has `reasoning` optional on the path that runs. A
   * property the surfaces must be able to state cannot rest on the model
   * having complied.
   */
  diff_shown: number | null;
  diff_total: number | null;
  /**
   * The user's own words on the turn this review looked at, and the agent's
   * opening reply — the two fields Block A calls "what I read".
   *
   * On the ROW since 2026-08-19. Before that they were written only into the
   * v2 sidecar, which exists only when a critique is filed: 19 of the 400 most
   * recent fired reviews on a measured store, 4.8% (snapshot
   * `scripts/probes/critic-audit-coverage-probe-output-2026-08-19T19Z.txt` §4).
   * So Block A said "not captured" on the other 95.3%, and — unlike the changed
   * files, which `diff_summary` carries on 93.4% of those rows — there was no
   * other place to read them from. Rows older than the change stay null; that
   * text was never written down.
   *
   * `user_raw_query` is capped at 2000 chars on the row (`handle-stop.ts`),
   * `agent_reply` at 1200 by `captureIntent` itself.
   */
  user_raw_query: string | null;
  /**
   * True when `user_raw_query` hit the row cap. Its own field rather than an
   * ellipsis inside the text: the page labels that text *verbatim*, so a
   * "… (truncated)" tail would be words the user never typed — the same reason
   * `diff_summary.truncated` is kept outside the arrays it describes.
   */
  user_raw_query_truncated: boolean;
  /** Opening paragraph of the agent's reply. See `user_raw_query`. */
  agent_reply: string | null;
  /** turns_included from Stop hook context. */
  turns_included: number | null;
  duration_ms: number | null;
  cost_usd: number | null;
  tokens: {
    input: number;
    output: number;
    cache_read: number;
    cache_create: number;
  } | null;
  /**
   * Cross-family provider truth (track #7 T3, AC7). Every historical row
   * (and every row this track doesn't touch, e.g. plain skips) reads as the
   * defaults below — no migration rewrite.
   */
  provider: string;
  billing: "usd" | "quota";
  /** Served model string. null when not recorded (historical rows, skips). */
  model: string | null;
  /**
   * Builder family (Slice B, T4) — WHICH CLI host built the code this run,
   * from `SILTPOKE_HOST` via brain-config's authorFamily. Persisted first-class
   * and independent of `provider` (the reviewer): if the user overrides the
   * reviewer to a different family, the timeline/swiftbar tag still shows the
   * builder. Historical rows (and rows written before this field) default to
   * "claude", same no-migration posture as `provider`.
   */
  authorFamily: string;
  /**
   * Filename (basename) of the git-diff snapshot captured at fire-time.
   * Resolves to {homeBase}/critic-snapshots/{diff_snapshot_id}. null
   * when no diff was available or the file is missing.
   */
  diff_snapshot_id: string | null;
  /** Raw diff text (capped). null when no snapshot exists. */
  diff_text: string | null;
  /**
   * Haiku diff summary (intent / key changes / risks / files) captured at
   * fire-time. null when summarizer wasn't run (legacy entry) or failed.
   */
  diff_summary: {
    intent: string;
    key_changes: string[];
    risks: string[];
    file_count: number;
    files_with_purpose: Array<{ path: string; purpose: string }>;
    /** "haiku" (LLM) or "heuristic" (TS fallback when Haiku failed). */
    source: "haiku" | "heuristic";
    /**
     * Per-array count of entries dropped to that array's schema cap. Absent when
     * nothing was dropped, and absent on every record written before the field
     * existed.
     *
     * Kept OUT of the arrays deliberately — see `diffSummarySchema.truncated` in
     * `src/critic/tools/run-diff-summary.ts`. A marker entry inside `risks` makes
     * `risks.length` a lie, and this dashboard is one of the readers that would
     * have been lied to.
     */
    truncated?: {
      key_changes?: number;
      risks?: number;
      files_with_purpose?: number;
    };
  } | null;
  /**
   * Error message from the Haiku diff summary call when the fallback
   * heuristic kicked in. null when Haiku succeeded OR no diff to
   * summarize at all.
   */
  summary_error: string | null;
  /**
   * Brain-failure marker: the raw `error_message` written by handle-stop's
   * catch paths when the whole critic turn threw (BrainError / crash).
   * Such rows parse as status=skipped with skip_reason="brain_error".
   * null on every successful (fired or ordinarily-skipped) row.
   */
  error_message: string | null;
  /**
   * Latest user action against this entry (dismissed / acked). Null when
   * the user hasn't touched it. Sourced from `critic-actions.jsonl`.
   */
  user_action: UserAction | null;
  /** Classified speech kind (only set for fired calls). */
  speech_kind: SpeechKind | null;
  /**
   * Brain's reasoning for its severity + critique decisions. English,
   * observability-only — surfaced on /history expand panel so users
   * see why Brain landed where it did.
   */
  reasoning: string | null;
  /** Per-stage latency captured by runCritic. null on older / legacy entries. */
  timing: {
    summary_ms: number;
    critic_ms: number;
    wall_ms: number;
  } | null;
  /**
   * Bug 1 fix: critique_id from brain-calls.jsonl entry. null for legacy
   * entries that pre-date the per-row critique_id write.
   */
  critique_id: string | null;
  /**
   * v2 sidecar data loaded in parallel from the critique archive. null when
   * the critique pre-dates the v2 pipeline or no matching file is found.
   */
  v2: V2SidecarData | null;
  /**
   * Menu-bar-pet T1 — git branch (`git rev-parse --abbrev-ref HEAD` in the
   * session cwd) captured at review time. null for non-git dirs, detached
   * HEAD, and all historical rows (pre-dates this field).
   */
  branch: string | null;
}

export interface SkipBreakdown {
  /** Map of reason → count over the window. "FIRED" is a synthetic key. */
  counts: Record<string, number>;
  /** Total entries in the window. */
  total: number;
}

export interface UserActionStats {
  acked: number;
  dismissed: number;
  /** Number of fired entries with no user action recorded yet. */
  untouched_fired: number;
  /** Total fired entries in the window (acked + dismissed + untouched). */
  total_fired: number;
}

/**
 * Filter-contextual token/cost sums over the FILTERED `recent[]` window.
 * `tokens` = per-row
 * input + output + cache_read + cache_create (same total BlockF renders).
 * Skipped rows carry `tokens: null`; legacy usage-less FIRED rows carry a
 * ZEROED tokens object with `cost_usd: null` — either way a usage-less row
 * contributes 0. Raw sums — display rounding is the UI's job.
 */
export interface TelemetryTotals {
  tokens: number;
  cost_usd: number;
}

export interface CriticGateState {
  /** Which gate name currently blocks. null when all pass. */
  blocking: string | null;
  /** Human-readable detail. */
  detail: string;
  /** Each gate result, in evaluation order. */
  checks: Array<{
    name: string;
    pass: boolean;
    detail: string;
  }>;
}

export interface CriticTelemetry {
  /** Filtered entries (by project), newest first. */
  recent: CriticCall[];
  /** Skip-reason histogram for the same window. */
  breakdown: SkipBreakdown;
  /** Today's budget state. */
  budget: BudgetDecision & {
    config: BudgetConfig;
    rollup: DailyRollup | null;
  };
  /**
   * Quiet-hours config snapshot.
   *
   * `triggerConfig` used to sit beside this and was removed in S5 with
   * `trigger-modes.ts`. It had no reader anywhere in `src/web/` or
   * `src/daemon/` — the three test fixtures that set it were passing
   * `{ mode: "diff" }`, which was never a valid `TriggerMode`, and nothing ever
   * noticed.
   */
  quietConfig: QuietHoursConfig;
  /** Top-down "why is critic silent?" gate diagnostic. */
  gateState: CriticGateState;
  /** Distinct project values found across the read window, sorted alphabetically. */
  projects: string[];
  /** Active project filter — null means all. */
  activeProject: string | null;
  /** Active status filter (fired / skipped / errors) — null means all. */
  activeStatus: StatusFilter | null;
  /** Active speech-kind filter — null means all. */
  activeKind: SpeechKind | null;
  /** Active builder-family filter (Brain select v2) — null/absent means all.
   * Applied at the /timeline route (post-read), not in readCriticTelemetry. */
  activeFamily?: string | null;
  /** Active time-range filter. "all" when not narrowed. */
  activeRange: TimeRange;
  /** Active sort order. */
  activeSort: SortOrder;
  /**
   * Block D — aggregate preference-log stats over the last 30 days plus a
   * per-critique breakdown. Shared across every row so the dashboard
   * surface can show "X ack / Y dismiss" history without re-scanning the
   * log per card. null when the preference-log file is missing.
   */
  preferenceStats: PreferenceStats | null;
  /** Active text query (case-insensitive substring). null/empty means none. */
  activeQuery: string | null;
  /** User-action tally over the filtered window (fired-only). */
  actionStats: UserActionStats;
  /** Token/cost sums over the filtered window (see TelemetryTotals). */
  totals: TelemetryTotals;
  /**
   * Basename of the user's home directory (e.g. "alice").
   * Page uses this to prettify the chip label as "home (~)" so the user
   * sees the semantic name instead of their username.
   */
  homeBasename: string | null;
  /**
   * True when at least one more range-passing row exists in the log beyond
   * (older than) the returned window — drives the older pager anchor.
   */
  hasMore: boolean;
  /**
   * True when more range+predicate-passing rows exist NEWER than the
   * window — drives the newer pager anchor. Always false on the legacy
   * (lines) window path, which only pages backward.
   */
  hasNewer: boolean;
  /**
   * Total range+predicate-passing display-eligible turn count across the
   * WHOLE log (honest-totals summary). null on the legacy (lines) window
   * path, where no full count is taken.
   */
  totalInRange: number | null;
  /**
   * Timestamp of the OLDEST row of the window — the exclusive `before`
   * anchor for the next-older page. Legacy (lines) mode sources it from the
   * raw pre-filter window so pagination stays monotonic when post-window
   * filters hide every row; turns mode sources it from the page itself
   * (page rows ARE the display rows). null when the window is empty.
   */
  windowOldestTs: string | null;
  /**
   * Timestamp of the NEWEST row of the window — the exclusive `after`
   * anchor for the next-newer page. null when the window is empty or on
   * the legacy (lines) path.
   */
  windowNewestTs: string | null;
}

export type SortOrder = "newest" | "oldest";

export interface ReadTelemetryOpts {
  /** Filter to a single project (cwd basename) — null/undefined = all. */
  project?: string | null;
  /** Filter by call status ("errors" = brain-failure rows) — null/undefined = all. */
  status?: StatusFilter | null;
  /** Filter by speech kind (fired calls only) — null/undefined = all. */
  kind?: SpeechKind | null;
  /** Time-range filter. Default "all". */
  range?: TimeRange;
  /** Case-insensitive substring across bubble_short/long/critique. */
  query?: string | null;
  /** Builder-family filter (Brain select v2) — null/undefined = all families. */
  family?: string | null;
  /** Sort order for `recent`. Default "newest" (existing behavior). */
  sort?: SortOrder;
  /** How many entries to load from brain-calls.jsonl (tail). Default 200. */
  limit?: number;
  /**
   * Pagination cursor: exclusive upper bound — only rows strictly
   * older than this instant enter the window. null/undefined = no upper
   * bound. Takes precedence over `after` if both are set.
   */
  before?: Date | null;
  /**
   * Pagination cursor: exclusive lower bound — the window collects FORWARD
   * (toward newer) from rows strictly newer than this instant. Only honored
   * in `windowMode: "turns"`. null/undefined = no lower bound.
   */
  after?: Date | null;
  /**
   * Window accounting mode.
   *   "lines" (default) — `limit` counts raw JSONL lines from the tail /
   *     backward scan; filters apply AFTER the window. Byte-identical to the
   *     pre-pagination behavior; the Home feed caller relies on it.
   *   "turns" — `limit` counts display-eligible rows under ALL active
   *     filters (status/kind/q/project/range + the no-bubble rule); the
   *     window IS the rendered page. Enables after-cursors + totalInRange.
   */
  windowMode?: "lines" | "turns";
  /**
   * Absolute path to the user's home dir (e.g. "/Users/alice").
   * When provided, derives homeBasename for chip-label prettifying.
   */
  homeDir?: string;
  /**
   * When true (default), the diff snapshot file referenced by each fired call
   * is read into `call.diff_text`. Per-row diff bodies can be hundreds of KB
   * and inflate SSR HTML — pass `false` from list views and load per row via
   * /api/critique/:critique_id/diff on demand.
   */
  attachDiffText?: boolean;
}
