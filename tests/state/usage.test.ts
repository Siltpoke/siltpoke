import { test, expect, beforeEach, afterEach } from "bun:test";
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
  existsSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  appendUsageEvent,
  ledgerBrainCall,
  loadDailyRollup,
  dayKey,
  type UsageEvent,
} from "../../src/state/usage";

let tmp: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "siltpoke-usage-"));
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

function event(overrides: Partial<UsageEvent> = {}): UsageEvent {
  return {
    ts: "2026-05-14T10:00:00Z",
    kind: "main",
    session_id: "s-1",
    input_tokens: 10,
    output_tokens: 20,
    cache_creation_input_tokens: 100,
    cache_read_input_tokens: 50,
    total_cost_usd: 0.001,
    ...overrides,
  };
}

test("dayKey: returns YYYY-MM-DD in local TZ shifted by resetAt", () => {
  const noon = new Date("2026-05-14T12:00:00Z");
  expect(dayKey(noon, 0)).toMatch(/^2026-05-1[34]$/);
});

function readLedger(): Array<Record<string, unknown>> {
  return readFileSync(join(tmp, "usage-events.jsonl"), "utf8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l));
}

test("ledgerBrainCall: real cost → basis real, cost passed through", async () => {
  await ledgerBrainCall(tmp, {
    kind: "explain",
    session_id: "s1",
    usage: {
      input_tokens: 100,
      output_tokens: 50,
      cache_read_input_tokens: 10,
      total_cost_usd: 0.4,
    },
  });
  const [line] = readLedger();
  expect(line).toMatchObject({
    kind: "explain",
    session_id: "s1",
    input_tokens: 100,
    output_tokens: 50,
    cache_read_input_tokens: 10,
    total_cost_usd: 0.4,
    basis: "real",
  });
});

test("ledgerBrainCall: no cost + model → basis derived via computeCost", async () => {
  await ledgerBrainCall(tmp, {
    kind: "chat",
    session_id: "c1",
    model: "claude-haiku-4-5",
    usage: { input_tokens: 1000, output_tokens: 1000 },
  });
  const [line] = readLedger();
  // haiku: 1000/1M*$1 + 1000/1M*$5 = 0.006
  expect(line.basis).toBe("derived");
  expect(line.total_cost_usd as number).toBeCloseTo(0.006, 8);
  expect(line.cache_creation_input_tokens).toBe(0); // defaulted
  expect(line.cache_read_input_tokens).toBe(0);
});

test("ledgerBrainCall: no cost + no model → cost null, no basis", async () => {
  await ledgerBrainCall(tmp, {
    kind: "explain",
    session_id: "s2",
    usage: { input_tokens: 5, output_tokens: 5 },
  });
  const [line] = readLedger();
  expect(line.total_cost_usd).toBeNull();
  expect(line.basis).toBeUndefined();
});

test("ledgerBrainCall: chat kind survives parseLine → counts in rollup", async () => {
  const now = new Date();
  await ledgerBrainCall(tmp, {
    kind: "chat",
    session_id: "c2",
    model: "claude-haiku-4-5",
    usage: { input_tokens: 2000, output_tokens: 0 },
  });
  const rollup = await loadDailyRollup(tmp, now);
  expect(rollup.total_input_tokens).toBe(2000);
});

test("appendUsageEvent creates file on first append", async () => {
  const path = join(tmp, "usage-events.jsonl");
  expect(existsSync(path)).toBe(false);
  await appendUsageEvent(tmp, event());
  const raw = readFileSync(path, "utf8");
  expect(JSON.parse(raw.trim()).session_id).toBe("s-1");
});

test("appendUsageEvent appends without truncating", async () => {
  await appendUsageEvent(tmp, event({ session_id: "a" }));
  await appendUsageEvent(tmp, event({ session_id: "b" }));
  await appendUsageEvent(tmp, event({ session_id: "c" }));
  const lines = readFileSync(join(tmp, "usage-events.jsonl"), "utf8")
    .trim()
    .split("\n");
  expect(lines).toHaveLength(3);
});

test("loadDailyRollup: zero rollup when no events file", async () => {
  const now = new Date("2026-05-14T12:00:00Z");
  const r = await loadDailyRollup(tmp, now);
  expect(r.total_input_tokens).toBe(0);
  expect(r.brain_calls).toBe(0);
});

test("loadDailyRollup: aggregates today's events", async () => {
  const today = new Date();
  const todayIso = today.toISOString();
  await appendUsageEvent(tmp, event({ ts: todayIso, input_tokens: 5 }));
  await appendUsageEvent(
    tmp,
    event({ ts: todayIso, input_tokens: 7, kind: "reflection" }),
  );
  const r = await loadDailyRollup(tmp, today);
  expect(r.total_input_tokens).toBe(12);
  expect(r.brain_calls).toBe(1);
  expect(r.reflections).toBe(1);
});

test("loadDailyRollup: filters out events from other days", async () => {
  await appendUsageEvent(tmp, event({ ts: "2020-01-01T00:00:00Z", input_tokens: 99 }));
  const today = new Date();
  await appendUsageEvent(tmp, event({ ts: today.toISOString(), input_tokens: 3 }));
  const r = await loadDailyRollup(tmp, today);
  expect(r.total_input_tokens).toBe(3);
});

test("loadDailyRollup: writes rollup file", async () => {
  const today = new Date();
  await appendUsageEvent(tmp, event({ ts: today.toISOString(), input_tokens: 5 }));
  await loadDailyRollup(tmp, today);
  expect(existsSync(join(tmp, "usage.json"))).toBe(true);
});

test("loadDailyRollup: malformed lines are silently skipped", async () => {
  const today = new Date();
  writeFileSync(
    join(tmp, "usage-events.jsonl"),
    "not json\n" +
      JSON.stringify(event({ ts: today.toISOString(), input_tokens: 4 })) +
      "\nalso bad\n",
  );
  const r = await loadDailyRollup(tmp, today);
  expect(r.total_input_tokens).toBe(4);
  expect(r.brain_calls).toBe(1);
});

test("loadDailyRollup: sums cost for arch_generate + explain kinds", async () => {
  // Long-task runs append usage-events with new kind values. Their cost
  // must roll into the daily total exactly like the critic's `main` kind —
  // otherwise a paid generate/explain stays invisible to external token accounting (the
  // honest-metrics linchpin: a paid op siltpoke MUST record).
  const today = new Date();
  const iso = today.toISOString();
  await appendUsageEvent(tmp, event({ ts: iso, kind: "arch_generate", total_cost_usd: 0.4 }));
  await appendUsageEvent(tmp, event({ ts: iso, kind: "explain", total_cost_usd: 0.05 }));
  const r = await loadDailyRollup(tmp, today);
  expect(r.total_cost_usd).toBeCloseTo(0.45, 5);
  // New kinds are neither critic `main` nor `reflection` — they don't inflate
  // those counters (they're long-task runs, not Brain critiques).
  expect(r.brain_calls).toBe(0);
  expect(r.reflections).toBe(0);
});

test("loadDailyRollup: sums token breakdown for the new kinds", async () => {
  const today = new Date();
  await appendUsageEvent(
    tmp,
    event({ ts: today.toISOString(), kind: "arch_generate", input_tokens: 100, output_tokens: 50 }),
  );
  const r = await loadDailyRollup(tmp, today);
  expect(r.total_input_tokens).toBe(100);
  expect(r.total_output_tokens).toBe(50);
});

test("loadDailyRollup: cache tokens sum (creation + read)", async () => {
  const today = new Date();
  await appendUsageEvent(
    tmp,
    event({
      ts: today.toISOString(),
      cache_creation_input_tokens: 1000,
      cache_read_input_tokens: 500,
    }),
  );
  const r = await loadDailyRollup(tmp, today);
  expect(r.total_cache_tokens).toBe(1500);
});

// ── failed-run ledger — basis semantics ─────────────────────────────────────

test("rollup excludes estimated basis from token sums", async () => {
  // User-locked budget semantics: real tokens count toward the daily budget,
  // pure estimates don't. `basis: "estimated"` entries exist for honesty in the
  // ledger but must NOT consume token budget (evaluateBudget reads these sums).
  const today = new Date();
  const iso = today.toISOString();
  await appendUsageEvent(
    tmp,
    event({ ts: iso, kind: "arch_generate", input_tokens: 100, output_tokens: 50, cache_creation_input_tokens: 10, cache_read_input_tokens: 5 }),
  );
  await appendUsageEvent(
    tmp,
    event({
      ts: iso,
      kind: "arch_generate",
      basis: "estimated",
      input_tokens: 70_000,
      output_tokens: 6_000,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
      total_cost_usd: 0.9,
    }),
  );
  const r = await loadDailyRollup(tmp, today);
  expect(r.total_input_tokens).toBe(100);
  expect(r.total_output_tokens).toBe(50);
  expect(r.total_cache_tokens).toBe(15);
});

test("rollup includes tail_parsed basis in token sums", async () => {
  // tail_parsed = REAL tokens recovered from a failed run's stdout tail — they
  // were billed, so they count toward the budget exactly like legacy entries.
  const today = new Date();
  await appendUsageEvent(
    tmp,
    event({
      ts: today.toISOString(),
      kind: "arch_generate",
      basis: "tail_parsed",
      input_tokens: 150_000,
      output_tokens: 0,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
      total_cost_usd: 0.8542,
    }),
  );
  const r = await loadDailyRollup(tmp, today);
  expect(r.total_input_tokens).toBe(150_000);
  expect(r.total_cost_usd).toBeCloseTo(0.8542, 5);
});

test("rollup tolerates legacy lines without basis (counts as real)", async () => {
  // Additive schema pin: old jsonl lines have NO basis field — they are legacy
  // real entries and keep counting (no migration, readers must tolerate).
  const today = new Date();
  await appendUsageEvent(tmp, event({ ts: today.toISOString(), input_tokens: 42 }));
  const r = await loadDailyRollup(tmp, today);
  expect(r.total_input_tokens).toBe(42);
});

test("rollup cost sum includes estimated entries (all-numeric cost)", async () => {
  // Cost sum includes all numeric — the estimated entry's estUsd is
  // the honest best-known spend figure for a burn whose real cost was lost.
  // Only TOKEN sums (the budget currency) exclude estimated.
  const today = new Date();
  const iso = today.toISOString();
  await appendUsageEvent(tmp, event({ ts: iso, kind: "arch_generate", total_cost_usd: 0.4 }));
  await appendUsageEvent(
    tmp,
    event({ ts: iso, kind: "arch_generate", basis: "estimated", input_tokens: 70_000, total_cost_usd: 0.9 }),
  );
  const r = await loadDailyRollup(tmp, today);
  expect(r.total_cost_usd).toBeCloseTo(1.3, 5);
});
