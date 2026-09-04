/**
 * Tests for critic-event-log filters.
 *
 * Covers status, speech-kind, time-range, search, and user-action filters
 * on top of the existing project filter.
 */
import { beforeEach, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdir, writeFile, } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { readBrainCalls, readBrainCallsPage, readCriticTelemetry } from "../../src/state/critic-event-log";

interface FixtureCall {
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
  confidence?: string;
  /** Per-row cost override for totals tests. Default 0.001. */
  cost?: number;
  /** Per-row input/output token overrides for totals tests. Defaults 100/50. */
  input_tokens?: number;
  output_tokens?: number;
  /** When true, the fired line is written WITHOUT a usage block (legacy shape). */
  omit_usage?: boolean;
  /** When true, the fired line carries bubble_short: null (no-bubble row). */
  omit_bubble?: boolean;
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
  return JSON.stringify({
    timestamp: c.ts,
    session_id: c.session,
    cwd: c.cwd ?? "/Users/foo/projA",
    ...((c as { authorFamily?: string }).authorFamily
      ? { authorFamily: (c as { authorFamily?: string }).authorFamily }
      : {}),
    brain_output: {
      bubble_short: c.omit_bubble ? null : c.bubble_short ?? "short",
      bubble_long: c.bubble_long ?? null,
      critique_for_claude: c.critique ?? null,
      severity: c.severity ?? "info",
      confidence: c.confidence ?? "low",
      evidence: [],
    },
    ...(c.omit_usage
      ? {}
      : {
          usage: {
            input_tokens: c.input_tokens ?? 100,
            output_tokens: c.output_tokens ?? 50,
            cache_read_input_tokens: 0,
            cache_creation_input_tokens: 0,
            total_cost_usd: c.cost ?? 0.001,
          },
        }),
  });
}

async function writeFixture(base: string, calls: FixtureCall[]): Promise<void> {
  await mkdir(base, { recursive: true });
  const lines = calls.map((c) =>
    c.status === "skipped" ? skippedLine(c) : c.status === "error" ? errorLine(c) : firedLine(c),
  );
  await writeFile(join(base, "brain-calls.jsonl"), `${lines.join("\n")}\n`, "utf8");
}

let homeBase: string;
const now = new Date("2026-05-19T15:00:00Z");

beforeEach(async () => {
  homeBase = join(tmpdir(), `critic-test-${randomUUID()}`);
  await mkdir(homeBase, { recursive: true });
});

describe("status filter", () => {
  test("status=fired returns only fired calls", async () => {
    await writeFixture(homeBase, [
      { ts: "2026-05-19T14:00:00Z", session: "s1", status: "fired" },
      { ts: "2026-05-19T14:05:00Z", session: "s2", status: "skipped" },
      { ts: "2026-05-19T14:10:00Z", session: "s3", status: "fired" },
    ]);
    const t = await readCriticTelemetry(homeBase, now, { status: "fired" });
    expect(t.recent.length).toBe(2);
    expect(t.recent.every((c) => c.status === "fired")).toBe(true);
  });

  test("status=skipped returns only skipped calls", async () => {
    await writeFixture(homeBase, [
      { ts: "2026-05-19T14:00:00Z", session: "s1", status: "fired" },
      { ts: "2026-05-19T14:05:00Z", session: "s2", status: "skipped" },
    ]);
    const t = await readCriticTelemetry(homeBase, now, { status: "skipped" });
    expect(t.recent.length).toBe(1);
    expect(t.recent[0]?.status).toBe("skipped");
  });

  test("status=null returns both (default)", async () => {
    await writeFixture(homeBase, [
      { ts: "2026-05-19T14:00:00Z", session: "s1", status: "fired" },
      { ts: "2026-05-19T14:05:00Z", session: "s2", status: "skipped" },
    ]);
    const t = await readCriticTelemetry(homeBase, now);
    expect(t.recent.length).toBe(2);
  });

  test("activeStatus echoed back in telemetry", async () => {
    await writeFixture(homeBase, []);
    const t = await readCriticTelemetry(homeBase, now, { status: "fired" });
    expect(t.activeStatus).toBe("fired");
    const t2 = await readCriticTelemetry(homeBase, now);
    expect(t2.activeStatus).toBeNull();
  });
});

describe("errors facet (brain-failure rows — filter-row 3rd smoke)", () => {
  test("catch-path error lines parse as skipped/brain_error with error_message", async () => {
    await writeFixture(homeBase, [
      { ts: "2026-05-19T14:00:00Z", session: "s1", status: "error", error_message: "BrainError: claude -p timed out" },
    ]);
    const t = await readCriticTelemetry(homeBase, now, { status: null });
    expect(t.recent.length).toBe(1);
    expect(t.recent[0]?.status).toBe("skipped");
    expect(t.recent[0]?.skip_reason).toBe("brain_error");
    expect(t.recent[0]?.error_message).toBe("BrainError: claude -p timed out");
  });

  test("status=errors returns only brain-failure rows", async () => {
    await writeFixture(homeBase, [
      { ts: "2026-05-19T14:00:00Z", session: "s1", status: "fired" },
      { ts: "2026-05-19T14:05:00Z", session: "s2", status: "skipped" },
      { ts: "2026-05-19T14:10:00Z", session: "s3", status: "error" },
    ]);
    const t = await readCriticTelemetry(homeBase, now, { status: "errors" });
    expect(t.recent.length).toBe(1);
    expect(t.recent[0]?.error_message).not.toBeNull();
    expect(t.activeStatus).toBe("errors");
  });

  test("default fired filter hides error rows; skipped includes them", async () => {
    await writeFixture(homeBase, [
      { ts: "2026-05-19T14:00:00Z", session: "s1", status: "fired" },
      { ts: "2026-05-19T14:05:00Z", session: "s2", status: "error" },
    ]);
    const fired = await readCriticTelemetry(homeBase, now, { status: "fired" });
    expect(fired.recent.length).toBe(1);
    expect(fired.recent[0]?.status).toBe("fired");
    const skipped = await readCriticTelemetry(homeBase, now, { status: "skipped" });
    expect(skipped.recent.length).toBe(1);
    expect(skipped.recent[0]?.skip_reason).toBe("brain_error");
  });

  test("ordinary rows carry error_message null (fired + skipped)", async () => {
    await writeFixture(homeBase, [
      { ts: "2026-05-19T14:00:00Z", session: "s1", status: "fired" },
      { ts: "2026-05-19T14:05:00Z", session: "s2", status: "skipped" },
    ]);
    const t = await readCriticTelemetry(homeBase, now);
    expect(t.recent.length).toBe(2);
    expect(t.recent.every((c) => c.error_message === null)).toBe(true);
  });
});

