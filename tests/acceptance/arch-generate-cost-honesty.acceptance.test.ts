/**
 * arch-generate-cost-honesty.acceptance.test.ts — ACCEPTANCE tests for the arch-generate
 * cost-estimate honesty & observability recalibration.
 *
 *   - The recalibrated estimate lands within ±25% of the computed
 *     `total_cost_usd` for the claude-code-class runs (computed range
 *     $1.4809 – $1.5706; prior formula gave $0.82 ≈ −45%).
 *   - The Generate button's estimate (served by
 *     GET /api/repo-graph/arch/estimate) shows the new, higher honest figure,
 *     response shape unchanged (estUsd flows through), and the REAL-cost
 *     hard-cap gate mechanism is unaffected.
 *
 * REGISTER: outside-observable behavior ONLY — every assertion drives the
 * daemon HTTP routes (same boundary as tests/daemon/); no implementation
 * function is imported for the expected figures.
 *
 * NO SELF-GRADING: the expected USD is recomputed HERE from the raw published
 * rate table (sonnet: in $3 / cacheWrite1h $6 / cacheRead $0.30 / out $15 per
 * Mtok) + the locked estimate decomposition (input @ cacheWrite1h + 31k out
 * @ out + 20k CLI overhead @ cacheWrite1h) — `estimateArchCostUsd` is NEVER
 * called by this file.
 *
 * Anti-vacuous: the OLD figure ($0.82) is asserted to fall OUTSIDE the ±25%
 * acceptance band — the band check is provably capable of failing (and the
 * whole recalibrated-estimate test was run RED against the parent commit of
 * the feat(estimate) change, where the route returned ≈$0.82 for this same
 * fixture).
 *
 * No src/ file was modified for this test file. Run: bun test tests/acceptance/arch-generate-cost-honesty.acceptance.test.ts
 */
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { mountRepoGraphRoutes } from "../../src/daemon/routes/repo-graph.tsx";
import type { BrainProvider } from "../../src/explain/explain";

const HASH = "ac10ac11feed";
const tmps: string[] = [];
afterEach(() => {
  for (const d of tmps.splice(0)) rmSync(d, { recursive: true, force: true });
});

// ── Independent oracle constants (NOT imported from src/) ────────────────────

/** Published sonnet $/Mtok rates (raw rate table — the verifier's own copy). */
const RATE_SONNET_CACHE_WRITE_1H_PER_MTOK = 6; // 2× the $3 input rate
const RATE_SONNET_OUTPUT_PER_MTOK = 15;
/** Locked estimate decomposition: near-cap output assumption +
 * CLI/system-prompt context priced at cold-run cache-write. */
const EXPECTED_OUTPUT_TOKENS = 31_000;
const EXPECTED_CLI_OVERHEAD_TOKENS = 20_000;
/** Ledgered real `total_cost_usd` range for the claude-code-class (160K-budget
 * capped) arch_generate events, 2026-06-10/11 (exact ledger figures —
 * replaced the rounded 1.4809). */
const LEDGERED_LOW_USD = 1.431015;
const LEDGERED_HIGH_USD = 1.5706311;
/** Acceptance band: within ±25% of EVERY computed claude-code-class value (the
 * strict intersection — stronger than ±25% of just one endpoint). */
const BAND_LOW_USD = LEDGERED_HIGH_USD * 0.75; // 1.177973325
const BAND_HIGH_USD = LEDGERED_LOW_USD * 1.25; // 1.851122625
/** The PRIOR formula's figure for this exact class (−45% vs real). */
const OLD_ESTIMATE_USD = 0.82;
/** The context assembler's single-pass budget (its public exported contract —
 * a 160K-capped fixture is what makes this "claude-code class"). */
const CONTEXT_BUDGET_TOKENS = 160_000;

/** Verifier's own recompute of the expected estimate from raw rates. */
function oracleEstimateUsd(estInputTokens: number): number {
  return (
    ((estInputTokens + EXPECTED_CLI_OVERHEAD_TOKENS) / 1e6) * RATE_SONNET_CACHE_WRITE_1H_PER_MTOK +
    (EXPECTED_OUTPUT_TOKENS / 1e6) * RATE_SONNET_OUTPUT_PER_MTOK
  );
}

// ── Fixtures ─────────────────────────────────────────────────────────────────

interface FixtureNode {
  id: string;
  type: string;
  name: string;
  path: string;
  lineRange: [number, number];
  signature?: string;
}

