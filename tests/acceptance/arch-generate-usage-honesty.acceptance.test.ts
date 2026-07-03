/**
 * arch-generate-usage-honesty.acceptance.test.ts — ACCEPTANCE tests for the arch-generate
 * usage-honesty & observability behavior.
 *
 *   - A paid arch-generate run that exits non-zero still produces a
 *     usage-event with an honesty marker — real tokens/cost parsed from the
 *     stdout tail when present (golden: a sample run $0.8542), else the
 *     pre-flight estimate flagged as pure-estimate.
 *   - The daily budget rollup counts real-token entries (including
 *     parsed failed runs) and EXCLUDES pure-estimate entries.
 *
 * REGISTER: outside-observable behavior ONLY.
 *   - The daemon arch-generate HTTP route is driven end-to-end (POST 202 →
 *     poll the detached task registry on disk), same boundary as the daemon
 *     suite: a fake BrainProvider stands in for the real `claude -p` spawn —
 *     the failure is delivered exactly as providers.ts delivers it (a thrown
 *     Error whose message embeds the last-500-char stdout tail).
 *   - Observations: ~/.siltpoke-equivalent temp home's usage-events.jsonl
 *     (the record artifact), tasks.json (proves the run FAILED — the record
 *     line is not a success-path event), the usage.json rollup artifact
 *     written by loadDailyRollup, and the evaluateBudget decision computed
 *     from that rollup (the actual budget-gate input).
 *
 * Anti-vacuous pairing: ONE rollup over a ledger holding BOTH a
 * tail_parsed failed run AND an estimated failed run; the estimated entry is
 * first proven present with input_tokens > 0, then the rollup totals are
 * asserted EXACTLY equal to the tail_parsed figures alone — inclusion of the
 * estimate would break the equality, absence of the estimate line would break
 * the presence check.
 *
 * No src/ file was modified for this test file. Run: bun test tests/acceptance/arch-generate-usage-honesty.acceptance.test.ts
 */
import { afterEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { mountRepoGraphRoutes } from "../../src/daemon/routes/repo-graph.tsx";
import type { BrainProvider } from "../../src/explain/explain";
import type { UsageEvent } from "../../src/state/usage";
import { loadDailyRollup } from "../../src/state/usage";
import { evaluateBudget, type BudgetConfig } from "../../src/state/budget-config";

const HASH = "ac8ac9feed01";
const tmps: string[] = [];
afterEach(() => {
  for (const d of tmps.splice(0)) rmSync(d, { recursive: true, force: true });
});

// ── Fixtures ─────────────────────────────────────────────────────────────────

/** Minimal-but-valid repo-graph store so the route resolves the repo and the
 * estimate fallback has a graph to price. Same shape as the daemon suite. */
function seedHome(): { home: string } {
  const home = mkdtempSync(join(tmpdir(), "sp-acc-taskb-"));
  tmps.push(home);
  const projectRoot = join(home, "proj");
  mkdirSync(projectRoot, { recursive: true });
  const storageDir = join(home, "repo-memory", HASH);
  mkdirSync(storageDir, { recursive: true });
  const graph = {
    schemaVersion: 1,
    nodes: [
      { id: "file:src/a.ts:", type: "file", name: "a.ts", path: "src/a.ts", lineRange: [1, 60] },
      { id: "function:src/a.ts:doA", type: "function", name: "doA", path: "src/a.ts", lineRange: [5, 30], signature: "export function doA(): void" },
      { id: "file:src/b.ts:", type: "file", name: "b.ts", path: "src/b.ts", lineRange: [1, 60] },
      { id: "function:src/b.ts:doB", type: "function", name: "doB", path: "src/b.ts", lineRange: [5, 30], signature: "export function doB(): void" },
    ],
    edges: [],
  };
  writeFileSync(join(storageDir, "graph.json"), JSON.stringify(graph));
  writeFileSync(
    join(storageDir, "meta.json"),
    JSON.stringify({
      schemaVersion: 1,
      project_root: projectRoot,
      proj_hash: HASH,
      last_indexed_ts: "2026-06-10T00:00:00Z",
      build_duration_ms: 1,
      counters: { nodes: { file: 2, function: 2, class: 0, symbol: 0 }, edges: { imports: 0 } },
    }),
  );
  return { home };
}

// Golden: a sample run sample figures ($0.8542 / 150000 input), embedded the way
// providers.ts embeds a failed run's stdout tail in the thrown error message.
// The tail is truncated mid-stream (starts with `,"total…`, ends `}]`) — the
// realistic last-500-chars shape, NOT a clean parseable JSON document.
const GOLDEN = {
  total_cost_usd: 0.8542,
  input_tokens: 150000,
  cache_creation_input_tokens: 48211,
  cache_read_input_tokens: 1024,
  output_tokens: 31,
} as const;

const TAIL_FAIL_MSG =
  'claude -p exited 1: stdout tail: ,"total_cost_usd":0.8542,"usage":' +
  '{"input_tokens":150000,"cache_creation_input_tokens":48211,' +
  '"cache_read_input_tokens":1024,"output_tokens":31}}]';

/** Paid run that failed but whose captured tail carries the real usage. */
const tailFailProvider: BrainProvider = async () => {
  throw new Error(TAIL_FAIL_MSG);
};

/** Paid run that failed with NO recoverable usage in the tail (OOM kill). */
const blindFailProvider: BrainProvider = async () => {
  throw new Error("claude -p exited 137");
};

function mount(home: string, provider: BrainProvider): Hono {
  const app = new Hono();
  mountRepoGraphRoutes(app, { cwd: home, home, secret: "s", archBrainProvider: provider });
  return app;
}

async function postGenerate(app: Hono): Promise<Response> {
  return app.request("/api/repo-graph/arch/generate", {
    method: "POST",
    headers: { "content-type": "application/json", "X-Siltpoke-Secret": "s" },
    body: JSON.stringify({ repo: HASH }),
  });
}

function readEvents(home: string): UsageEvent[] {
  const p = join(home, "usage-events.jsonl");
  if (!existsSync(p)) return [];
  return readFileSync(p, "utf8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l) as UsageEvent);
}

function latestTaskStatus(home: string): string | undefined {
  const p = join(home, "tasks.json");
  if (!existsSync(p)) return undefined;
  const tasks = JSON.parse(readFileSync(p, "utf8")) as Array<{ status: string }>;
  return tasks[0]?.status;
}

/** Detached run: 202 returns before the record write — poll the record for
 * the expected line count (the registry flips terminal BEFORE the append). */
async function pollEvents(home: string, n: number, timeoutMs = 4000): Promise<UsageEvent[]> {
  const start = Date.now();
  let events = readEvents(home);
  while (events.length < n && Date.now() - start <= timeoutMs) {
    await new Promise((r) => setTimeout(r, 5));
    events = readEvents(home);
  }
  return events;
}

// ── failed paid arch-generate run still records a usage-event ────────────────

describe("failed paid arch-generate run still lands in usage-events.jsonl with an honesty marker", () => {
  test("test_nonzero_exit_with_parseable_tail_ledgers_the_REAL_figures (golden a sample run: $0.8542 / 150000 in)", async () => {
    const { home } = seedHome();
    const app = mount(home, tailFailProvider);

    const res = await postGenerate(app);
    expect(res.status).toBe(202);

    const events = await pollEvents(home, 1);
    // The run FAILED (not a success-path event sneaking through):
    expect(latestTaskStatus(home)).toBe("failed");
    // …and a usage-event line EXISTS for it:
    expect(events).toHaveLength(1);
    const ev = events[0];
    expect(ev.kind).toBe("arch_generate");
    // Honesty marker present and naming the real-recovery basis:
    expect(ev.basis).toBe("tail_parsed");
    // sample figures, not an estimate — full golden a sample run shape:
    expect(ev.total_cost_usd).toBeCloseTo(GOLDEN.total_cost_usd, 5);
    expect(ev.input_tokens).toBe(GOLDEN.input_tokens);
    expect(ev.cache_creation_input_tokens).toBe(GOLDEN.cache_creation_input_tokens);
    expect(ev.cache_read_input_tokens).toBe(GOLDEN.cache_read_input_tokens);
    expect(ev.output_tokens).toBe(GOLDEN.output_tokens);
  });

  test("test_nonzero_exit_with_unparseable_tail_ledgers_the_estimate_flagged_pure_estimate", async () => {
    const { home } = seedHome();
    const app = mount(home, blindFailProvider);

    const res = await postGenerate(app);
    expect(res.status).toBe(202);

    const events = await pollEvents(home, 1);
    expect(latestTaskStatus(home)).toBe("failed");
    expect(events).toHaveLength(1);
    const ev = events[0];
    expect(ev.kind).toBe("arch_generate");
    // Pure-estimate flag (the honesty marker for the unrecoverable case):
    expect(ev.basis).toBe("estimated");
    // The estimate is a model output over the seeded graph, not a constant —
    // pin the honesty invariants: a non-trivial figure was recorded, and it
    // is NOT the golden tail's figures (nothing parseable was in this tail).
    expect(ev.input_tokens).toBeGreaterThan(0);
    expect(ev.total_cost_usd ?? 0).toBeGreaterThan(0);
    expect(ev.input_tokens).not.toBe(GOLDEN.input_tokens);
  });
});

// ── daily rollup counts real usage, excludes pure estimates ──────────────────

describe("daily rollup (budget-gate input) counts tail_parsed failed runs, excludes pure-estimate entries", () => {
  test("test_rollup_over_one_tail_parsed_plus_one_estimated_event_shows_exactly_the_tail_parsed_tokens", async () => {
    const { home } = seedHome();

    // Event 1 — failed run, REAL usage recovered from the tail.
    await postGenerate(mount(home, tailFailProvider));
    await pollEvents(home, 1);
    // Event 2 — failed run, nothing recoverable → pure-estimate entry.
    await postGenerate(mount(home, blindFailProvider));
    const events = await pollEvents(home, 2);

    // PRESENCE half of the anti-vacuous pair: both entries really exist in
    // the same ledger, and the estimated one carries non-zero tokens — so if
    // the rollup were counting it, the totals below could NOT match exactly.
    expect(events).toHaveLength(2);
    const bases = events.map((e) => e.basis).sort();
    expect(bases).toEqual(["estimated", "tail_parsed"]);
    const estimated = events.find((e) => e.basis === "estimated") as UsageEvent;
    expect(estimated.input_tokens).toBeGreaterThan(0);

    // ABSENCE half: the rollup totals equal the tail_parsed figures ALONE.
    const now = new Date();
    const rollup = await loadDailyRollup(home, now);
    expect(rollup.total_input_tokens).toBe(GOLDEN.input_tokens); // 150000, not 150000 + est
    expect(rollup.total_output_tokens).toBe(GOLDEN.output_tokens); // 31
    expect(rollup.total_cache_tokens).toBe(
      GOLDEN.cache_creation_input_tokens + GOLDEN.cache_read_input_tokens, // 49235
    );

    // The rollup ARTIFACT on disk (what other readers consume) says the same.
    const persisted = JSON.parse(
      readFileSync(join(home, "usage.json"), "utf8"),
    ) as { total_input_tokens: number; total_output_tokens: number };
    expect(persisted.total_input_tokens).toBe(GOLDEN.input_tokens);
    expect(persisted.total_output_tokens).toBe(GOLDEN.output_tokens);

    // And therefore the budget gate's decision is computed from the real
    // tokens only: used = in + out + round(cache × 0.1).
    const config: BudgetConfig = {
      dailyTokenLimit: 1_000_000,
      perCallMaxInputTokens: 4_000,
      softWarnAtPercent: 80,
      hardStopAtPercent: 100,
      softModeOverride: "on_demand",
      resetAtMinutes: 0,
    };
    const decision = evaluateBudget(rollup, config);
    const expectedUsed =
      GOLDEN.input_tokens +
      GOLDEN.output_tokens +
      Math.round(
        (GOLDEN.cache_creation_input_tokens + GOLDEN.cache_read_input_tokens) * 0.1,
      ); // 207941 — any leakage of the estimated entry shifts this number
    expect(decision.remaining_tokens).toBe(config.dailyTokenLimit - expectedUsed);
  });
});