describe("speech-kind filter", () => {
  test("kind=comment matches severity=info|low (Brain's default-benign band)", async () => {
    await writeFixture(homeBase, [
      { ts: "2026-05-19T14:00:00Z", session: "s1", status: "fired", severity: "info" },
      { ts: "2026-05-19T14:05:00Z", session: "s2", status: "fired", severity: "low" },
      { ts: "2026-05-19T14:10:00Z", session: "s3", status: "fired", severity: "high" },
    ]);
    const t = await readCriticTelemetry(homeBase, now, { kind: "comment" });
    expect(t.recent.length).toBe(2);
    const ids = t.recent.map((c) => c.session_id).sort();
    expect(ids).toEqual(["s1", "s2"]);
  });

  test("kind=warning matches severity=medium only (low + critique-text no longer force amber)", async () => {
    await writeFixture(homeBase, [
      { ts: "2026-05-19T14:00:00Z", session: "s1", status: "fired", severity: "low" },
      { ts: "2026-05-19T14:02:00Z", session: "s4", status: "fired", severity: "medium" },
      { ts: "2026-05-19T14:05:00Z", session: "s2", status: "fired", severity: "info", critique: "fix this" },
      { ts: "2026-05-19T14:10:00Z", session: "s3", status: "fired", severity: "info" },
    ]);
    const t = await readCriticTelemetry(homeBase, now, { kind: "warning" });
    expect(t.recent.length).toBe(1);
    expect(t.recent[0]?.session_id).toBe("s4");
  });

  test("kind=critical matches severity=high only", async () => {
    await writeFixture(homeBase, [
      { ts: "2026-05-19T14:00:00Z", session: "s1", status: "fired", severity: "high" },
      { ts: "2026-05-19T14:05:00Z", session: "s2", status: "fired", severity: "low" },
    ]);
    const t = await readCriticTelemetry(homeBase, now, { kind: "critical" });
    expect(t.recent.length).toBe(1);
    expect(t.recent[0]?.session_id).toBe("s1");
  });

  test("kind filter excludes skipped calls", async () => {
    await writeFixture(homeBase, [
      { ts: "2026-05-19T14:00:00Z", session: "s1", status: "skipped" },
      { ts: "2026-05-19T14:05:00Z", session: "s2", status: "fired", severity: "info" },
    ]);
    const t = await readCriticTelemetry(homeBase, now, { kind: "comment" });
    expect(t.recent.length).toBe(1);
    expect(t.recent[0]?.session_id).toBe("s2");
  });

  test("activeKind echoed back", async () => {
    await writeFixture(homeBase, []);
    const t = await readCriticTelemetry(homeBase, now, { kind: "critical" });
    expect(t.activeKind).toBe("critical");
  });
});

describe("time-range filter", () => {
  test("range=today filters by UTC day", async () => {
    // Chronological (append) order — the live writer's invariant, which the
    // windowed read's sorted-file early exit depends on.
    await writeFixture(homeBase, [
      { ts: "2026-05-18T23:59:00Z", session: "s3", status: "fired" },
      { ts: "2026-05-19T01:00:00Z", session: "s2", status: "fired" },
      { ts: "2026-05-19T14:00:00Z", session: "s1", status: "fired" },
    ]);
    const t = await readCriticTelemetry(homeBase, now, { range: "today" });
    expect(t.recent.length).toBe(2);
    expect(t.recent.map((c) => c.session_id).sort()).toEqual(["s1", "s2"]);
  });

  test("range=7d includes last 7 days", async () => {
    await writeFixture(homeBase, [
      { ts: "2026-05-10T14:00:00Z", session: "s3", status: "fired" },
      { ts: "2026-05-13T14:00:00Z", session: "s2", status: "fired" },
      { ts: "2026-05-19T14:00:00Z", session: "s1", status: "fired" },
    ]);
    const t = await readCriticTelemetry(homeBase, now, { range: "7d" });
    expect(t.recent.length).toBe(2);
  });

  test("range=30d", async () => {
    await writeFixture(homeBase, [
      { ts: "2026-04-10T14:00:00Z", session: "s3", status: "fired" },
      { ts: "2026-04-25T14:00:00Z", session: "s2", status: "fired" },
      { ts: "2026-05-19T14:00:00Z", session: "s1", status: "fired" },
    ]);
    const t = await readCriticTelemetry(homeBase, now, { range: "30d" });
    expect(t.recent.length).toBe(2);
  });

  test("range=all defaults", async () => {
    await writeFixture(homeBase, [
      { ts: "2026-05-19T14:00:00Z", session: "s1", status: "fired" },
      { ts: "2025-01-01T14:00:00Z", session: "s2", status: "fired" },
    ]);
    const t = await readCriticTelemetry(homeBase, now, { range: "all" });
    expect(t.recent.length).toBe(2);
  });

  test("activeRange echoed back", async () => {
    await writeFixture(homeBase, []);
    const t = await readCriticTelemetry(homeBase, now, { range: "7d" });
    expect(t.activeRange).toBe("7d");
    const t2 = await readCriticTelemetry(homeBase, now);
    expect(t2.activeRange).toBe("all");
  });
});

