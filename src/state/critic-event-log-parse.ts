// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
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
  return {
    intent,
    key_changes: strArr(r.key_changes),
    risks: strArr(r.risks),
    file_count: fileCount,
    files_with_purpose: files,
    source,
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
  };
}
