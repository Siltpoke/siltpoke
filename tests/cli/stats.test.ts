import { test, expect, beforeEach, afterEach } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runStats, formatCriticTelemetrySection, formatMemorySection } from "../../src/cli/stats";
import { appendUsageEvent } from "../../src/state/usage";
import {
  recordGateDecision,
  recordGuardReject,
  recordToolRun,
} from "../../src/state/critic-counters";
import { writeMemory, emptyMemory, type CoreMemory } from "../../src/memory/memory";

let tmpHome: string;
let homeBase: string;

beforeEach(() => {
  tmpHome = mkdtempSync(join(tmpdir(), "siltpoke-stats-"));
  homeBase = join(tmpHome, ".siltpoke");
  mkdirSync(homeBase, { recursive: true });
});

afterEach(() => {
  rmSync(tmpHome, { recursive: true, force: true });
});

test("runStats: no events → zeros + default trigger mode", async () => {
  const r = await runStats({ homeBase, now: () => new Date() });
  expect(r.brain_calls).toBe(0);
  expect(r.reflections).toBe(0);
  expect(r.budget_stage).toBe("ok");
  expect(r.trigger_mode).toBe("gates");
  expect(r.quiet_active).toBe(false);
});

test("runStats: aggregates today's events", async () => {
  const now = new Date();
  await appendUsageEvent(homeBase, {
    ts: now.toISOString(),
    kind: "main",
    session_id: "s",
    input_tokens: 100,
    output_tokens: 200,
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: 0,
    total_cost_usd: 0.001,
  });
  await appendUsageEvent(homeBase, {
    ts: now.toISOString(),
    kind: "reflection",
    session_id: "s",
    input_tokens: 30,
    output_tokens: 60,
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: 0,
    total_cost_usd: 0.0002,
  });
  const r = await runStats({ homeBase, now: () => now });
  expect(r.brain_calls).toBe(1);
  expect(r.reflections).toBe(1);
  expect(r.total_input_tokens).toBe(130);
  expect(r.total_output_tokens).toBe(260);
  expect(r.total_cost_usd).toBeCloseTo(0.0012, 5);
});

test("runStats: budget_stage reflects soft threshold", async () => {
  writeFileSync(
    join(homeBase, "config.json"),
    JSON.stringify({
      budget: { dailyTokenLimit: 1000, softWarnAtPercent: 80 },
    }),
  );
  const now = new Date();
  await appendUsageEvent(homeBase, {
    ts: now.toISOString(),
    kind: "main",
    session_id: "s",
    input_tokens: 850,
    output_tokens: 0,
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: 0,
    total_cost_usd: 0,
  });
  const r = await runStats({ homeBase, now: () => now });
  expect(r.budget_stage).toBe("soft");
  expect(r.used_pct).toBe(85);
});

test("runStats: quiet_active reflects current time relative to config", async () => {
  writeFileSync(
    join(homeBase, "config.json"),
    JSON.stringify({
      quietHours: { start: "00:00", end: "23:59", timezone: "local" },
    }),
  );
  const now = new Date();
  now.setHours(12, 0, 0, 0);
  const r = await runStats({ homeBase, now: () => now });
  expect(r.quiet_active).toBe(true);
});

// ---------------------------------------------------------------------------
// Critic telemetry surface
// ---------------------------------------------------------------------------

test("runStats: criticCounters absent when no runs today", async () => {
  const r = await runStats({ homeBase });
  expect(r.criticCounters).toBeUndefined();
});

test("runStats: criticCounters present after gate decisions recorded", async () => {
  await recordGateDecision(homeBase, "NORMAL");
  await recordGateDecision(homeBase, "HARD_SUPPRESS");
  await recordGateDecision(homeBase, "PASSIVE_BUBBLE");

  const r = await runStats({ homeBase });
  expect(r.criticCounters).toBeDefined();
  expect(r.criticCounters?.totalCritiqueRuns).toBe(3);
  expect(r.criticCounters?.normalAttemptCount).toBe(1);
  expect(r.criticCounters?.hardSuppressCount).toBe(1);
  expect(r.criticCounters?.passiveBubbleCount).toBe(1);
  expect(r.criticCounters?.abstentionCount).toBe(1);
});

test("formatCriticTelemetrySection: returns empty string for undefined telemetry", () => {
  const output = formatCriticTelemetrySection(undefined);
  expect(output).toBe("");
});

test("formatCriticTelemetrySection: returns empty string for zero runs", () => {
  // Build a zero-run telemetry by not recording anything
  const output = formatCriticTelemetrySection({
    date: "2026-05-16",
    totalCritiqueRuns: 0,
    toolStatusCounts: {
      tsc: { ok: 0, not_applicable: 0, not_installed: 0, timeout: 0, error: 0, output_too_large: 0 },
      eslint: { ok: 0, not_applicable: 0, not_installed: 0, timeout: 0, error: 0, output_too_large: 0 },
      "git-diff": { ok: 0, not_applicable: 0, not_installed: 0, timeout: 0, error: 0, output_too_large: 0 },
      ripgrep: { ok: 0, not_applicable: 0, not_installed: 0, timeout: 0, error: 0, output_too_large: 0 },
    },
    abstentionCount: 0,
    hardSuppressCount: 0,
    passiveBubbleCount: 0,
    normalAttemptCount: 0,
    normalRejectedCount: 0,
    guardRejectReasons: {},
  });
  expect(output).toBe("");
});