/** A long-but-under-the-240-char-cap signature so each symbol line carries
 * realistic signature-dense weight (the claude-code-class shape). */
function longSignature(name: string): string {
  return (
    `export async function ${name}(alphaParameterLongName: string, ` +
    `betaParameterLongName: number, gammaParameterLongName: Record<string, unknown>, ` +
    `deltaParameterLongName: boolean): Promise<Map<string, Array<number>>>`
  );
}

/** Build a graph BIG enough that the assembled signatures-only context blows
 * the 160K-token single-pass budget (raw ≈ 250K tokens) → the estimate route
 * returns a budget-CAPPED estInputTokens ≈ 160K: the claude-code class. */
function bigGraphNodes(): FixtureNode[] {
  const nodes: FixtureNode[] = [];
  for (let m = 0; m < 8; m++) {
    for (let f = 0; f < 25; f++) {
      const path = `src/mod${m}/file${String(f).padStart(2, "0")}.ts`;
      nodes.push({ id: `file:${path}:`, type: "file", name: `file${f}.ts`, path, lineRange: [1, 400] });
      for (let s = 0; s < 15; s++) {
        const name = `fn_mod${m}_f${String(f).padStart(2, "0")}_s${String(s).padStart(2, "0")}`;
        nodes.push({
          id: `function:${path}:${name}`,
          type: "function",
          name,
          path,
          lineRange: [5 + s * 20, 20 + s * 20],
          signature: longSignature(name),
        });
      }
    }
  }
  return nodes;
}

/** Tiny 2-subdir graph (mirrors tests/daemon/repo-graph.test.ts archGraph) —
 * used by the hard-cap-gate pair where estimate size is irrelevant. */
function smallGraphNodes(): { nodes: FixtureNode[]; edges: object[] } {
  return {
    nodes: [
      { id: "file:src/cli/a.ts:", type: "file", name: "a.ts", path: "src/cli/a.ts", lineRange: [1, 10] },
      { id: "file:src/brain/b.ts:", type: "file", name: "b.ts", path: "src/brain/b.ts", lineRange: [1, 10] },
      {
        id: "function:src/cli/a.ts:doA",
        type: "function",
        name: "doA",
        path: "src/cli/a.ts",
        lineRange: [1, 5],
        signature: "export function doA(): void",
      },
    ],
    edges: [
      { id: "file:src/cli/a.ts:::imports::../brain/b", source: "file:src/cli/a.ts:", target: "../brain/b", type: "imports", weight: 1 },
    ],
  };
}

/** Seed a temp siltpoke-home with a repo-graph store at repo-memory/<HASH>
 * (same manual-store pattern as arch-generate-usage-honesty.acceptance.test.ts). */
function seedHome(nodes: FixtureNode[], edges: object[] = []): { home: string } {
  const home = mkdtempSync(join(tmpdir(), "sp-acc-taskc-"));
  tmps.push(home);
  const projectRoot = join(home, "proj");
  mkdirSync(projectRoot, { recursive: true });
  const storageDir = join(home, "repo-memory", HASH);
  mkdirSync(storageDir, { recursive: true });
  writeFileSync(join(storageDir, "graph.json"), JSON.stringify({ schemaVersion: 1, nodes, edges }));
  writeFileSync(
    join(storageDir, "meta.json"),
    JSON.stringify({
      schemaVersion: 1,
      project_root: projectRoot,
      proj_hash: HASH,
      last_indexed_ts: "2026-06-10T00:00:00Z",
      build_duration_ms: 1,
      counters: {
        nodes: { file: nodes.filter((n) => n.type === "file").length, function: nodes.filter((n) => n.type === "function").length, class: 0, symbol: 0 },
        edges: { imports: edges.length },
      },
    }),
  );
  return { home };
}

function mount(home: string, provider?: BrainProvider): Hono {
  const app = new Hono();
  mountRepoGraphRoutes(app, { cwd: home, home, secret: "s", archBrainProvider: provider });
  return app;
}

interface EstimatePayload {
  estInputTokens: number;
  estOutputTokens: number;
  estUsd: number;
  model: string;
  contextBytes: number;
  subdirCount: number;
  symbolCount: number;
  capped: boolean;
  droppedSubdirs: string[];
  truncatedSubdirCount: number;
  mayTruncate: boolean; // large-repo generate truncation advisory
}

