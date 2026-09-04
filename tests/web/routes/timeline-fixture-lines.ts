/**
 * brain-calls.jsonl line builders for the /timeline test fixtures — same
 * fixture shape as tests/state/critic-event-log.test.ts.
 *
 * Split from ./timeline-fixtures.ts: this module is
 * PURE (no bun:sqlite / TraceStore import), so the Playwright e2e fixture —
 * which runs under Node, where `bun:` imports fail — can reuse the exact row
 * shape. Bun-side consumers keep importing everything from
 * ./timeline-fixtures, which re-exports this module.
 */

export interface FixtureCall {
  ts: string;
  session: string;
  /** "error" = handle-stop catch-path brain-failure line (error_message). */
  status: "fired" | "skipped" | "error";
  skip_reason?: string;
  /** Only for status "error". Default "BrainError: boom". */
  error_message?: string;
  cwd?: string;
  bubble_short?: string;
  bubble_long?: string;
  critique?: string;
  severity?: "info" | "low" | "medium" | "high";
  critique_id?: string;
  diff_snapshot_id?: string;
  diff_summary?: {
    intent: string;
    key_changes: string[];
    risks: string[];
    file_count: number;
    files_with_purpose: Array<{ path: string; purpose: string }>;
    source: "haiku" | "heuristic";
  };
  cost?: number;
  input_tokens?: number;
  output_tokens?: number;
  omit_usage?: boolean;
  /**
   * `m112_guard_reason` — why the evidence guard refused an otherwise-successful
   * review. HISTORICAL shape: no run since 2026-08-19 writes it, but rows on
   * disk do, and it still drives `CriticCall.audit_absence`.
   */
  guard_reason?: string;
  /**
   * `m112_evidence_label` — how much of an ACCEPTED review's evidence was
   * confirmed. This is the shape a run writes today, and the only way to get
   * the timeline's "unconfirmed" mark to render at the route/e2e level.
   */
  evidence_label?: "verified" | "no_evidence" | "partly_unverified" | "none_verified";
  /** `m112_evidence_unverified` — how many citations were dropped. */
  evidence_unverified?: number;
  /** `m112_reason` — why the run was suppressed. Same purpose as above. */
  suppress_reason?: string;
}

function skippedLine(c: FixtureCall): string {
  return JSON.stringify({
    timestamp: c.ts,
    session_id: c.session,
    cwd: c.cwd ?? "/Users/foo/projA",
    skipped: c.skip_reason ?? "quiet_hours",
  });
}

/** Same shape handle-stop's catch paths write on a brain failure. */
function errorLine(c: FixtureCall): string {
  return JSON.stringify({
    timestamp: c.ts,
    session_id: c.session,
    cwd: c.cwd ?? "/Users/foo/projA",
    duration_ms: 1234,
    m112_path: true,
    error_message: c.error_message ?? "BrainError: boom",
  });
}

function firedLine(c: FixtureCall): string {
  const usage = c.omit_usage
    ? {}
    : {
        usage: {
          input_tokens: c.input_tokens ?? 100,
          output_tokens: c.output_tokens ?? 50,
          cache_read_input_tokens: 0,
          cache_creation_input_tokens: 0,
          total_cost_usd: c.cost ?? 0.001,
        },
      };
  return JSON.stringify({
    timestamp: c.ts,
    session_id: c.session,
    cwd: c.cwd ?? "/Users/foo/projA",
    ...(c.critique_id ? { critique_id: c.critique_id } : {}),
    ...(c.guard_reason ? { m112_guard_reason: c.guard_reason, m112_accepted: false } : {}),
    ...(c.evidence_label
      ? {
          m112_accepted: true,
          m112_evidence_label: c.evidence_label,
          m112_evidence_unverified: c.evidence_unverified ?? 0,
        }
      : {}),
    ...(c.suppress_reason ? { m112_reason: c.suppress_reason } : {}),
    ...(c.diff_snapshot_id ? { diff_snapshot_id: c.diff_snapshot_id } : {}),
    ...(c.diff_summary ? { diff_summary: c.diff_summary } : {}),
    brain_output: {
      bubble_short: c.bubble_short ?? "short bubble",
      bubble_long: c.bubble_long ?? null,
      critique_for_claude: c.critique ?? null,
      severity: c.severity ?? "info",
      confidence: "low",
      evidence: [],
    },
    ...usage,
  });
}

/**
 * Render calls to raw brain-calls.jsonl lines without touching disk.
 */
export function fixtureLines(calls: FixtureCall[]): string[] {
  return calls.map((c) =>
    c.status === "skipped" ? skippedLine(c) : c.status === "error" ? errorLine(c) : firedLine(c),
  );
}
