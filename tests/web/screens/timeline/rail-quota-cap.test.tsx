/** @jsxImportSource hono/jsx */
/**
 * rail-quota-cap.test.tsx — defect [70]: a review skipped because the daily
 * call cap was used up says WHY, when it resumes, and where to change the cap.
 * Before this the row was a bare grey `quota_cap` tag.
 */
import { describe, expect, test } from "bun:test";
import type { CriticCall, CriticTelemetry } from "../../../../src/state/critic-event-log";
import { quotaCapNote } from "../../../../src/web/screens/timeline/quota-cap-note";
import { TimelineRail } from "../../../../src/web/screens/timeline/rail";

const SKIPPED: CriticCall = {
  timestamp: "2026-10-15T10:00:00.000Z",
  session_id: "sess-quota",
  cwd: "/tmp/project",
  project: "project",
  status: "skipped",
  skip_reason: "quota_cap",
  critique_id: null,
  bubble_short: null,
  bubble_long: null,
  critique_for_claude: "",
  severity: null,
  confidence: null,
  evidence: [],
  audit_absence: "unrecorded" as const,
  evidence_label: null,
  evidence_unverified: 0,
  diff_shown: null,
  diff_total: null,
  gating_decision: null,
  turns_included: null,
  duration_ms: null,
  cost_usd: null,
  tokens: null,
  diff_snapshot_id: null,
  diff_text: null,
  diff_summary: null,
  summary_error: null,
  error_message: null,
  user_action: null,
  speech_kind: "comment",
  reasoning: null,
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
} as unknown as CriticCall;

function railHtml(rows: CriticCall[], extra: Record<string, unknown> = {}, resetAtMinutes = 0, nowIso = "2026-10-15T10:05:00.000Z"): string {
  const telemetry = {
    recent: rows,
    breakdown: { total: 0, counts: {} },
    budget: {
      stage: "ok",
      used_pct: 0,
      remaining_tokens: 1_000_000,
      config: { resetAtMinutes },
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
    reviewDailyCap: 50,
    ...extra,
  } as unknown as CriticTelemetry;
  return String(<TimelineRail telemetry={telemetry} now={new Date(nowIso)} />);
}

describe("quotaCapNote", () => {
  test("names the cap, the reset moment and the Settings page", () => {
    const note = quotaCapNote(50, 0);
    expect(note).toContain("50 calls");
    expect(note).toContain("midnight");
    expect(note).toContain("Settings page");
  });

  test("a custom reset time is said as a clock time", () => {
    expect(quotaCapNote(7, 4 * 60 + 30)).toContain("04:30");
  });

  test("a cap that was lifted since says so instead of quoting a number", () => {
    const note = quotaCapNote(0, 0);
    expect(note).not.toContain("0 calls");
    expect(note).toContain("There is no limit set now");
  });
});

describe("TimelineRail — quota_cap skipped row explains itself", () => {
  test("a quota_cap row carries the explanation with the configured cap", () => {
    const html = railHtml([SKIPPED], { reviewDailyCap: 12 });
    expect(html).toContain("12 calls");
    expect(html).toContain("Settings page");
    expect(html).toContain("data-quota-cap-note");
  });

  test("a different skip reason gets NO cap explanation", () => {
    const html = railHtml([{ ...SKIPPED, skip_reason: "quiet_hours" } as CriticCall]);
    expect(html).not.toContain("data-quota-cap-note");
    expect(html).not.toContain("Settings page");
  });

  test("a fired row gets no cap explanation", () => {
    const html = railHtml([{ ...SKIPPED, status: "fired", skip_reason: null, critique_id: "c1" } as CriticCall]);
    expect(html).not.toContain("data-quota-cap-note");
  });

  test("a row from an earlier day gets the neutral sentence: no Today, no paused, no number", () => {
    const html = railHtml([{ ...SKIPPED, timestamp: "2026-10-14T10:00:00.000Z" } as CriticCall], { reviewDailyCap: 12 });
    expect(html).toContain("was reached that day");
    expect(html).toContain("Settings page");
    expect(html).not.toContain("Today&#39;s");
    expect(html).not.toContain("Today's");
    expect(html).not.toContain("paused");
    expect(html).not.toContain("12 calls");
  });

  test("resetAt 04:00: a row at 03:30 is still the PREVIOUS day when it is now 05:00 (neutral)", () => {
    // Local-time instants, so the boundary holds in any timezone.
    const row = new Date(2026, 9, 15, 3, 30).toISOString();
    const nowIso = new Date(2026, 9, 15, 5, 0).toISOString();
    const html = railHtml([{ ...SKIPPED, timestamp: row } as CriticCall], { reviewDailyCap: 12 }, 240, nowIso);
    expect(html).toContain("was reached that day");
    expect(html).not.toContain("12 calls");
  });

  test("resetAt 04:00: a row at 04:30 on the same morning is today (full sentence, 04:00)", () => {
    const row = new Date(2026, 9, 15, 4, 30).toISOString();
    const nowIso = new Date(2026, 9, 15, 5, 0).toISOString();
    const html = railHtml([{ ...SKIPPED, timestamp: row } as CriticCall], { reviewDailyCap: 12 }, 240, nowIso);
    expect(html).toContain("12 calls");
    expect(html).toContain("04:00");
  });
});
