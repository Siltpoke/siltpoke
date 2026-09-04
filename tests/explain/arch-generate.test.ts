/**
 * LLM-derived C4 generate pipeline (Brain mocked).
 *
 * Pins: signatures-only assembler (NO function bodies, ever), schema validation
 * (atomic — malformed → typed fail, no partial), cost estimate arithmetic, and
 * runArchGenerate outcomes (generated / malformed / cost-cap / pre-check).
 */
import { describe, expect, it } from "bun:test";
import { existsSync } from "node:fs";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { archModelPath } from "../../src/explain/arch-cache";
import type { BrainUsage } from "../../src/brain/brain";
import { aggregateBySuperGroup } from "../../src/repo-graph/aggregator";
import { projectArchitecture } from "../../src/repo-graph/project-architecture";
import type { RepoGraph, RepoGraphMeta, SiltpokeGraphNode } from "../../src/repo-graph/types";
import { ARCH_CONTEXT_BUDGET_TOKENS, assembleArchContext } from "../../src/explain/arch-context";
import {
  archCostFromUsage,
  estimateArchCostUsd,
  estimateArchGenerate,
  runArchGenerate,
  type ArchGenerateCtx,
} from "../../src/explain/arch-generate";
import {
  parseArchDocFromText,
  validateArchDoc,
  type ArchModelDoc,
} from "../../src/explain/arch-model-schema";

// ── fixtures ───────────────────────────────────────────────────────────────
function fileNode(path: string): SiltpokeGraphNode {
  return { id: `file:${path}:`, type: "file", name: path.split("/").pop()!, path, lineRange: [1, 80] };
}
function fnNode(path: string, name: string, signature: string, doc?: string): SiltpokeGraphNode {
  return { id: `function:${path}:${name}`, type: "function", name, path, lineRange: [12, 40], signature, doc };
}

function fixtureGraph(): RepoGraph {
  return {
    schemaVersion: 1,
    nodes: [
      fileNode("src/brain/brain.ts"),
      fnNode("src/brain/brain.ts", "runBrain", "export async function runBrain(o: BrainOpts): Promise<BrainCallResult>", "spawn claude -p"),
      fileNode("src/critic/run-critic.ts"),
      fnNode("src/critic/run-critic.ts", "runCritic", "export async function runCritic(ctx: CriticCtx): Promise<Critique>"),
    ],
    edges: [
      // `imports` edge target is an import SPECIFIER (resolved relative to the
      // source file), not a node id — matches the aggregator's resolver.
      {
        id: "file:src/critic/run-critic.ts:::imports::../brain/brain",
        type: "imports",
        source: "file:src/critic/run-critic.ts:",
        target: "../brain/brain",
        weight: 1,
      },
    ],
  };
}

function fixtureMeta(root: string): RepoGraphMeta {
  return {
    schemaVersion: 1,
    project_root: root,
    proj_hash: "deadbeef0000",
    last_indexed_ts: "2026-06-03T00:00:00Z",
    build_duration_ms: 1,
    counters: {
      files_walked: 2,
      files_cached: 0,
      parse_degraded: 0,
      skipped: { tree_sitter_failed: 0, too_large: 0, not_a_source_file: 0, file_cap: 0 },
      nodes: { file: 2, function: 2, class: 0, module: 0, symbol: 0 },
      edges: { imports: 1, calls: 0, contains: 0 },
    },
  };
}

const VALID_DOC: ArchModelDoc = {
  boundary: "demo",
  bands: [{ id: "core", label: { value: "Core", evidence: [{ file: "src/brain/brain.ts", line: 12 }] }, order: 0, members: ["brain", "critic"] }],
  nodes: [
    { id: "brain", kind: "cont", title: { value: "Brain", evidence: [{ file: "src/brain/brain.ts", line: 12 }] }, band: { value: "core", evidence: [{ file: "src/brain/brain.ts", line: 12 }] }, drillTo: "brain" },
    { id: "critic", kind: "cont", title: { value: "Critic", evidence: [{ file: "src/critic/run-critic.ts", line: 12 }] }, band: { value: "core", evidence: [{ file: "src/critic/run-critic.ts", line: 12 }] }, drillTo: "critic" },
  ],
  edges: [{ source: "critic", target: "brain", verb: { value: "spawns claude -p", evidence: [{ file: "src/critic/run-critic.ts", line: 12 }] } }],
};