describe("search filter", () => {
  test("query matches bubble_short (case insensitive)", async () => {
    await writeFixture(homeBase, [
      { ts: "2026-05-19T14:00:00Z", session: "s1", status: "fired", bubble_short: "Race condition in auth" },
      { ts: "2026-05-19T14:05:00Z", session: "s2", status: "fired", bubble_short: "Looks clean" },
    ]);
    const t = await readCriticTelemetry(homeBase, now, { query: "race" });
    expect(t.recent.length).toBe(1);
    expect(t.recent[0]?.session_id).toBe("s1");
  });

  test("query matches bubble_long", async () => {
    await writeFixture(homeBase, [
      { ts: "2026-05-19T14:00:00Z", session: "s1", status: "fired", bubble_short: "short", bubble_long: "this discusses regex parsing" },
      { ts: "2026-05-19T14:05:00Z", session: "s2", status: "fired", bubble_short: "short", bubble_long: "totally different" },
    ]);
    const t = await readCriticTelemetry(homeBase, now, { query: "regex" });
    expect(t.recent.length).toBe(1);
    expect(t.recent[0]?.session_id).toBe("s1");
  });

  test("query matches critique_for_claude", async () => {
    await writeFixture(homeBase, [
      { ts: "2026-05-19T14:00:00Z", session: "s1", status: "fired", critique: "Add null check" },
      { ts: "2026-05-19T14:05:00Z", session: "s2", status: "fired", critique: "Extract function" },
    ]);
    const t = await readCriticTelemetry(homeBase, now, { query: "null" });
    expect(t.recent.length).toBe(1);
    expect(t.recent[0]?.session_id).toBe("s1");
  });

  test("query excludes skipped (no bubble fields)", async () => {
    await writeFixture(homeBase, [
      { ts: "2026-05-19T14:00:00Z", session: "s1", status: "skipped" },
      { ts: "2026-05-19T14:05:00Z", session: "s2", status: "fired", bubble_short: "Match here" },
    ]);
    const t = await readCriticTelemetry(homeBase, now, { query: "match" });
    expect(t.recent.length).toBe(1);
    expect(t.recent[0]?.session_id).toBe("s2");
  });

  test("empty query ignored", async () => {
    await writeFixture(homeBase, [
      { ts: "2026-05-19T14:00:00Z", session: "s1", status: "fired" },
    ]);
    const t = await readCriticTelemetry(homeBase, now, { query: "" });
    expect(t.recent.length).toBe(1);
  });

  test("activeQuery echoed back", async () => {
    await writeFixture(homeBase, []);
    const t = await readCriticTelemetry(homeBase, now, { query: "foo" });
    expect(t.activeQuery).toBe("foo");
  });
});

describe("user-action filter (dismissed/acked)", () => {
  async function writeActions(
    base: string,
    actions: Array<{ session: string; ts: string; action: "dismiss" | "ack" | "clear" }>,
  ): Promise<void> {
    const lines = actions.map((a) =>
      JSON.stringify({
        session_id: a.session,
        timestamp: a.ts,
        action: a.action,
        at: "2026-05-19T15:00:00Z",
      }),
    );
    await writeFile(join(base, "critic-actions.jsonl"), `${lines.join("\n")}\n`, "utf8");
  }

  test("attaches user_action to matching call", async () => {
    await writeFixture(homeBase, [
      { ts: "2026-05-19T14:00:00Z", session: "s1", status: "fired" },
      { ts: "2026-05-19T14:05:00Z", session: "s2", status: "fired" },
    ]);
    await writeActions(homeBase, [{ session: "s1", ts: "2026-05-19T14:00:00Z", action: "dismiss" }]);
    const t = await readCriticTelemetry(homeBase, now);
    const s1 = t.recent.find((c) => c.session_id === "s1");
    const s2 = t.recent.find((c) => c.session_id === "s2");
    expect(s1?.user_action).toBe("dismissed");
    expect(s2?.user_action).toBeNull();
  });

  test("latest action wins (ack after dismiss)", async () => {
    await writeFixture(homeBase, [
      { ts: "2026-05-19T14:00:00Z", session: "s1", status: "fired" },
    ]);
    await writeActions(homeBase, [
      { session: "s1", ts: "2026-05-19T14:00:00Z", action: "dismiss" },
      { session: "s1", ts: "2026-05-19T14:00:00Z", action: "ack" },
    ]);
    const t = await readCriticTelemetry(homeBase, now);
    expect(t.recent[0]?.user_action).toBe("acked");
  });

  test("missing critic-actions.jsonl is ok", async () => {
    await writeFixture(homeBase, [
      { ts: "2026-05-19T14:00:00Z", session: "s1", status: "fired" },
    ]);
    const t = await readCriticTelemetry(homeBase, now);
    expect(t.recent[0]?.user_action).toBeNull();
  });

  test("clear action undoes prior ack/dismiss", async () => {
    await writeFixture(homeBase, [
      { ts: "2026-05-19T14:00:00Z", session: "s1", status: "fired" },
    ]);
    await writeActions(homeBase, [
      { session: "s1", ts: "2026-05-19T14:00:00Z", action: "ack" },
      { session: "s1", ts: "2026-05-19T14:00:00Z", action: "clear" },
    ]);
    const t = await readCriticTelemetry(homeBase, now);
    expect(t.recent[0]?.user_action).toBeNull();
  });
});

