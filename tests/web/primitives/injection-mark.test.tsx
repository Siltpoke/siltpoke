/** @jsxImportSource hono/jsx */
/**
 * `InjectionMark` / `ToolCallsLine` — the dashboard half of the injection alert.
 * String-render (SSR) assertions; the browser-visible half is
 * tests/e2e/timeline-injection.spec.ts.
 */
import { describe, expect, test } from "bun:test";
import type { InjectionAlert } from "../../../src/critic/injection-alert";
import type { CriticCall, CriticTelemetry } from "../../../src/state/critic-event-log";
import { InjectionMark, ToolCallsLine } from "../../../src/web/primitives/critique-audit/shared";
import { RecentRow } from "../../../src/web/screens/critic/recent-row";
import { DetailPane } from "../../../src/web/screens/timeline/detail-pane";
import { TimelineRail } from "../../../src/web/screens/timeline/rail";

const NOW = new Date("2026-07-12T00:05:00.000Z");

const BASE_CALL: CriticCall = {
  timestamp: "2026-07-12T00:00:00.000Z",
  session_id: "sess-inj",
  cwd: "/tmp/project",
  project: "project",
  status: "fired",
  skip_reason: null,
  critique_id: "c-inj",
  bubble_short: "watch the auth check",
  bubble_long: null,
  critique_for_claude: "The token expiry uses `<` not `<=`.",
  severity: "high",
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
  speech_kind: "critical",
  reasoning: "Off-by-one.",
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
  injection_alert: null,
  tool_calls: null,
};

const loud: InjectionAlert = {
  level: "loud",
  toolRecord: "recorded",
  signals: [
    { kind: "self", level: "loud", where: "docs/notes.md", quote: "ignore all prior rules", why: "tries to steer the reviewer" },
    { kind: "tool", level: "loud", where: "/etc/hosts", quote: "Read /etc/hosts", why: "read outside the project" },
  ],
};
const quiet: InjectionAlert = {
  level: "quiet",
  toolRecord: "recorded",
  signals: [{ kind: "tool", level: "quiet", where: "~/.codex/x", quote: "Read ~/.codex/x", why: "agent-own folder" }],
};

describe("InjectionMark", () => {
  test("null renders nothing", () => {
    expect(String(<InjectionMark alert={null} />)).toBe("");
  });

  test("loud: one line per signal with where, quote, why", () => {
    const html = String(<InjectionMark alert={loud} />);
    expect(html).toContain('data-injection-mark="loud"');
    expect(html).toContain("docs/notes.md");
    expect(html).toContain("ignore all prior rules");
    expect(html).toContain("tries to steer the reviewer");
    expect(html).toContain("/etc/hosts");
    expect(html.match(/data-injection-signal/g)?.length).toBe(2);
  });

  test("quiet: a grey line, not the loud bar", () => {
    const html = String(<InjectionMark alert={quiet} />);
    expect(html).toContain('data-injection-mark="quiet"');
    expect(html).not.toContain('data-injection-mark="loud"');
  });

  test("a <script> in a quote is escaped in SSR output", () => {
    const evil: InjectionAlert = {
      ...loud,
      signals: [{ kind: "self", level: "loud", where: "<b>w</b>", quote: "<script>alert(1)</script>", why: "<img src=x onerror=1>" }],
    };
    const html = String(<InjectionMark alert={evil} />);
    expect(html).not.toContain("<script>");
    expect(html).not.toContain("<img");
    expect(html).not.toContain("<b>w");
    expect(html).toContain("&lt;script&gt;");
  });
});