function ctxWith(dir: string, brain: ArchGenerateCtx["brainProvider"], over: Partial<ArchGenerateCtx> = {}): ArchGenerateCtx {
  return {
    graphStorageDir: dir,
    brainProvider: brain,
    loadOverlay: async () => null,
    sourceProvider: async () => null, // grounding: no source in these unit fixtures
    ...over,
  };
}
function usage(cost: number): BrainUsage {
  return { cache_creation_input_tokens: 0, cache_read_input_tokens: 0, input_tokens: 100, output_tokens: 50, total_cost_usd: cost };
}

async function tmpRepo(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "arch-"));
  const graph = fixtureGraph();
  await writeFile(join(dir, "graph.json"), JSON.stringify(graph));
  await writeFile(join(dir, "meta.json"), JSON.stringify(fixtureMeta(dir)));
  return dir;
}

// ── assembler: signatures-only ───────────────────────────────────────────────
describe("assembleArchContext — signatures only, no bodies", () => {
  function build() {
    const graph = fixtureGraph();
    const meta = fixtureMeta("/x/demo");
    const aggregated = aggregateBySuperGroup(graph, null);
    const projection = projectArchitecture(graph, null, meta);
    return assembleArchContext(graph, aggregated, projection);
  }

  it("includes each symbol's signature + a @path:line citation anchor", () => {
    const ctx = build();
    expect(ctx.contextBundle).toContain("runBrain");
    expect(ctx.contextBundle).toContain("export async function runBrain(o: BrainOpts)");
    expect(ctx.contextBundle).toContain("@ src/brain/brain.ts:12");
    expect(ctx.symbolCount).toBe(2);
  });

  it("never emits a function body (only the captured signature string)", () => {
    // The assembler takes (graph, aggregated, projection) — no SourceProvider —
    // so a body cannot enter. Assert the doc comment + signature are present but
    // no brace-body of the function leaked.
    const ctx = build();
    expect(ctx.contextBundle).toContain("// spawn claude -p"); // node.doc surfaced
    expect(ctx.contextBundle).not.toContain("{\n"); // no multi-line body block
    expect(ctx.contextBundle).toContain("import edges");
  });

  it("emits the cross-subdir import-count edge summary", () => {
    const ctx = build();
    expect(ctx.contextBundle).toMatch(/src\/critic\/ → src\/brain\/\s+×1/);
  });

  it("reports an estimate proportional to context size", () => {
    const ctx = build();
    expect(ctx.estTokens).toBeGreaterThan(0);
    expect(ctx.estTokens).toBe(Math.ceil(ctx.contextBytes / 2.9)); // measured bytes-per-token divisor, 2.9 conservative
    expect(ctx.capped).toBe(false);
  });

  it("V1: groups symbols by file into #### sub-blocks (one file per subdir here)", () => {
    const ctx = build();
    expect(ctx.contextBundle).toContain("#### brain.ts");
    expect(ctx.contextBundle).toContain("#### run-critic.ts");
    // the symbol still sits under its file block with the citation anchor.
    expect(ctx.contextBundle).toContain("@ src/brain/brain.ts:12");
  });

  it("V1: a multi-file subdir emits one #### block per file, sorted (split seeds)", () => {
    const graph: RepoGraph = {
      schemaVersion: 1,
      nodes: [
        fileNode("src/agents/scraper.ts"),
        fnNode("src/agents/scraper.ts", "scrape", "export function scrape(): Page[]"),
        fileNode("src/agents/booker.ts"),
        fnNode("src/agents/booker.ts", "book", "export function book(): Booking"),
      ],
      edges: [],
    };
    const aggregated = aggregateBySuperGroup(graph, null);
    const projection = projectArchitecture(graph, null, fixtureMeta("/x/demo"));
    const ctx = assembleArchContext(graph, aggregated, projection);
    expect(ctx.contextBundle).toContain("#### booker.ts");
    expect(ctx.contextBundle).toContain("#### scraper.ts");
    // sorted file order → booker before scraper (deterministic output).
    expect(ctx.contextBundle.indexOf("#### booker.ts")).toBeLessThan(
      ctx.contextBundle.indexOf("#### scraper.ts"),
    );
  });
});

