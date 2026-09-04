// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
// Copyright (c) 2026 Jiaqi Duan
/**
 * critic-event-log — JSONL line parsers.
 *
 * Pure parsing from raw `brain-calls.jsonl` line objects into typed
 * `CriticCall`. Peeled out of critic-event-log.ts (file split).
 *
 * Tolerant of malformed entries: returns null when required fields are
 * missing; coerces unknown shapes through narrow type guards.
 */
import type { EvidenceLabel } from "../critic/evidence-guard";
import { type AuditAbsenceKind, classifyAuditAbsence } from "./audit-absence";
import {
  classifySpeechKind,
  type CriticCall,
  type CriticEvidence,
} from "./critic-event-log-types";

interface RawCall {
  timestamp?: unknown;
  session_id?: unknown;
  cwd?: unknown;
  skipped?: unknown;
  turns_included?: unknown;
  duration_ms?: unknown;
  gating_decision?: unknown;
  diff_snapshot_id?: unknown;
  diff_summary?: unknown;
  timing?: unknown;
  summary_error?: unknown;
  error_message?: unknown;
  critic_path_decision?: unknown;
  /** Legacy key for critic_path_decision — still read from older log lines. */
  m112_decision?: unknown;
  m112_accepted?: unknown;
  /** Why the run was suppressed (HARD_SUPPRESS path). */
  m112_reason?: unknown;
  /** HISTORICAL. Why the evidence guard rejected an otherwise-successful review. */
  m112_guard_reason?: unknown;
  /** How much of an accepted review's evidence was confirmed (`EvidenceLabel`). */
  m112_evidence_label?: unknown;
  /** How many cited items were dropped as unverifiable. */
  m112_evidence_unverified?: unknown;
  m112_diff_shown?: unknown;
  m112_diff_total?: unknown;
  bubble_suppressed?: unknown;
  critique_id?: unknown;
  brain_output?: {
    bubble_short?: unknown;
    bubble_long?: unknown;
    critique_for_claude?: unknown;
    severity?: unknown;
    confidence?: unknown;
    evidence?: unknown;
    reasoning?: unknown;
  };
  usage?: {
    input_tokens?: unknown;
    output_tokens?: unknown;
    cache_read_input_tokens?: unknown;
    cache_creation_input_tokens?: unknown;
    total_cost_usd?: unknown;
  };
  /** Track #7 T3 (AC7) — absent on every historical row. */
  provider?: unknown;
  billing?: unknown;
  model?: unknown;
  authorFamily?: unknown;
  /** Menu-bar-pet T1 — absent on every historical row and on skip rows. */
  branch?: unknown;
  /**
   * The user's own words for this turn, and the agent's opening reply.
   * Written onto the row since 2026-08-19; before that they existed only in
   * the v2 sidecar, i.e. on 3% of rows. Absent on every row older than that.
   */
  user_raw_query?: unknown;
  user_raw_query_truncated?: unknown;
  agent_reply?: unknown;
}

/**
 * Provider/billing/model with the historical-row-compatible default
 * (absent ⇒ claude/usd/null) — every row written before track #7 reads
 * this way, and it stays true for post-track rows this file doesn't
 * otherwise touch (plain skips never made a Brain call).
 */
function parseProviderFields(
  raw: RawCall,
): { provider: string; billing: "usd" | "quota"; model: string | null; authorFamily: string } {
  return {
    provider: typeof raw.provider === "string" ? raw.provider : "claude",
    billing: raw.billing === "quota" ? "quota" : "usd",
    model: typeof raw.model === "string" ? raw.model : null,
    authorFamily: typeof raw.authorFamily === "string" ? raw.authorFamily : "claude",
  };
}

/**
 * Menu-bar-pet T1 — branch is only ever present on fired rows written after
 * this field landed; absent ⇒ null (historical rows + skip rows, matching
 * the provider-field precedent above).
 */
function parseBranch(raw: RawCall): string | null {
  return typeof raw.branch === "string" && raw.branch.length > 0
    ? raw.branch
    : null;
}

/**
 * The user's own words + the agent's opening reply, off the ROW.
 *
 * Absent ⇒ null, the same historical-row posture as `provider`/`branch` above.
 * An empty string is also null: `captureIntent` never emits one, so an empty
 * value means a malformed row, and rendering it would print a blank box where
 * the page promises a verbatim quote.
 */