async function getEstimate(app: Hono): Promise<{ status: number; body: { success: boolean; data: EstimatePayload | null; error: string | null } }> {
  const res = await app.request(`/api/repo-graph/arch/estimate?repo=${HASH}`);
  return { status: res.status, body: (await res.json()) as { success: boolean; data: EstimatePayload | null; error: string | null } };
}

// ── Hard-cap-gate fixtures ────────────────────────────────────────────────────

const EV = [{ file: "src/cli/a.ts", line: 1 }];
const VALID_MODEL_MD = JSON.stringify({
  boundary: "demo",
  bands: [{ id: "core", label: { value: "Core", evidence: EV }, order: 0, members: ["cli", "brain"] }],
  nodes: [
    { id: "cli", kind: "cont", title: { value: "CLI", evidence: EV }, band: { value: "core", evidence: EV }, drillTo: "cli" },
    { id: "brain", kind: "cont", title: { value: "Brain", evidence: EV }, band: { value: "core", evidence: EV }, drillTo: "brain" },
  ],
  edges: [{ source: "cli", target: "brain", verb: { value: "uses", evidence: EV } }],
});

function brainCosting(totalCostUsd: number): BrainProvider {
  return async () => ({
    markdown: VALID_MODEL_MD,
    usage: {
      cache_creation_input_tokens: 180_000,
      cache_read_input_tokens: 20_000,
      input_tokens: 3,
      output_tokens: 31_000,
      total_cost_usd: totalCostUsd,
    },
  });
}

async function postGenerate(app: Hono): Promise<Response> {
  return app.request("/api/repo-graph/arch/generate", {
    method: "POST",
    headers: { "content-type": "application/json", "X-Siltpoke-Secret": "s" },
    body: JSON.stringify({ repo: HASH }),
  });
}

function latestTask(home: string): { status: string; costUsd: number | null } | undefined {
  const p = join(home, "tasks.json");
  if (!existsSync(p)) return undefined;
  return (JSON.parse(readFileSync(p, "utf8")) as Array<{ status: string; costUsd: number | null }>)[0];
}

async function pollTerminal(home: string, timeoutMs = 4000): Promise<void> {
  const start = Date.now();
  while (latestTask(home)?.status === "running" || latestTask(home) === undefined) {
    if (Date.now() - start > timeoutMs) throw new Error("pollTerminal timed out");
    await new Promise((r) => setTimeout(r, 5));
  }
}

function archModelCached(home: string): boolean {
  return existsSync(join(home, "repo-memory", HASH, "arch-model.json"));
}