// ── schema validation: atomic ────────────────────────────────────────────────
describe("validateArchDoc / parseArchDocFromText — strict + atomic", () => {
  it("accepts a well-formed doc; tier is optional (filled by the grounding pass)", () => {
    const r = validateArchDoc(VALID_DOC);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.doc.nodes[0]!.title.tier).toBeUndefined();
  });

  it("rejects a doc with a missing evidence array (typed error, no partial)", () => {
    const bad = { ...VALID_DOC, nodes: [{ id: "x", kind: "cont", title: { value: "X" }, band: { value: "core", evidence: [] } }] };
    const r = validateArchDoc(bad);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("title");
  });

  it("extracts JSON from a ```json fence", () => {
    const r = parseArchDocFromText("Here you go:\n```json\n" + JSON.stringify(VALID_DOC) + "\n```\n");
    expect(r.ok).toBe(true);
  });

  it("returns a typed failure on non-JSON garbage (never throws)", () => {
    const r = parseArchDocFromText("sorry, I cannot help with that");
    expect(r.ok).toBe(false);
  });
});

// ── cost estimate — estimate two heads ──────────────────────────────────────
// Synthetic golden set for a warm ~160k-context arch_generate run under sonnet
// 1h-cache pricing (in $3 / cacheWrite1h $6 / cacheRead $0.30 / out $15 per
// Mtok, no flat per-call fee). Each `cost` is the exact decomposition of its
// token breakdown, e.g. 160000×6e-6 + 20000×0.3e-6 + 31000×15e-6 + 5×3e-6 =
// $1.431015. The rate table must reproduce each from tokens alone.
const GOLDEN_ARCH_EVENTS = [
  { in: 5, out: 31000, cw: 160000, cr: 20000, cost: 1.431015 },
  { in: 5, out: 32000, cw: 170000, cr: 20000, cost: 1.506015 },
  { in: 5, out: 33000, cw: 180000, cr: 20000, cost: 1.5810150000000003 },
] as const;
// Warm 160k-capped cost band; the estimate must land within ±25% of the band.
const CLAUDE_CODE_LEDGER_MIN = 1.431015;
const CLAUDE_CODE_LEDGER_MAX = 1.5810150000000003;