describe("actionStats", () => {
  async function writeActions(
    base: string,
    actions: Array<{ session: string; ts: string; action: "dismiss" | "ack" | "clear" }>,
  ): Promise<void> {
    const lines = actions.map((a) =>
      JSON.stringify({
        session_id: a.session,
        timestamp: a.ts,
        action: a.action,
        at: "2026-05-19T15:00:00Z",
      }),
    );
    await writeFile(join(base, "critic-actions.jsonl"), `${lines.join("\n")}\n`, "utf8");
  }

  test("tallies acked/dismissed/untouched against fired window", async () => {
    await writeFixture(homeBase, [
      { ts: "2026-05-19T14:00:00Z", session: "s1", status: "fired" },
      { ts: "2026-05-19T14:01:00Z", session: "s2", status: "fired" },
      { ts: "2026-05-19T14:02:00Z", session: "s3", status: "fired" },
      { ts: "2026-05-19T14:03:00Z", session: "s4", status: "fired" },
      { ts: "2026-05-19T14:04:00Z", session: "skp", status: "skipped" },
    ]);
    await writeActions(homeBase, [
      { session: "s1", ts: "2026-05-19T14:00:00Z", action: "ack" },
      { session: "s2", ts: "2026-05-19T14:01:00Z", action: "dismiss" },
      { session: "s3", ts: "2026-05-19T14:02:00Z", action: "ack" },
    ]);
    const t = await readCriticTelemetry(homeBase, now);
    expect(t.actionStats.acked).toBe(2);
    expect(t.actionStats.dismissed).toBe(1);
    expect(t.actionStats.untouched_fired).toBe(1);
    expect(t.actionStats.total_fired).toBe(4);
  });

  test("empty actionStats when no fired entries", async () => {
    await writeFixture(homeBase, [
      { ts: "2026-05-19T14:00:00Z", session: "skp", status: "skipped" },
    ]);
    const t = await readCriticTelemetry(homeBase, now);
    expect(t.actionStats.total_fired).toBe(0);
  });
});

describe("totals (filter-contextual token/cost sums)", () => {
  test("sums tokens + cost over the filtered set only (excluded row's cost excluded)", async () => {
    await writeFixture(homeBase, [
      { ts: "2026-05-19T14:00:00Z", session: "s1", status: "fired", severity: "high", cost: 0.01, input_tokens: 200, output_tokens: 100 },
      { ts: "2026-05-19T14:05:00Z", session: "s2", status: "fired", severity: "high", cost: 0.02, input_tokens: 300, output_tokens: 150 },
      // severity=info → speech_kind=comment → excluded by kind=critical filter
      { ts: "2026-05-19T14:10:00Z", session: "s3", status: "fired", severity: "info", cost: 5, input_tokens: 9999, output_tokens: 9999 },
    ]);
    const t = await readCriticTelemetry(homeBase, now, { kind: "critical" });
    expect(t.recent.length).toBe(2);
    // s1: 200+100, s2: 300+150 (cache components are 0 in fixture)
    expect(t.totals.tokens).toBe(750);
    expect(t.totals.cost_usd).toBeCloseTo(0.03, 10);
  });

  test("unfiltered totals sum every row", async () => {
    await writeFixture(homeBase, [
      { ts: "2026-05-19T14:00:00Z", session: "s1", status: "fired", cost: 0.001, input_tokens: 100, output_tokens: 50 },
      { ts: "2026-05-19T14:05:00Z", session: "s2", status: "fired", cost: 0.002, input_tokens: 10, output_tokens: 5 },
    ]);
    const t = await readCriticTelemetry(homeBase, now);
    expect(t.totals.tokens).toBe(165);
    expect(t.totals.cost_usd).toBeCloseTo(0.003, 10);
  });

  test("null cost/tokens rows count as 0, never NaN (skipped + usage-less fired)", async () => {
    await writeFixture(homeBase, [
      // skipped row: cost_usd null + tokens null after parse
      { ts: "2026-05-19T14:00:00Z", session: "skp", status: "skipped" },
      // legacy fired row without usage block: cost_usd null
      { ts: "2026-05-19T14:05:00Z", session: "s1", status: "fired", omit_usage: true },
      { ts: "2026-05-19T14:10:00Z", session: "s2", status: "fired", cost: 0.004, input_tokens: 40, output_tokens: 20 },
    ]);
    const t = await readCriticTelemetry(homeBase, now);
    expect(t.recent.length).toBe(3);
    expect(Number.isNaN(t.totals.tokens)).toBe(false);
    expect(Number.isNaN(t.totals.cost_usd)).toBe(false);
    expect(t.totals.tokens).toBe(60);
    expect(t.totals.cost_usd).toBeCloseTo(0.004, 10);
  });

  test("empty filtered set → { tokens: 0, cost_usd: 0 }", async () => {
    await writeFixture(homeBase, [
      { ts: "2026-05-19T14:00:00Z", session: "s1", status: "fired", cost: 0.5 },
    ]);
    const t = await readCriticTelemetry(homeBase, now, { query: "no-such-text" });
    expect(t.recent.length).toBe(0);
    expect(t.totals).toEqual({ tokens: 0, cost_usd: 0 });
  });
});