function parseCapturedIntent(
  raw: RawCall,
): { user_raw_query: string | null; user_raw_query_truncated: boolean; agent_reply: string | null } {
  const q = typeof raw.user_raw_query === "string" && raw.user_raw_query.length > 0
    ? raw.user_raw_query
    : null;
  return {
    user_raw_query: q,
    // Only meaningful alongside a query — a truncation flag on an absent quote
    // would claim something was cut when nothing was recorded at all.
    user_raw_query_truncated: q !== null && raw.user_raw_query_truncated === true,
    agent_reply: typeof raw.agent_reply === "string" && raw.agent_reply.length > 0
      ? raw.agent_reply
      : null,
  };
}

function parseTiming(raw: unknown): CriticCall["timing"] {
  if (typeof raw !== "object" || raw === null) return null;
  const r = raw as Record<string, unknown>;
  const num = (v: unknown): number =>
    typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : 0;
  // Only count a timing record when at least one field is positive.
  const summary_ms = num(r.summary_ms);
  const critic_ms = num(r.critic_ms);
  const wall_ms = num(r.wall_ms);
  if (summary_ms === 0 && critic_ms === 0 && wall_ms === 0) return null;
  return { summary_ms, critic_ms, wall_ms };
}

function parseDiffSummary(raw: unknown): CriticCall["diff_summary"] {
  if (typeof raw !== "object" || raw === null) return null;
  const r = raw as Record<string, unknown>;
  const intent = typeof r.intent === "string" ? r.intent : null;
  if (intent === null) return null;
  const strArr = (v: unknown): string[] =>
    Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
  const filesRaw = Array.isArray(r.files_with_purpose) ? r.files_with_purpose : [];
  const files = filesRaw
    .filter((f): f is { path: unknown; purpose: unknown } => typeof f === "object" && f !== null)
    .filter((f) => typeof f.path === "string" && typeof f.purpose === "string")
    .map((f) => ({ path: f.path as string, purpose: f.purpose as string }));
  const fileCount =
    typeof r.file_count === "number" && Number.isFinite(r.file_count) && r.file_count >= 0
      ? Math.floor(r.file_count)
      : files.length;
  const source: "haiku" | "heuristic" =
    r.source === "heuristic" ? "heuristic" : "haiku";
  // Truncation counts. Records written before this field existed simply have no
  // key, which reads the same as "nothing was dropped".
  const posInt = (v: unknown): number | undefined =>
    typeof v === "number" && Number.isFinite(v) && v > 0 ? Math.floor(v) : undefined;
  let truncated: NonNullable<CriticCall["diff_summary"]>["truncated"];
  if (typeof r.truncated === "object" && r.truncated !== null) {
    const t = r.truncated as Record<string, unknown>;
    const entries = {
      key_changes: posInt(t.key_changes),
      risks: posInt(t.risks),
      files_with_purpose: posInt(t.files_with_purpose),
    };
    // Only attach when at least one count survived, so an empty or all-junk
    // object never renders as "something was truncated".
    if (Object.values(entries).some((v) => v !== undefined)) truncated = entries;
  }
  return {
    intent,
    key_changes: strArr(r.key_changes),
    risks: strArr(r.risks),
    file_count: fileCount,
    files_with_purpose: files,
    source,
    ...(truncated ? { truncated } : {}),
  };
}

function deriveProject(cwd: string | null): string {
  if (!cwd) return "(unknown)";
  const parts = cwd.split("/").filter((p) => p.length > 0);
  return parts[parts.length - 1] ?? cwd;
}

/**
 * Parse one raw JSONL line into a typed CriticCall. Returns null when the
 * line is missing required fields (timestamp / session_id) — caller skips.
 */
/**
 * One place that reads the absence fields off a raw row, so the three
 * `CriticCall` construction sites below cannot drift apart on it.
 *
 * `skipped` is passed explicitly rather than re-derived: a skip has no critique
 * to explain, and letting it fall through to `unrecorded` would make a skip
 * from seconds ago claim to pre-date the wiring — the exact defect this field
 * was added to remove.
 */
function absenceOf(raw: RawCall, skipped: boolean): AuditAbsenceKind {
  return classifyAuditAbsence({
    accepted: raw.m112_accepted,
    reason: raw.m112_reason,
    guardReason: raw.m112_guard_reason,
    critiqueId: typeof raw.critique_id === "string" && raw.critique_id !== "" ? raw.critique_id : null,
    skipped,
  });
}

/**
 * The row's recorded evidence label, or null when it has none.
 *
 * A closed-set check rather than a cast: the value reaches an `EvidenceLabel`
 * slot that `EvidenceMark` switches on, and a hand-edited or future-build row
 * carrying an unknown string must read as "nobody recorded an answer" rather
 * than as a label nothing knows how to render.
 */