describe("estimateArchCostUsd — golden-ledger backtest", () => {
  it("test_rate_table_reproduces_each_golden_ledger_cost_within_1pct", () => {
    // Layer (a) RATE-correctness: the pure cost-from-usage function must
    // reproduce every ledgered cost analytically from its token breakdown —
    // this validates the {in, cacheWrite1h, cacheRead, out} rate table itself.
    for (const e of GOLDEN_ARCH_EVENTS) {
      const got = archCostFromUsage(
        {
          input_tokens: e.in,
          output_tokens: e.out,
          cache_creation_input_tokens: e.cw,
          cache_read_input_tokens: e.cr,
        },
        "sonnet",
      );
      expect(Math.abs(got - e.cost) / e.cost).toBeLessThan(0.01); // ±1% per event
    }
  });

  it("test_estimate_within_25pct_of_claude_code_class_ledger_range", () => {
    // The claude-code context is budget-capped at exactly ARCH_CONTEXT_BUDGET_TOKENS
    // (160k) — that capped class is what the real $1.46-1.57 burns ran with. The
    // prior formula returned $0.82 here (−45%); the corrected one must land
    // within ±25% of the ledgered range.
    const est = estimateArchCostUsd(ARCH_CONTEXT_BUDGET_TOKENS, "sonnet");
    expect(est).toBeGreaterThanOrEqual(0.75 * CLAUDE_CODE_LEDGER_MIN);
    expect(est).toBeLessThanOrEqual(1.25 * CLAUDE_CODE_LEDGER_MAX);
  });

  // corrupt token fields must never fabricate/poison cost
  it("a negative token field contributes $0 — never negative USD into the ledger", () => {
    const got = archCostFromUsage(
      { input_tokens: -500_000, output_tokens: 1_000, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
      "sonnet",
    );
    // Only the valid field counts: 1000×$15e-6. A propagated negative would
    // SUBTRACT from ledger totals (fabricated negative cost).
    expect(got).toBeCloseTo((1_000 * 15) / 1e6, 9);
    expect(got).toBeGreaterThanOrEqual(0);
  });

  it("a NaN / non-finite token field contributes $0 — never NaN into the ledger", () => {
    const got = archCostFromUsage(
      {
        input_tokens: Number.NaN,
        output_tokens: 1_000,
        cache_creation_input_tokens: Number.POSITIVE_INFINITY,
        cache_read_input_tokens: 0,
      },
      "sonnet",
    );
    expect(Number.isFinite(got)).toBe(true);
    expect(got).toBeCloseTo((1_000 * 15) / 1e6, 9);
  });

  it("opus estimate stays pricier than sonnet for the same context", () => {
    expect(estimateArchCostUsd(90_000, "opus")).toBeGreaterThan(estimateArchCostUsd(90_000, "sonnet"));
  });

  // opus row pinned to the CURRENT published page
  it("opus rates — 160K-class estimate is $2.575, over the $2 default hard cap", () => {
    // Independent recompute from the published opus rates (in $5 / out $25 /
    // cacheWrite1h $10 / cacheRead $0.50 per Mtok — Opus 4.5-4.8 identical):
    // (160000 + 20000)×$10e-6 + 31000×$25e-6 = $1.80 + $0.775 = $2.575.
    // The figure sitting OVER the $2 default hard cap is a surfaced data point,
    // not a bug — the cap question goes to the reviewer/user, never silently
    // raised here.
    expect(estimateArchCostUsd(ARCH_CONTEXT_BUDGET_TOKENS, "opus")).toBeCloseTo(2.575, 6);
  });

  it("test_corrected_estimate_trips_no_generatable_class_at_hard_cap", () => {
    // Contingency guard (signed story): if a known-passing repo class would now
    // hard-cap-trip → surface, do NOT raise the cap. The largest generatable
    // sonnet context is the budget cap (160k est tokens); its corrected estimate
    // must stay under the $2 default hard cap — and every golden cost does.
    const HARD_CAP_USD = 2.0;
    expect(estimateArchCostUsd(ARCH_CONTEXT_BUDGET_TOKENS, "sonnet")).toBeLessThan(HARD_CAP_USD);
    for (const e of GOLDEN_ARCH_EVENTS) expect(e.cost).toBeLessThan(HARD_CAP_USD);
  });
});

// ── orchestrator (Brain mocked) ──────────────────────────────────────────────
describe("runArchGenerate — outcomes", () => {
  it("generated: valid JSON → validated doc + cost", async () => {
    const dir = await tmpRepo();
    const out = await runArchGenerate(ctxWith(dir, async () => ({ markdown: JSON.stringify(VALID_DOC), usage: usage(0.4) })));
    expect(out.kind).toBe("generated");
    if (out.kind === "generated") {
      expect(out.doc.boundary).toBe("demo");
      expect(out.costUsd).toBe(0.4);
      expect(out.softCapExceeded).toBe(false);
    }
  });

  it("malformed: bad JSON → typed failure, NO doc (atomic)", async () => {
    const dir = await tmpRepo();
    const out = await runArchGenerate(ctxWith(dir, async () => ({ markdown: "not json", usage: usage(0.1) })));
    expect(out.kind).toBe("malformed");
    expect("doc" in out).toBe(false);
  });

  it("cost_cap_exceeded: over hard cap aborts BEFORE a doc", async () => {
    const dir = await tmpRepo();
    const out = await runArchGenerate(
      ctxWith(dir, async () => ({ markdown: JSON.stringify(VALID_DOC), usage: usage(5.0) }), { costHardCapUsd: 2.0 }),
    );
    expect(out.kind).toBe("cost_cap_exceeded");
    expect("doc" in out).toBe(false);
  });

  it("pre_check_failed: no meta.json", async () => {
    const dir = await mkdtemp(join(tmpdir(), "arch-empty-"));
    const out = await runArchGenerate(ctxWith(dir, async () => ({ markdown: JSON.stringify(VALID_DOC), usage: usage(0.1) })));
    expect(out.kind).toBe("pre_check_failed");
  });

  // a null total_cost_usd from the SDK must NOT become $0
  it("null total_cost_usd → costUsd is the token-derived figure, not $0", async () => {
    const dir = await tmpRepo();
    // A golden token breakdown with the SDK cost MISSING.
    const nullCostUsage: BrainUsage = {
      input_tokens: 5,
      output_tokens: 31_000,
      cache_creation_input_tokens: 160_000,
      cache_read_input_tokens: 20_000,
      total_cost_usd: null,
    };
    const out = await runArchGenerate(
      ctxWith(dir, async () => ({ markdown: JSON.stringify(VALID_DOC), usage: nullCostUsage })),
    );
    expect(out.kind).toBe("generated");
    if (out.kind === "generated") {
      // Independent recompute from the raw sonnet rates (NOT archCostFromUsage):
      // 5×$3e-6 + 160000×$6e-6 + 20000×$0.30e-6 + 31000×$15e-6 = $1.431015.
      expect(out.costUsd).toBeCloseTo(1.431015, 6);
      expect(out.costUsd).not.toBe(0);
    }
  });

  it("null total_cost_usd cannot dodge the hard cap — derived cost over cap → cost_cap_exceeded", async () => {
    const dir = await tmpRepo();
    const bigNullCost: BrainUsage = {
      input_tokens: 0,
      output_tokens: 200_000, // ×$15/Mtok = $3.00 > the $2 hard cap
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
      total_cost_usd: null,
    };
    const out = await runArchGenerate(
      ctxWith(dir, async () => ({ markdown: JSON.stringify(VALID_DOC), usage: bigNullCost }), {
        costHardCapUsd: 2.0,
      }),
    );
    expect(out.kind).toBe("cost_cap_exceeded");
    if (out.kind === "cost_cap_exceeded") expect(out.costUsd).toBeCloseTo(3.0, 6);
  });

  it("estimateArchGenerate returns a cost estimate without calling Brain", async () => {
    const dir = await tmpRepo();
    let brainCalls = 0;
    const r = await estimateArchGenerate(ctxWith(dir, async () => { brainCalls++; return { markdown: "", usage: usage(0) }; }));
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.estimate.estUsd).toBeGreaterThan(0);
      expect(r.estimate.model).toBe("sonnet");
    }
    expect(brainCalls).toBe(0); // never calls Brain for an estimate
  });
});