function readLedger(home: string): Array<{ kind: string; total_cost_usd: number | null; basis?: string }> {
  const p = join(home, "usage-events.jsonl");
  if (!existsSync(p)) return [];
  return readFileSync(p, "utf8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l) as { kind: string; total_cost_usd: number | null; basis?: string });
}

// ── Recalibrated estimate ─────────────────────────────────────────────────────

describe("recalibrated estimate vs the computed claude-code-class burns", () => {
  test("a 160K-budget-capped repo's HTTP estimate lands within ±25% of every computed figure AND matches the independent raw-rate recompute", async () => {
    const { home } = seedHome(bigGraphNodes());
    const { status, body } = await getEstimate(mount(home));
    expect(status).toBe(200);
    expect(body.success).toBe(true);
    const est = body.data!;

    // The fixture really IS the claude-code class: the context assembler hit
    // its single-pass budget (capped) and the estimate's input-token figure
    // sits at the cap (within the assembler's documented rounding slack).
    expect(est.capped).toBe(true);
    expect(est.truncatedSubdirCount).toBeGreaterThan(0);
    expect(est.estInputTokens).toBeLessThanOrEqual(CONTEXT_BUDGET_TOKENS);
    expect(est.estInputTokens).toBeGreaterThanOrEqual(150_000);

    // Core acceptance: within ±25% of the computed range (strict intersection —
    // ±25% of BOTH the $1.4809 and the $1.5706 events simultaneously).
    expect(est.estUsd).toBeGreaterThanOrEqual(BAND_LOW_USD);
    expect(est.estUsd).toBeLessThanOrEqual(BAND_HIGH_USD);

    // NO SELF-GRADING: recompute the expected figure from the raw rate table
    // here in the test ((input + 20K overhead) @ cacheWrite1h $6/Mtok +
    // 31K output @ $15/Mtok) — must agree with the route to <$0.005.
    const expected = oracleEstimateUsd(est.estInputTokens);
    expect(Math.abs(est.estUsd - expected)).toBeLessThan(0.005);
    // And the canonical 160K-class figure from the contract decomposition
    // (160K @ $6 + 20K @ $6 + 31K @ $15 = $1.545) brackets the result.
    expect(oracleEstimateUsd(CONTEXT_BUDGET_TOKENS)).toBeCloseTo(1.545, 3);
    expect(Math.abs(est.estUsd - 1.545)).toBeLessThan(0.07); // ≤160K cap slack only

    // ANTI-VACUOUS: the acceptance band CAN fail — the prior formula's $0.82
    // for this exact class falls OUTSIDE it (and far from today's figure).
    expect(BAND_LOW_USD).toBeLessThan(BAND_HIGH_USD); // band is non-degenerate
    expect(OLD_ESTIMATE_USD).toBeLessThan(BAND_LOW_USD); // 0.82 would FAIL the band
    expect(Math.abs(est.estUsd - OLD_ESTIMATE_USD)).toBeGreaterThan(0.5);
  });
});

// ── Estimate shape + hard-cap mechanism ───────────────────────────────────────

describe("estimate surfaces the honest figure; shape + cap mechanism unchanged", () => {
  test("response shape unchanged: same envelope, same field set, estUsd flows through as the client renders it", async () => {
    const { home } = seedHome(bigGraphNodes());
    const { status, body } = await getEstimate(mount(home));
    expect(status).toBe(200);
    // Envelope: { success, data, error } (project API envelope).
    expect(body.success).toBe(true);
    expect(body.error).toBeNull();
    const est = body.data!;
    // EXACT key set — soft/hard-cap signals are NOT exposed on this route.
    // `mayTruncate` is a large-repo generate truncation advisory; the
    // rest is the original estimate-endpoint shape.
    expect(Object.keys(est).sort()).toEqual([
      "capped",
      "contextBytes",
      "droppedSubdirs",
      "estInputTokens",
      "estOutputTokens",
      "estUsd",
      "mayTruncate",
      "model",
      "subdirCount",
      "symbolCount",
      "truncatedSubdirCount",
    ]);
    expect(est.model).toBe("sonnet");
    expect(typeof est.estUsd).toBe("number");
    expect(Number.isFinite(est.estUsd)).toBe(true);
    expect(typeof est.mayTruncate).toBe("boolean");
    // The dashboard button renders `≈$${estUsd.toFixed(2)} · uses Claude` —
    // the new HONEST (higher) figure is what shows: ≥ $1.18 for this class,
    // not the old $0.82.
    const rendered = `≈$${est.estUsd.toFixed(2)} · uses Claude`;
    expect(rendered).toMatch(/^≈\$\d+\.\d{2} · uses Claude$/);
    expect(est.estUsd).toBeGreaterThan(1.0); // old figure (0.82) can't satisfy this
    // The output assumption surfaced to the client is the recalibrated one.
    expect(est.estOutputTokens).toBe(EXPECTED_OUTPUT_TOKENS);
  });

  test("REAL-cost hard-cap gate unaffected: identical valid run caches a model at $0.40 but is refused at $2.50 (> $2 hard cap) — and the over-cap burn is still computed", async () => {
    const small = smallGraphNodes();

    // Control arm: same model markdown, real cost UNDER the cap → cached.
    const okHome = seedHome(small.nodes, small.edges).home;
    const okApp = mount(okHome, brainCosting(0.4));
    expect((await postGenerate(okApp)).status).toBe(202);
    await pollTerminal(okHome);
    expect(latestTask(okHome)?.status).toBe("done");
    expect(latestTask(okHome)?.costUsd).toBe(0.4);
    expect(archModelCached(okHome)).toBe(true); // proves this markdown IS cacheable

    // Gate arm: SAME markdown, real cost $2.50 > the $2 default hard cap →
    // the run terminates with the real cost recorded but NO model is cached
    // (the cap aborts pre-doc) — mechanism identical to before the estimate
    // recalibration. Anti-vacuous: the control arm above proves the absence
    // here is attributable ONLY to the cap.
    const capHome = seedHome(small.nodes, small.edges).home;
    const capApp = mount(capHome, brainCosting(2.5));
    expect((await postGenerate(capApp)).status).toBe(202);
    await pollTerminal(capHome);
    expect(latestTask(capHome)?.status).toBe("done");
    expect(latestTask(capHome)?.costUsd).toBe(2.5);
    expect(archModelCached(capHome)).toBe(false);

    // Honest-metrics corollary: the refused-but-billed run still hit the
    // usage ledger with its REAL cost (poll: the append runs detached).
    const start = Date.now();
    let events = readLedger(capHome);
    while (events.length < 1 && Date.now() - start <= 4000) {
      await new Promise((r) => setTimeout(r, 5));
      events = readLedger(capHome);
    }
    expect(events.length).toBe(1);
    expect(events[0]!.kind).toBe("arch_generate");
    expect(events[0]!.total_cost_usd).toBe(2.5);
  });
});

// ── null-cost SDK usage must ledger token-derived, never $0/null ─

describe("a run whose SDK usage lacks total_cost_usd ledgers the token-derived cost", () => {
  async function pollLedger(home: string, timeoutMs = 4000): Promise<Array<{ kind: string; total_cost_usd: number | null; basis?: string }>> {
    const start = Date.now();
    let events = readLedger(home);
    while (events.length < 1 && Date.now() - start <= timeoutMs) {
      await new Promise((r) => setTimeout(r, 5));
      events = readLedger(home);
    }
    return events;
  }

  test("successful generate with null total_cost_usd → registry + ledger carry the token-derived figure, not 0/null", async () => {
    const small = smallGraphNodes();
    const { home } = seedHome(small.nodes, small.edges);
    const nullCostProvider: BrainProvider = async () => ({
      markdown: VALID_MODEL_MD,
      usage: {
        cache_creation_input_tokens: 180_000,
        cache_read_input_tokens: 20_000,
        input_tokens: 3,
        output_tokens: 31_000,
        total_cost_usd: null,
      },
    });
    const app = mount(home, nullCostProvider);
    expect((await postGenerate(app)).status).toBe(202);
    await pollTerminal(home);
    // Independent oracle: raw sonnet rates over the token breakdown —
    // 180000×$6e-6 + 19807×$0.30e-6 + 3×$3e-6 + 31000×$15e-6 = $1.5509511.
    const derived = (180_000 * 6 + 20_000 * 0.3 + 3 * 3 + 31_000 * 15) / 1e6;
    expect(latestTask(home)?.status).toBe("done");
    expect(latestTask(home)?.costUsd).toBeCloseTo(derived, 6);
    const events = await pollLedger(home);
    expect(events.length).toBe(1);
    expect(events[0]!.kind).toBe("arch_generate");
    expect(events[0]!.total_cost_usd).not.toBeNull();
    expect(events[0]!.total_cost_usd!).toBeCloseTo(derived, 6);
    // rate-table-derived cost is audit-distinguishable from an
    // SDK-reported one (SDK-reported success events keep the absent-basis
    // legacy shape; pinned separately elsewhere).
    expect(events[0]!.basis).toBe("derived");
  });

  test("failed run whose stdout tail carries tokens but NO cost → tail_parsed ledger entry gets the token-derived figure", async () => {
    const small = smallGraphNodes();
    const { home } = seedHome(small.nodes, small.edges);
    // Providers.ts-style failure message: usage tokens survived the tail, the
    // total_cost_usd field did not (truncated before it) → parsed cost is null.
    const tailNoCostProvider: BrainProvider = async () => {
      throw new Error(
        'claude -p exited 1: stdout tail: "usage":{"input_tokens":150000,' +
          '"cache_creation_input_tokens":48211,"cache_read_input_tokens":1024,"output_tokens":31}}]',
      );
    };
    const app = mount(home, tailNoCostProvider);
    expect((await postGenerate(app)).status).toBe(202);
    await pollTerminal(home);
    expect(latestTask(home)?.status).toBe("failed");
    const events = await pollLedger(home);
    expect(events.length).toBe(1);
    expect(events[0]!.kind).toBe("arch_generate");
    // Oracle: 150000×$3e-6 + 48211×$6e-6 + 1024×$0.30e-6 + 31×$15e-6 = $0.8989962.
    const derived = (150_000 * 3 + 48_211 * 6 + 1_024 * 0.3 + 31 * 15) / 1e6;
    expect(events[0]!.total_cost_usd).not.toBeNull();
    expect(events[0]!.total_cost_usd!).toBeCloseTo(derived, 6);
  });
});