describe("Load-older window", () => {
  // 250 rows dated "today" relative to the injected now (2026-05-19T15:00Z),
  // second-precision, chronologically appended like the live writer does.
  const tdTs = (i: number) =>
    `2026-05-19T10:${String(Math.floor(i / 60)).padStart(2, "0")}:${String(i % 60).padStart(2, "0")}Z`;
  // d1..d6 = 1..6 days before today (all inside the 7d range at now).
  const DAY_TS = [
    "2026-05-18T12:00:00Z",
    "2026-05-17T12:00:00Z",
    "2026-05-16T12:00:00Z",
    "2026-05-15T12:00:00Z",
    "2026-05-14T12:00:00Z",
    "2026-05-13T12:00:00Z",
  ];

  function bigFixture(): FixtureCall[] {
    const calls: FixtureCall[] = [
      // ~60d ago — outside 30d range.
      { ts: "2026-03-20T12:00:00Z", session: "m60", status: "fired", cost: 0.04 },
      // ~29d ago — inside 30d, outside 7d.
      { ts: "2026-04-20T12:00:00Z", session: "m29", status: "fired", cost: 0.03 },
    ];
    for (let d = 6; d >= 1; d--) {
      calls.push({ ts: DAY_TS[d - 1] as string, session: `d${d}`, status: "fired", cost: 0.01 });
    }
    for (let i = 0; i < 250; i++) {
      calls.push({ ts: tdTs(i), session: `td${i}`, status: "fired" });
    }
    return calls;
  }

  test("(a) first window: newest 200 rows + hasMore true + windowOldestTs anchor (range=7d)", async () => {
    await writeFixture(homeBase, bigFixture());
    const t = await readCriticTelemetry(homeBase, now, { range: "7d", limit: 200 });
    expect(t.recent.length).toBe(200);
    expect(t.recent[0]?.session_id).toBe("td249");
    expect(t.recent[199]?.session_id).toBe("td50");
    expect(t.hasMore).toBe(true);
    expect(t.windowOldestTs).toBe(tdTs(50));
  });

  test("(b) before=<oldest visible ts> reaches prior days, still range-bounded (7d excludes m29/m60)", async () => {
    await writeFixture(homeBase, bigFixture());
    const t = await readCriticTelemetry(homeBase, now, {
      range: "7d",
      limit: 200,
      before: new Date(tdTs(50)),
    });
    // td0..td49 (before bound is exclusive) + d1..d6 = 56 rows.
    expect(t.recent.length).toBe(56);
    const ids = new Set(t.recent.map((c) => c.session_id));
    expect(ids.has("td50")).toBe(false); // exclusive upper bound
    expect(ids.has("td49")).toBe(true);
    for (let d = 1; d <= 6; d++) expect(ids.has(`d${d}`)).toBe(true);
    expect(ids.has("m29")).toBe(false);
    expect(ids.has("m60")).toBe(false);
    expect(t.hasMore).toBe(false); // range exhausted
  });

  test("(b2) 30d second window includes the ~29d row, still excludes ~60d", async () => {
    await writeFixture(homeBase, bigFixture());
    const t = await readCriticTelemetry(homeBase, now, {
      range: "30d",
      limit: 200,
      before: new Date(tdTs(50)),
    });
    expect(t.recent.length).toBe(57);
    const ids = new Set(t.recent.map((c) => c.session_id));
    expect(ids.has("m29")).toBe(true);
    expect(ids.has("m60")).toBe(false);
    expect(t.hasMore).toBe(false);
  });

  test("(c) today range never crosses days; hasMore honest across both pages", async () => {
    await writeFixture(homeBase, bigFixture());
    const p1 = await readCriticTelemetry(homeBase, now, { range: "today", limit: 200 });
    expect(p1.recent.length).toBe(200);
    expect(p1.recent.every((c) => c.session_id.startsWith("td"))).toBe(true);
    expect(p1.hasMore).toBe(true);

    const p2 = await readCriticTelemetry(homeBase, now, {
      range: "today",
      limit: 200,
      before: new Date(tdTs(50)),
    });
    expect(p2.recent.length).toBe(50);
    expect(p2.recent.every((c) => c.session_id.startsWith("td"))).toBe(true);
    // Range exhausted by this window even though older (other-day) rows exist.
    expect(p2.hasMore).toBe(false);
  });

  test("(d) window that exhausts the range → hasMore false", async () => {
    await writeFixture(homeBase, bigFixture());
    const t = await readCriticTelemetry(homeBase, now, {
      range: "7d",
      limit: 200,
      before: new Date(tdTs(0)),
    });
    expect(t.recent.map((c) => c.session_id).sort()).toEqual(["d1", "d2", "d3", "d4", "d5", "d6"]);
    expect(t.hasMore).toBe(false);
  });

  test("(e) no-range/no-before caller: rows byte-identical to the tail-limit reference", async () => {
    const fixture = bigFixture();
    await writeFixture(homeBase, fixture);
    const t = await readCriticTelemetry(homeBase, now, { limit: 200 });
    // Reference: last 200 lines of the file, newest first.
    const expected = fixture.slice(-200).map((c) => c.session).reverse();
    expect(t.recent.map((c) => c.session_id)).toEqual(expected);
    // hasMore is additive — surfaced without changing the rows.
    expect(t.hasMore).toBe(true);
    expect(t.windowOldestTs).toBe(tdTs(50));
  });

  test("(e2) legacy path: a malformed line still consumes a tail slot (line-slice identity)", async () => {
    const rows = [1, 2, 3, 4, 5].map((i) =>
      JSON.stringify({
        timestamp: `2026-05-19T14:0${i}:00Z`,
        session_id: `s${i}`,
        cwd: "/Users/foo/projA",
        skipped: "quiet_hours",
      }),
    );
    // Malformed line sits INSIDE the 3-line tail: [garbage, s4, s5].
    const lines = [...rows.slice(0, 3), "NOT JSON {", rows[3] as string, rows[4] as string];
    await writeFile(join(homeBase, "brain-calls.jsonl"), `${lines.join("\n")}\n`, "utf8");
    const res = await readBrainCalls(homeBase, 3);
    expect(res.calls.map((c) => c.session_id)).toEqual(["s5", "s4"]);
    expect(res.hasMore).toBe(true); // parseable rows exist beyond the slice
  });

  test("readBrainCalls: before is exclusive; hasMore peeks exactly one row further", async () => {
    await writeFixture(homeBase, [1, 2, 3, 4, 5].map((i) => ({
      ts: `2026-05-19T14:0${i}:00Z`,
      session: `s${i}`,
      status: "fired" as const,
    })));
    const w2 = await readBrainCalls(homeBase, 2, { before: new Date("2026-05-19T14:04:00Z") });
    expect(w2.calls.map((c) => c.session_id)).toEqual(["s3", "s2"]);
    expect(w2.hasMore).toBe(true); // s1 still passes
    const w3 = await readBrainCalls(homeBase, 3, { before: new Date("2026-05-19T14:04:00Z") });
    expect(w3.calls.map((c) => c.session_id)).toEqual(["s3", "s2", "s1"]);
    expect(w3.hasMore).toBe(false);
  });

  test("readBrainCalls: cutoff early-exit reports hasMore=false even when older rows exist", async () => {
    await writeFixture(homeBase, [1, 2, 3, 4, 5].map((i) => ({
      ts: `2026-05-19T14:0${i}:00Z`,
      session: `s${i}`,
      status: "fired" as const,
    })));
    const w = await readBrainCalls(homeBase, 10, {
      rangeCutoff: new Date("2026-05-19T14:03:00Z"),
    });
    // Cutoff is inclusive (same semantics as applyFilters' rangeStart check).
    expect(w.calls.map((c) => c.session_id)).toEqual(["s5", "s4", "s3"]);
    expect(w.hasMore).toBe(false);
  });

  test("unparseable row timestamps: excluded under any bound, preserved when none", async () => {
    await writeFixture(homeBase, [
      { ts: "not-a-date", session: "bad", status: "fired" },
      { ts: "2026-05-19T14:00:00Z", session: "ok1", status: "fired" },
      { ts: "2026-05-19T14:05:00Z", session: "ok2", status: "fired" },
    ]);
    const legacy = await readBrainCalls(homeBase, 10);
    expect(legacy.calls.map((c) => c.session_id)).toEqual(["ok2", "ok1", "bad"]);
    const cut = await readBrainCalls(homeBase, 10, {
      rangeCutoff: new Date("2026-05-19T13:00:00Z"),
    });
    expect(cut.calls.map((c) => c.session_id)).toEqual(["ok2", "ok1"]);
    const bef = await readBrainCalls(homeBase, 10, {
      before: new Date("2026-05-19T14:03:00Z"),
    });
    expect(bef.calls.map((c) => c.session_id)).toEqual(["ok1"]);
  });

  test("readBrainCalls: missing file → empty window, hasMore false", async () => {
    const res = await readBrainCalls(homeBase, 10, { before: new Date() });
    expect(res.calls).toEqual([]);
    expect(res.hasMore).toBe(false);
  });

  test("legacy path carries no turn-window fields (totalInRange null, hasNewer false, windowNewestTs null)", async () => {
    await writeFixture(homeBase, bigFixture());
    const t = await readCriticTelemetry(homeBase, now, { limit: 200 });
    expect(t.totalInRange).toBeNull();
    expect(t.hasNewer).toBe(false);
    expect(t.windowNewestTs).toBeNull();
  });

  test("(g) totals follow the visible window — page-2 sums differ from page-1", async () => {
    await writeFixture(homeBase, bigFixture());
    const p1 = await readCriticTelemetry(homeBase, now, { range: "7d", limit: 200 });
    // 200 today rows × (100 in + 50 out) tokens, ×$0.001.
    expect(p1.totals.tokens).toBe(30_000);
    expect(p1.totals.cost_usd).toBeCloseTo(0.2, 10);
    const p2 = await readCriticTelemetry(homeBase, now, {
      range: "7d",
      limit: 200,
      before: new Date(tdTs(50)),
    });
    // 50 today rows ×$0.001 + 6 day rows ×$0.01, all ×150 tokens.
    expect(p2.totals.tokens).toBe(8_400);
    expect(p2.totals.cost_usd).toBeCloseTo(0.11, 10);
  });
});

