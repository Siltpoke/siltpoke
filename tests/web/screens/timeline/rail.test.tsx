/** @jsxImportSource hono/jsx */
/**
 * rail.test.tsx — the left rail's per-row builder-family tag (Brain select v2 T6).
 *
 * The `built·<family>` provenance chip already lives in the detail pane; the
 * rail rows carried none, so the run list could not be scanned by family. This
 * adds a compact colored family tag to each fired row.
 */
import { describe, expect, test } from "bun:test";
import type { CriticCall, CriticTelemetry } from "../../../../src/state/critic-event-log";
import { TimelineRail } from "../../../../src/web/screens/timeline/rail";

const BASE_CALL: CriticCall = {
  timestamp: "2026-07-22T00:00:00.000Z",
  session_id: "sess-rail",
  cwd: "/tmp/project",
  project: "project",
  status: "fired",
  skip_reason: null,
  critique_id: "c-rail",
  bubble_short: "7 files clean",
  bubble_long: null,
  critique_for_claude: "",
  severity: "info",
  confidence: "high",
  evidence: [],
  audit_absence: "unrecorded" as const,
  evidence_label: null,
  evidence_unverified: 0,
  diff_shown: null,
  diff_total: null,
  gating_decision: null,
  turns_included: null,
  duration_ms: 3200,
  cost_usd: 0.0032,
  tokens: null,
  diff_snapshot_id: null,
  diff_text: null,
  diff_summary: null,
  summary_error: null,
  error_message: null,
  user_action: null,
  speech_kind: "comment",
  reasoning: "clean",
  timing: null,
  v2: null,
  provider: "claude",
  authorFamily: "claude",
  billing: "usd",
  model: null,
  branch: null,
  user_raw_query: null,
  user_raw_query_truncated: false,
  agent_reply: null,
};

function railHtml(rows: CriticCall[]): string {
  const telemetry = {
    recent: rows,
    breakdown: { total: 0, counts: {} },
    budget: {
      stage: "ok",
      used_pct: 0,
      remaining_tokens: 1_000_000,
      config: {
        dailyTokenLimit: 1_000_000,
        perCallMaxInputTokens: 100_000,
        softWarnAtPercent: 80,
        hardStopAtPercent: 100,
        softModeOverride: "on_demand",
        resetAtMinutes: 0,
      },
      rollup: null,
    },
    quietConfig: { startMinutes: null, endMinutes: null },
    gateState: { blocking: null, detail: "", checks: [] },
    projects: [],
    activeProject: null,
    activeStatus: null,
    activeKind: null,
    activeRange: "all",
    activeSort: "recent",
    homeBasename: "user",
  } as unknown as CriticTelemetry;
  return String(<TimelineRail telemetry={telemetry} now={new Date("2026-07-22T00:05:00.000Z")} />);
}

describe("TimelineRail — per-row builder-family tag (T6)", () => {
  test("a codebuddy-built row shows a codebuddy tag", () => {
    const html = railHtml([{ ...BASE_CALL, authorFamily: "codebuddy" }]);
    expect(html).toContain("codebuddy");
    expect(html).toContain("built by codebuddy"); // the title tooltip
  });

  test("a codex-built row shows a codex tag", () => {
    expect(railHtml([{ ...BASE_CALL, authorFamily: "codex" }])).toContain("built by codex");
  });

  test("a row with no authorFamily degrades to claude (no crash, quiet default)", () => {
    const html = railHtml([{ ...BASE_CALL, authorFamily: "" as unknown as string }]);
    expect(html).toContain("built by claude");
  });
});

describe("TimelineRail — reviewer tag when cross-family (v2.1 T2)", () => {
  test("a codex-reviewed, claude-built row shows BOTH built·claude and reviewed·codex", () => {
    const html = railHtml([{ ...BASE_CALL, authorFamily: "claude", provider: "codex" }]);
    expect(html).toContain("built by claude");
    expect(html).toContain("reviewed by codex");
  });

  test("a same-family row shows only the built tag (no reviewed tag)", () => {
    const html = railHtml([{ ...BASE_CALL, authorFamily: "codex", provider: "codex" }]);
    expect(html).toContain("built by codex");
    expect(html).not.toContain("reviewed by");
  });

  test("provider 'anthropic' is treated as claude (a plain claude run stays single-tag)", () => {
    const html = railHtml([{ ...BASE_CALL, authorFamily: "claude", provider: "anthropic" }]);
    expect(html).not.toContain("reviewed by");
  });

  test("absent provider degrades (no reviewed tag, no crash)", () => {
    const html = railHtml([{ ...BASE_CALL, authorFamily: "claude", provider: "" as unknown as string }]);
    expect(html).not.toContain("reviewed by");
  });
});