const EVIDENCE_LABELS: ReadonlySet<string> = new Set([
  "not_checked",
  "verified",
  "no_evidence",
  "partly_unverified",
  "none_verified",
]);

function evidenceLabelOf(raw: RawCall): EvidenceLabel | null {
  const v = raw.m112_evidence_label;
  return typeof v === "string" && EVIDENCE_LABELS.has(v) ? (v as EvidenceLabel) : null;
}

/**
 * How many cited items the evidence check dropped on this row.
 *
 * Absent ⇒ 0, and that is a fact about the row rather than a convenient
 * default: a row without this key was written before the check started
 * labelling, and back then a review with an unverifiable citation was not
 * written at all. So "no key" really does mean "nothing was dropped from what
 * you are looking at".
 */
function unverifiedCountOf(raw: RawCall): number {
  const v = raw.m112_evidence_unverified;
  return typeof v === "number" && Number.isFinite(v) && v > 0 ? Math.floor(v) : 0;
}

/**
 * How much of the diff a review was shown, or `null`.
 *
 * Absent ⇒ null, and unlike the counter above that is NOT a fact — a row
 * without these keys either had a diff that fitted, or predates the writer.
 * The two are indistinguishable from the row, so the surfaces say nothing
 * rather than claiming full coverage. Both halves must be present and sane
 * (`0 < shown < total`) or the pair is discarded: a partial figure is worse
 * than none, since "20 of ?" reads as a rendering bug and "? of 91" invites
 * the reader to assume the missing half.
 */
function diffCoverageOf(raw: RawCall): { shown: number; total: number } | null {
  const s = raw.m112_diff_shown;
  const t = raw.m112_diff_total;
  if (typeof s !== "number" || typeof t !== "number") return null;
  if (!Number.isFinite(s) || !Number.isFinite(t)) return null;
  const shown = Math.floor(s);
  const total = Math.floor(t);
  if (shown <= 0 || total <= shown) return null;
  return { shown, total };
}