describe("readBrainCallsPage — predicate-counted turn windows (timeline pagination)", () => {
  // Skip-flooded fixture mirroring the live file's shape: fired turns in
  // three chronological blocks, drowned in skip rows, with a PURE-SKIP tail
  // (the newest lines are all gate-skips — a line-window would show ~0 turns).
  //   o0..o4  fired 2026-04-01 (outside 30d at `now`)
  //   m0..m4  fired 2026-05-10 (inside 30d, outside 7d)
  //   n0..n4  fired 2026-05-19 (today)
  //   70 skip rows interleaved + tail
  const oTs = (i: number) => `2026-04-01T10:00:0${i}Z`;
  const mTs = (i: number) => `2026-05-10T10:00:0${i}Z`;
  const nTs = (i: number) => `2026-05-19T10:00:0${i}Z`;
  const skipTs = (block: string, i: number) =>
    `${block}T11:${String(Math.floor(i / 60)).padStart(2, "0")}:${String(i % 60).padStart(2, "0")}Z`;
  const tailTs = (i: number) =>
    `2026-05-19T14:${String(Math.floor(i / 60)).padStart(2, "0")}:${String(i % 60).padStart(2, "0")}Z`;

  function pageFixture(): FixtureCall[] {
    const calls: FixtureCall[] = [];
    for (let i = 0; i < 5; i++) calls.push({ ts: oTs(i), session: `o${i}`, status: "fired", bubble_short: `old turn ${i}` });
    for (let i = 0; i < 20; i++) calls.push({ ts: skipTs("2026-04-01", i), session: `so${i}`, status: "skipped" });
    for (let i = 0; i < 5; i++) calls.push({ ts: mTs(i), session: `m${i}`, status: "fired", bubble_short: `mid turn ${i}`, severity: i === 0 ? "high" : "info" });
    for (let i = 0; i < 20; i++) calls.push({ ts: skipTs("2026-05-10", i), session: `sm${i}`, status: "skipped" });
    for (let i = 0; i < 5; i++) calls.push({ ts: nTs(i), session: `n${i}`, status: "fired", bubble_short: `new turn ${i}` });
    for (let i = 0; i < 30; i++) calls.push({ ts: tailTs(i), session: `st${i}`, status: "skipped" });
    return calls;
  }

  const basePage = {
    limit: 8,
    rangeCutoff: null,
    anchor: "newest" as const,
    status: "fired" as const,
    kind: null,
    query: null,
    project: null,
  };

  test("limit counts display-eligible turns, not lines — skip rows never consume window slots", async () => {
    await writeFixture(homeBase, pageFixture());
    const p = await readBrainCallsPage(homeBase, basePage);
    // Newest 8 FIRED turns despite a 30-line pure-skip tail: m2..m4 + n0..n4.
    expect(p.calls.map((c) => c.session_id)).toEqual(["m2", "m3", "m4", "n0", "n1", "n2", "n3", "n4"]);
    expect(p.hasOlder).toBe(true);
    expect(p.hasNewer).toBe(false);
    expect(p.total).toBe(15);
  });

  test("before cursor (exclusive) pages older; hasNewer true on the older page", async () => {
    await writeFixture(homeBase, pageFixture());
    const p = await readBrainCallsPage(homeBase, { ...basePage, before: new Date(mTs(0)) });
    expect(p.calls.map((c) => c.session_id)).toEqual(["o0", "o1", "o2", "o3", "o4"]);
    expect(p.hasOlder).toBe(false);
    expect(p.hasNewer).toBe(true);
    expect(p.total).toBe(15);
  });

  test("after cursor (exclusive) pages newer, collecting forward from the bound", async () => {
    await writeFixture(homeBase, pageFixture());
    const p = await readBrainCallsPage(homeBase, { ...basePage, after: new Date(oTs(4)) });
    // Oldest 8 rows strictly newer than o4: m0..m4 + n0..n2.
    expect(p.calls.map((c) => c.session_id)).toEqual(["m0", "m1", "m2", "m3", "m4", "n0", "n1", "n2"]);
    expect(p.hasOlder).toBe(true);
    expect(p.hasNewer).toBe(true);
  });

  test("older-then-newer walk returns to an equivalent of the first window", async () => {
    await writeFixture(homeBase, pageFixture());
    const p1 = await readBrainCallsPage(homeBase, basePage);
    const p2 = await readBrainCallsPage(homeBase, {
      ...basePage,
      before: new Date(p1.calls[0]?.timestamp as string),
    });
    const back = await readBrainCallsPage(homeBase, {
      ...basePage,
      after: new Date(p2.calls[p2.calls.length - 1]?.timestamp as string),
    });
    expect(back.calls.map((c) => c.session_id)).toEqual(p1.calls.map((c) => c.session_id));
    expect(back.hasNewer).toBe(false);
  });

  test("out-of-range `after` clamps to the newest window (no dead end)", async () => {
    await writeFixture(homeBase, pageFixture());
    // `after` newer than every fired turn would otherwise give an empty page
    // with a spurious hasOlder and no hasNewer — a real dead end. Clamp.
    const aft = await readBrainCallsPage(homeBase, {
      ...basePage,
      after: new Date("2027-01-01T00:00:00Z"),
    });
    expect(aft.calls.map((c) => c.session_id)).toEqual(["m2", "m3", "m4", "n0", "n1", "n2", "n3", "n4"]);
    expect(aft.hasNewer).toBe(false);
    expect(aft.hasOlder).toBe(true);
  });

  test("anchor=oldest starts the first page at the oldest end of the range", async () => {
    await writeFixture(homeBase, pageFixture());
    const p = await readBrainCallsPage(homeBase, { ...basePage, anchor: "oldest" });
    expect(p.calls.map((c) => c.session_id)).toEqual(["o0", "o1", "o2", "o3", "o4", "m0", "m1", "m2"]);
    expect(p.hasOlder).toBe(false);
    expect(p.hasNewer).toBe(true);
  });

  test("contingency: status=skipped makes skip rows the display rows — THEY count", async () => {
    await writeFixture(homeBase, pageFixture());
    const p = await readBrainCallsPage(homeBase, { ...basePage, status: "skipped", limit: 10 });
    expect(p.calls.map((c) => c.session_id)).toEqual(
      Array.from({ length: 10 }, (_, i) => `st${i + 20}`),
    );
    expect(p.total).toBe(70);
    expect(p.hasOlder).toBe(true);
  });

  test("range cutoff bounds the whole page universe (total + window)", async () => {
    await writeFixture(homeBase, pageFixture());
    const p = await readBrainCallsPage(homeBase, {
      ...basePage,
      rangeCutoff: new Date("2026-05-01T00:00:00Z"),
      anchor: "oldest",
    });
    expect(p.total).toBe(10); // m + n blocks only
    expect(p.calls[0]?.session_id).toBe("m0");
  });

  test("kind + q predicates apply IN the window scan — matches beyond a naive line window are found", async () => {
    await writeFixture(homeBase, pageFixture());
    const byKind = await readBrainCallsPage(homeBase, { ...basePage, kind: "critical" });
    expect(byKind.calls.map((c) => c.session_id)).toEqual(["m0"]); // only severity=high row
    expect(byKind.total).toBe(1);
    expect(byKind.hasOlder).toBe(false);
    expect(byKind.hasNewer).toBe(false);
    const byQ = await readBrainCallsPage(homeBase, { ...basePage, query: "OLD TURN" });
    expect(byQ.calls.map((c) => c.session_id)).toEqual(["o0", "o1", "o2", "o3", "o4"]);
    expect(byQ.total).toBe(5);
  });

  test("no-bubble fired rows are not display-eligible: consume no slot, excluded from total", async () => {
    const calls = pageFixture();
    calls.push({ ts: "2026-05-19T15:00:00Z", session: "nb", status: "fired", omit_bubble: true });
    await writeFixture(homeBase, calls);
    const p = await readBrainCallsPage(homeBase, basePage);
    expect(p.calls.map((c) => c.session_id)).not.toContain("nb");
    expect(p.calls[p.calls.length - 1]?.session_id).toBe("n4");
    expect(p.total).toBe(15);
  });

  test("project filter applies in-window; unknown project is ignored; projects listed pre-project-filter", async () => {
    const calls = pageFixture();
    calls.push(
      { ts: "2026-05-19T12:00:00Z", session: "b1", status: "fired", cwd: "/Users/foo/projB", bubble_short: "projB turn 1" },
      { ts: "2026-05-19T12:00:01Z", session: "b2", status: "fired", cwd: "/Users/foo/projB", bubble_short: "projB turn 2" },
    );
    await writeFixture(homeBase, calls);
    const p = await readBrainCallsPage(homeBase, { ...basePage, project: "projB" });
    expect(p.calls.map((c) => c.session_id)).toEqual(["b1", "b2"]);
    expect(p.total).toBe(2);
    expect(p.projects).toEqual(["projA", "projB"]);
    const unknown = await readBrainCallsPage(homeBase, { ...basePage, project: "no-such" });
    expect(unknown.total).toBe(17); // guard: bogus project param filters nothing
  });

  test("malformed timestamps are excluded from turn windows (cursor placement needs a valid time)", async () => {
    const calls = pageFixture();
    calls.push({ ts: "not-a-date", session: "bad", status: "fired" });
    await writeFixture(homeBase, calls);
    const p = await readBrainCallsPage(homeBase, basePage);
    expect(p.calls.map((c) => c.session_id)).not.toContain("bad");
    expect(p.total).toBe(15);
  });

  test("missing file → empty page", async () => {
    const p = await readBrainCallsPage(homeBase, basePage);
    expect(p).toEqual({ calls: [], hasOlder: false, hasNewer: false, total: 0, projects: [] });
  });

  test("empty cursor page (before older than everything) exposes no anchors — hasOlder false", async () => {
    await writeFixture(homeBase, pageFixture());
    const p = await readBrainCallsPage(homeBase, { ...basePage, before: new Date("2020-01-01T00:00:00Z") });
    expect(p.calls).toEqual([]);
    expect(p.hasOlder).toBe(false);
    expect(p.hasNewer).toBe(true);
  });

  test("telemetry windowMode=turns: page fields + newest-first render order + per-page totals", async () => {
    await writeFixture(homeBase, pageFixture());
    const t = await readCriticTelemetry(homeBase, now, {
      windowMode: "turns",
      status: "fired",
      limit: 8,
    });
    expect(t.recent.map((c) => c.session_id)).toEqual(["n4", "n3", "n2", "n1", "n0", "m4", "m3", "m2"]);
    expect(t.totalInRange).toBe(15);
    expect(t.hasMore).toBe(true);
    expect(t.hasNewer).toBe(false);
    expect(t.windowOldestTs).toBe(mTs(2));
    expect(t.windowNewestTs).toBe(nTs(4));
    expect(t.projects).toEqual(["projA"]);
    // tokens/$ stay contextual to the visible page (8 × 150 tok / $0.001).
    expect(t.totals.tokens).toBe(1200);
    expect(t.totals.cost_usd).toBeCloseTo(0.008, 10);
  });

  test("telemetry windowMode=turns + sort=oldest: first page anchored at the range's oldest end, chronological render", async () => {
    await writeFixture(homeBase, pageFixture());
    const t = await readCriticTelemetry(homeBase, now, {
      windowMode: "turns",
      status: "fired",
      sort: "oldest",
      limit: 8,
    });
    expect(t.recent.map((c) => c.session_id)).toEqual(["o0", "o1", "o2", "o3", "o4", "m0", "m1", "m2"]);
    expect(t.hasMore).toBe(false);
    expect(t.hasNewer).toBe(true);
    expect(t.windowNewestTs).toBe(mTs(2));
  });

  test("telemetry windowMode=turns + after cursor pages toward newer", async () => {
    await writeFixture(homeBase, pageFixture());
    const t = await readCriticTelemetry(homeBase, now, {
      windowMode: "turns",
      status: "fired",
      after: new Date(mTs(2)),
      limit: 8,
    });
    expect(t.recent.map((c) => c.session_id)).toEqual(["n4", "n3", "n2", "n1", "n0", "m4", "m3"]);
    expect(t.hasMore).toBe(true);
    expect(t.hasNewer).toBe(false);
  });
});