test("formatCriticTelemetrySection: output includes 'Critic' header", async () => {
  await recordGateDecision(homeBase, "NORMAL");
  await recordToolRun(homeBase, "tsc", "ok");

  const r = await runStats({ homeBase });
  expect(r.criticCounters).toBeDefined();
  const section = formatCriticTelemetrySection(r.criticCounters);
  expect(section).toContain("=== Code Review ===");
  expect(section).toContain("total runs today: 1");
  expect(section).toContain("tsc");
});

test("formatCriticTelemetrySection: abstention rate >20% emits warning line", async () => {
  // 3 HARD_SUPPRESS out of 5 total = 60%
  await recordGateDecision(homeBase, "HARD_SUPPRESS");
  await recordGateDecision(homeBase, "HARD_SUPPRESS");
  await recordGateDecision(homeBase, "HARD_SUPPRESS");
  await recordGateDecision(homeBase, "NORMAL");
  await recordGateDecision(homeBase, "NORMAL");

  const r = await runStats({ homeBase });
  const section = formatCriticTelemetrySection(r.criticCounters);
  expect(section).toContain("abstention rate above 20%");
});

test("formatCriticTelemetrySection: no warning when abstention rate ≤20%", async () => {
  // 1 HARD_SUPPRESS out of 10 = 10%
  await recordGateDecision(homeBase, "HARD_SUPPRESS");
  for (let i = 0; i < 9; i++) {
    await recordGateDecision(homeBase, "NORMAL");
  }

  const r = await runStats({ homeBase });
  const section = formatCriticTelemetrySection(r.criticCounters);
  expect(section).not.toContain("abstention rate above 20%");
});

test("formatCriticTelemetrySection: top guard rejects displayed", async () => {
  await recordGateDecision(homeBase, "NORMAL");
  await recordGuardReject(homeBase, "snippet not in evidence_corpus: TS2304: Cannot find name foo");

  const r = await runStats({ homeBase });
  const section = formatCriticTelemetrySection(r.criticCounters);
  expect(section).toContain("top guard rejects");
  expect(section).toContain("snippet not in evidence_corpus");
});

// ---------------------------------------------------------------------------
// pending_facts in stats
// ---------------------------------------------------------------------------

function makePendingFact(id: string): CoreMemory["facts"][number] {
  return {
    id,
    text: `Pending fact ${id}`,
    source_session_id: null,
    confidence: 0.75,
    status: "pending",
    created_at: new Date().toISOString(),
    last_seen_at: new Date().toISOString(),
    supersedes: null,
    superseded_by: null,
    pinned: false,
    recall_count: 0,
    retired_reason: null,
    stability: "durable",
    learned_from: null,
    last_confirmed_at: null,
    expires_at: null,
        save_reason: null,
    invalid_at: null,
    events: [],
  };
}

test("runStats: 3 pending facts → pending_facts: 3", async () => {
  const mem: CoreMemory = {
    ...emptyMemory(),
    facts: [
      makePendingFact("f-001"),
      makePendingFact("f-002"),
      makePendingFact("f-003"),
    ],
  };
  await writeMemory(homeBase, mem);

  const r = await runStats({ homeBase });
  expect(r.pending_facts).toBe(3);
});

test("runStats: no pending facts → pending_facts: 0", async () => {
  const mem: CoreMemory = {
    ...emptyMemory(),
    facts: [
      { ...makePendingFact("f-active"), status: "active" },
    ],
  };
  await writeMemory(homeBase, mem);

  const r = await runStats({ homeBase });
  expect(r.pending_facts).toBe(0);
});

test("runStats: no memory file → pending_facts: 0", async () => {
  const r = await runStats({ homeBase });
  expect(r.pending_facts).toBe(0);
});

test("runStats: corrupted memory.json → pending_facts: 0, stats completes", async () => {
  writeFileSync(join(homeBase, "memory.json"), "NOT_VALID_JSON{{{{");

  const r = await runStats({ homeBase });
  expect(r.pending_facts).toBe(0);
  // Stats itself must still return a valid result.
  expect(r.budget_stage).toBe("ok");
});

test("formatMemorySection: renders === Memory === header and pending_facts line", () => {
  const section = formatMemorySection(3);
  expect(section).toContain("=== Memory ===");
  expect(section).toContain("pending_facts: 3");
});

test("formatMemorySection: zero pending_facts shows pending_facts: 0", () => {
  const section = formatMemorySection(0);
  expect(section).toContain("pending_facts: 0");
});