export function parseCall(rawIn: unknown): CriticCall | null {
  if (typeof rawIn !== "object" || rawIn === null) return null;
  const raw = rawIn as RawCall;
  const ts = typeof raw.timestamp === "string" ? raw.timestamp : null;
  const sid = typeof raw.session_id === "string" ? raw.session_id : null;
  if (!ts || !sid) return null;
  const skipReason = typeof raw.skipped === "string" ? raw.skipped : null;
  const cwd = typeof raw.cwd === "string" ? raw.cwd : null;
  const project = deriveProject(cwd);

  const critiqueId = typeof raw.critique_id === "string" && raw.critique_id.length > 0
    ? raw.critique_id
    : null;

  if (skipReason !== null) {
    return {
      timestamp: ts,
      session_id: sid,
      cwd,
      project,
      status: "skipped",
      skip_reason: skipReason,
      audit_absence: absenceOf(raw, true),
      evidence_label: evidenceLabelOf(raw),
      evidence_unverified: unverifiedCountOf(raw),
      diff_shown: diffCoverageOf(raw)?.shown ?? null,
      diff_total: diffCoverageOf(raw)?.total ?? null,
      ...parseCapturedIntent(raw),
      critique_id: null,
      bubble_short: null,
      bubble_long: null,
      critique_for_claude: null,
      severity: null,
      confidence: null,
      evidence: [],
      gating_decision: null,
      turns_included: null,
      duration_ms: null,
      cost_usd: null,
      tokens: null,
      diff_snapshot_id: null,
      diff_text: null,
      diff_summary: null,
      user_action: null,
      speech_kind: null,
      reasoning: null,
      timing: parseTiming(raw.timing),
      summary_error: typeof raw.summary_error === "string" ? raw.summary_error : null,
      error_message: null,
      v2: null, // filled by attachV2Sidecars
      branch: parseBranch(raw),
      ...parseProviderFields(raw),
    };
  }

  // Brain-failure rows: handle-stop's catch paths write bare
  // `{ timestamp, session_id, duration_ms, error_message }` lines (no
  // `skipped`, no `brain_output`). Before the errors filter existed these
  // fell through to the fired branch as bubble-less rows and were dropped
  // by the assembly-layer no-bubble filter — invisible. Parse them as
  // skipped/brain_error so they render via the existing skip-row path and
  // the `status=errors` filter can select them by error_message.
  const errorMessage =
    typeof raw.error_message === "string" && raw.error_message.length > 0
      ? raw.error_message
      : null;
  if (errorMessage !== null) {
    return {
      timestamp: ts,
      session_id: sid,
      cwd,
      project,
      status: "skipped",
      skip_reason: "brain_error",
      audit_absence: absenceOf(raw, false),
      evidence_label: evidenceLabelOf(raw),
      evidence_unverified: unverifiedCountOf(raw),
      diff_shown: diffCoverageOf(raw)?.shown ?? null,
      diff_total: diffCoverageOf(raw)?.total ?? null,
      ...parseCapturedIntent(raw),
      critique_id: critiqueId,
      bubble_short: null,
      bubble_long: null,
      critique_for_claude: null,
      severity: null,
      confidence: null,
      evidence: [],
      gating_decision: null,
      turns_included: null,
      duration_ms: typeof raw.duration_ms === "number" ? raw.duration_ms : null,
      cost_usd: null,
      tokens: null,
      diff_snapshot_id: null,
      diff_text: null,
      diff_summary: null,
      user_action: null,
      speech_kind: null,
      reasoning: null,
      timing: parseTiming(raw.timing),
      summary_error: typeof raw.summary_error === "string" ? raw.summary_error : null,
      error_message: errorMessage,
      v2: null, // filled by attachV2Sidecars
      branch: parseBranch(raw),
      ...parseProviderFields(raw),
    };
  }

  const bo = raw.brain_output ?? {};
  const u = raw.usage ?? {};
  const num = (v: unknown): number =>
    typeof v === "number" && Number.isFinite(v) ? v : 0;
  const strOrNull = (v: unknown): string | null =>
    typeof v === "string" && v.length > 0 ? v : null;
  const evidenceArr: CriticEvidence[] = Array.isArray(bo.evidence)
    ? (bo.evidence as CriticEvidence[])
    : [];

  return {
    timestamp: ts,
    session_id: sid,
    cwd,
    project,
    status: "fired",
    skip_reason: null,
    critique_id: critiqueId,
    // Write-side suppression keeps the original bubble text in
    // brain_output for audit but flags the line; parse it as bubble-less so
    // the assembly-layer no-bubble filter hides the row.
    bubble_short:
      raw.bubble_suppressed === true ? null : strOrNull(bo.bubble_short),
    bubble_long: strOrNull(bo.bubble_long),
    critique_for_claude: strOrNull(bo.critique_for_claude),
    severity: typeof bo.severity === "string" ? bo.severity : null,
    confidence: typeof bo.confidence === "string" ? bo.confidence : null,
    evidence: evidenceArr,
    audit_absence: absenceOf(raw, false),
    evidence_label: evidenceLabelOf(raw),
    evidence_unverified: unverifiedCountOf(raw),
    diff_shown: diffCoverageOf(raw)?.shown ?? null,
    diff_total: diffCoverageOf(raw)?.total ?? null,
    ...parseCapturedIntent(raw),
    gating_decision:
      (typeof raw.critic_path_decision === "string" && raw.critic_path_decision) ||
      // legacy key written by pre-rename log lines
      (typeof raw.m112_decision === "string" && raw.m112_decision) ||
      (typeof raw.gating_decision === "string" ? raw.gating_decision : null),
    turns_included:
      typeof raw.turns_included === "number" ? raw.turns_included : null,
    duration_ms:
      typeof raw.duration_ms === "number" ? raw.duration_ms : null,
    cost_usd: typeof u.total_cost_usd === "number" ? u.total_cost_usd : null,
    tokens: {
      input: num(u.input_tokens),
      output: num(u.output_tokens),
      cache_read: num(u.cache_read_input_tokens),
      cache_create: num(u.cache_creation_input_tokens),
    },
    diff_snapshot_id:
      typeof raw.diff_snapshot_id === "string" ? raw.diff_snapshot_id : null,
    diff_text: null,  // filled by reader if file exists
    diff_summary: parseDiffSummary(raw.diff_summary),
    user_action: null, // filled by attachUserActions
    speech_kind: classifySpeechKind(
      "fired",
      typeof bo.severity === "string" ? bo.severity : null,
      strOrNull(bo.critique_for_claude),
    ),
    reasoning: strOrNull(bo.reasoning),
    timing: parseTiming(raw.timing),
    summary_error: typeof raw.summary_error === "string" ? raw.summary_error : null,
    error_message: null,
    v2: null, // filled by attachV2Sidecars
    branch: parseBranch(raw),
    ...parseProviderFields(raw),
  };
}