// ── cache integration ─────────────────────────────────────────────────────
describe("runArchGenerate — cache", () => {
  it("persists on first generate, then serves from cache (0 Brain) on the second", async () => {
    const dir = await tmpRepo();
    let calls = 0;
    const brain = async () => { calls++; return { markdown: JSON.stringify(VALID_DOC), usage: usage(0.4) }; };
    const first = await runArchGenerate(ctxWith(dir, brain));
    expect(first.kind).toBe("generated");
    if (first.kind === "generated") expect(first.fromCache).toBe(false);
    expect(existsSync(archModelPath(dir))).toBe(true);

    const second = await runArchGenerate(ctxWith(dir, brain));
    expect(second.kind).toBe("generated");
    if (second.kind === "generated") expect(second.fromCache).toBe(true);
    expect(calls).toBe(1); // the cache hit did not call Brain again
  });

  it("cost-cap abort leaves NO cache (invariant preserved through cache path)", async () => {
    const dir = await tmpRepo();
    const out = await runArchGenerate(
      ctxWith(dir, async () => ({ markdown: JSON.stringify(VALID_DOC), usage: usage(5.0) }), { costHardCapUsd: 2.0 }),
    );
    expect(out.kind).toBe("cost_cap_exceeded");
    expect(existsSync(archModelPath(dir))).toBe(false);
  });

  it("integrity_failed: a malformed model is rejected, nothing cached", async () => {
    const dir = await tmpRepo();
    const badDoc = { ...VALID_DOC, edges: [{ source: "brain", target: "ghost", verb: { value: "uses", evidence: [{ file: "src/brain/brain.ts", line: 1 }] } }] };
    const out = await runArchGenerate(ctxWith(dir, async () => ({ markdown: JSON.stringify(badDoc), usage: usage(0.4) })));
    expect(out.kind).toBe("integrity_failed");
    expect(existsSync(archModelPath(dir))).toBe(false);
  });

  it("force bypasses a fresh cache and re-calls Brain", async () => {
    const dir = await tmpRepo();
    await runArchGenerate(ctxWith(dir, async () => ({ markdown: JSON.stringify(VALID_DOC), usage: usage(0.4) })));
    let calls = 0;
    await runArchGenerate(ctxWith(dir, async () => { calls++; return { markdown: JSON.stringify(VALID_DOC), usage: usage(0.4) }; }, { force: true }));
    expect(calls).toBe(1); // force re-ran the Brain despite a fresh cache
  });
});