describe("family filter (Brain select v2 T7 — filter-aware window)", () => {
  test("family=codebuddy returns only codebuddy-built rows, and the window counts THEM", async () => {
    await writeFixture(homeBase, [
      { ts: "2026-05-19T14:00:00Z", session: "s1", status: "fired", authorFamily: "codebuddy" },
      { ts: "2026-05-19T14:05:00Z", session: "s2", status: "fired", authorFamily: "codex" },
      { ts: "2026-05-19T14:10:00Z", session: "s3", status: "fired", authorFamily: "codebuddy" },
    ] as never);
    const t = await readCriticTelemetry(homeBase, now, { family: "codebuddy", windowMode: "turns", limit: 20 });
    expect(t.recent.length).toBe(2);
    expect(t.recent.every((c) => (c.authorFamily || "claude") === "codebuddy")).toBe(true);
    expect(t.activeFamily).toBe("codebuddy");
  });

  test("family=claude matches rows with absent/empty authorFamily (the default)", async () => {
    await writeFixture(homeBase, [
      { ts: "2026-05-19T14:00:00Z", session: "s1", status: "fired" }, // no authorFamily
      { ts: "2026-05-19T14:05:00Z", session: "s2", status: "fired", authorFamily: "codex" },
    ] as never);
    const t = await readCriticTelemetry(homeBase, now, { family: "claude", windowMode: "turns", limit: 20 });
    expect(t.recent.length).toBe(1);
    expect(t.recent[0]?.session_id).toBe("s1");
  });

  test("no family filter → all rows (back-compat)", async () => {
    await writeFixture(homeBase, [
      { ts: "2026-05-19T14:00:00Z", session: "s1", status: "fired", authorFamily: "codebuddy" },
      { ts: "2026-05-19T14:05:00Z", session: "s2", status: "fired", authorFamily: "codex" },
    ] as never);
    const t = await readCriticTelemetry(homeBase, now, { windowMode: "turns", limit: 20 });
    expect(t.recent.length).toBe(2);
    expect(t.activeFamily ?? null).toBeNull();
  });
});