describe("InjectionMark: scan wording", () => {
  const scanSig = { kind: "scan" as const, level: "quiet" as const, where: "AGENTS.md", quote: "ignore the reviewer", why: "reads like an instruction" };
  const toolSig = quiet.signals[0]!;
  const alertOf = (signals: InjectionAlert["signals"]): InjectionAlert => ({ level: "quiet", toolRecord: "recorded", signals });

  test("scan-only quiet: label says text that looks like an instruction to the AI", () => {
    const html = String(<InjectionMark alert={alertOf([scanSig])} />);
    expect(html).toContain("text that looks like an instruction to the AI");
    expect(html).not.toContain("own folder");
  });
  test("tool-only quiet keeps the own-folder label", () => {
    const html = String(<InjectionMark alert={alertOf([toolSig])} />);
    expect(html).toContain("own folder");
    expect(html).not.toContain("text that looks like");
  });
  test("both kinds quiet: worth a look", () => {
    const html = String(<InjectionMark alert={alertOf([toolSig, scanSig])} />);
    expect(html).toContain("worth a look");
  });
  test("every signal line starts with a kind tag", () => {
    const all: InjectionAlert = { level: "loud", toolRecord: "recorded", signals: [loud.signals[0]!, loud.signals[1]!, scanSig] };
    const html = String(<InjectionMark alert={all} />);
    expect(html).toContain(">said by the AI<");
    expect(html).toContain(">outside read<");
    expect(html).toContain(">scan<");
  });
  test("in a loud alert, a quiet scan line is dimmed and marked quiet; the loud line is not", () => {
    const mixed: InjectionAlert = { level: "loud", toolRecord: "recorded", signals: [loud.signals[0]!, scanSig] };
    const html = String(<InjectionMark alert={mixed} />);
    const row = (kind: string) => html.split(`data-injection-signal="${kind}"`)[1]!.split("</div>")[0]!;
    expect(row("scan")).toContain('data-injection-level="quiet"');
    expect(row("scan")).toContain("opacity");
    expect(row("self")).toContain('data-injection-level="loud"');
    expect(row("self")).not.toContain("opacity");
  });
  test("a <script> quote in a scan signal is escaped", () => {
    const html = String(<InjectionMark alert={alertOf([{ ...scanSig, quote: "<script>alert(1)</script>" }])} />);
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;");
  });
});

describe("ToolCallsLine", () => {
  test("null renders nothing (row predates tool recording)", () => {
    expect(String(<ToolCallsLine field={null} />)).toBe("");
  });

  test("not_recorded says the agent does not report tool calls, never 'used no tools'", () => {
    const html = String(<ToolCallsLine field="not_recorded" />);
    expect(html).toContain("does not report tool calls");
    expect(html).toContain("cannot be known");
    expect(html.toLowerCase()).not.toContain("used no tools");
    expect(html.toLowerCase()).not.toContain("no outside read");
  });

  test("empty list says it used no tools", () => {
    expect(String(<ToolCallsLine field={[]} />).toLowerCase()).toContain("used no tools");
  });

  test("a list names each call, marks failures, and escapes targets", () => {
    const html = String(
      <ToolCallsLine
        field={[
          { tool: "Read", target: "/etc/hosts", failed: false },
          { tool: "shell", target: "<script>x</script>", failed: true },
        ]}
      />,
    );
    expect(html).toContain("Read");
    expect(html).toContain("/etc/hosts");
    expect(html).toContain("failed");
    expect(html).not.toContain("<script>");
  });
});

describe("placement", () => {
  const withAlert: CriticCall = { ...BASE_CALL, injection_alert: loud, tool_calls: "not_recorded" };

  test("detail pane: the mark sits above the review text", () => {
    const html = String(
      <DetailPane c={withAlert} now={NOW} homeBasename={null} preferenceStats={null} initial={true} projHash="abc123abc123" />,
    );
    const markAt = html.indexOf("data-injection-mark");
    const reviewAt = html.indexOf("The token expiry uses");
    expect(markAt).toBeGreaterThan(-1);
    expect(reviewAt).toBeGreaterThan(-1);
    expect(markAt).toBeLessThan(reviewAt);
    expect(html).toContain("does not report tool calls");
  });

  test("recent row: the mark is wired in, above the narrative", () => {
    const html = String(
      <RecentRow c={{ ...withAlert, bubble_long: "NARRATIVE-TEXT" }} now={NOW} homeBasename={null} preferenceStats={null} />,
    );
    const markAt = html.indexOf("data-injection-mark");
    expect(markAt).toBeGreaterThan(-1);
    expect(markAt).toBeLessThan(html.indexOf("NARRATIVE-TEXT"));
    expect(html).toContain("does not report tool calls");
  });
});

describe("rail", () => {
  function rail(c: CriticCall): string {
    const telemetry = {
      recent: [c],
      breakdown: { total: 0, counts: {} },
      projects: [],
      activeProject: null,
      activeStatus: null,
      activeKind: null,
      activeRange: "all",
      activeSort: "recent",
      homeBasename: "user",
    } as unknown as CriticTelemetry;
    return String(<TimelineRail telemetry={telemetry} now={NOW} />);
  }

  test("a loud alert prefixes the bubble with a warning sign; quiet and none do not", () => {
    expect(rail({ ...BASE_CALL, injection_alert: loud })).toContain("⚠");
    expect(rail({ ...BASE_CALL, injection_alert: quiet })).not.toContain("⚠");
    expect(rail(BASE_CALL)).not.toContain("⚠");
  });
});
