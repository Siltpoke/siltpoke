// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Copyright (c) 2026 Jiaqi Duan
/**
 * Arch View LLM-derive — the generate orchestrator.
 *
 * `runArchGenerate` produces a validated `ArchModelDoc` from ONE whole-repo,
 * signatures-only Brain pass. It reuses the explain machinery shape
 * (`BrainProvider` injection + cost caps + `BrainUsage`) but is a parallel path,
 * not `runExplain` (which is single-target). Grounding, caching, and the
 * daemon route + UI are downstream — this stops at a validated doc.
 *
 * ATOMICITY (user lock): the hard cost cap aborts BEFORE any doc is returned, and
 * a malformed/invalid model returns a typed failure — there is NO half-built doc.
 * Persistence only ever sees a `{ kind: "generated" }` outcome.
 *
 * Pre-flight: `estimateArchGenerate` returns an APPROXIMATE cost with no Brain
 * call (the UI shows "≈$X · uses Claude"); the real cost comes from `BrainUsage`.
 */
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { BrainUsage } from "../brain/brain";
import { aggregateBySuperGroup } from "../repo-graph/aggregator";
import type { ArchitectureOverlay } from "../repo-graph/architecture-parser";
import { projectArchitecture } from "../repo-graph/project-architecture";
import { readFingerprints, readGraph, readMeta } from "../repo-graph/store";
import type { RepoGraph } from "../repo-graph/types";
import { assembleArchContext, type ArchContext } from "./arch-context";
import { ARCH_SYSTEM_PROMPT } from "./arch-prompt";
import { parseArchDocFromText, type ArchModelDoc } from "./arch-model-schema";
import { groundArchModel, type SourceProvider } from "./arch-ground";
import type { SubdirEdge } from "./arch-ground-bands";
import {
  computeRepoFingerprint,
  readArchModel,
  sanitizeArchModel,
  writeArchModel,
  type ArchModelMeta,
} from "./arch-cache";
import type { SubdirsKeyspace } from "./subdir-resolve";
import type { BrainProvider, ProcHandle } from "./explain";

export type ArchModel = "sonnet" | "opus";

/**
 * $/Mtok per token class. Rates as-of 2026-06-11,
 * https://platform.claude.com/docs/en/about-claude/pricing
 * cacheWrite1h = 2× input (1h cache-write), cacheRead = 0.1× input; there is
 * no flat per-call fee — overhead is all tokens. Opus 4.5 through 4.8 share
 * identical pricing.
 */
const MODEL_RATES: Record<ArchModel, { in: number; out: number; cacheWrite1h: number; cacheRead: number }> = {
  sonnet: { in: 3, out: 15, cacheWrite1h: 6, cacheRead: 0.3 },
  opus: { in: 5, out: 25, cacheWrite1h: 10, cacheRead: 0.5 },
};
/**
 * Assumed output size — pre-flight estimate only (recalibrated). Observed
 * big-repo runs pin 30,824-32,858 output tokens, hard against the 32K output
 * cap (the model always exhausts its budget on a budget-capped context); 31,000
 * sits in that band and keeps the backtest within +25% of the cheapest cold
 * big-repo event ($1.25394). HONEST OVERESTIMATE direction for small repos:
 * the one observed small-repo run produced only 4,522 output tokens, so small
 * repos will see an inflated estimate — deliberate: a paid pre-flight should
 * err high (user declines a fair price) rather than low (user gets over-burned).
 */
const EST_OUTPUT_TOKENS = 31_000;
/**
 * System-prompt + `claude -p` CLI context tokens the chars-derived input
 * estimate cannot see. Evidence: 4 of the 5 cache-read-bearing golden events
 * show cache_read_input_tokens = 19,807 (the CLI prefix being cache-read) —
 * NOT a constant: the fifth (the 23:55:22 fully-warm re-run) read 259,558,
 * a whole-prompt cache hit. On cold runs the same ~19.8K tokens are
 * cache-WRITTEN inside cache_creation. Rounded to 20K and priced at
 * cacheWrite1h (cold-run conservative — warm runs re-read it at 0.1×, so the
 * estimate overshoots a warm run by ~$0.113 = 19807×($6−$0.30)/1e6; cheaper
 * than the estimate, never dearer). This replaces the old flat
 * CLI_OVERHEAD_USD ($0.25): the ledger decomposition proves there is no flat
 * fee, only unmodeled tokens.
 */
const EST_CLI_CONTEXT_TOKENS = 20_000;

const ARCH_DEFAULT_SOFT_CAP_USD = Number(process.env.SILTPOKE_ARCH_SOFT_CAP_USD) || 0.6;
const ARCH_DEFAULT_HARD_CAP_USD = Number(process.env.SILTPOKE_ARCH_HARD_CAP_USD) || 2.0;
/** The model every current caller runs (the daemon generate route exposes no
 * model param, so it ALWAYS runs this default) — exported so route-level
 * null-cost fallbacks don't have to guess the model. If a model
 * param is ever added to the route, thread the real model instead. */
export const ARCH_DEFAULT_MODEL: ArchModel = "sonnet";

export interface ArchGenerateCtx {
  graphStorageDir: string;
  brainProvider: BrainProvider;
  /** Resolve the repo's CLAUDE.md §Architecture overlay (null → degraded). */
  loadOverlay: () => Promise<ArchitectureOverlay | null>;
  /** Reads a cited file's content for the grounding verb/ext snippet-token check. */
  sourceProvider: SourceProvider;
  costSoftCapUsd?: number;
  costHardCapUsd?: number;
  model?: ArchModel;
  /** Bypass the cache lookup + force a fresh generate (re-generate). */
  force?: boolean;
  /** Long-task cancel: ties the Brain subprocess to this signal (abort→SIGTERM). */
  signal?: AbortSignal;
  /** Receives the spawned subprocess handle (for registry SIGKILL escalation). */
  onSpawn?: (proc: ProcHandle) => void;
  /** The per-task result file (`~/.siltpoke/tasks/<taskId>.out`). When set,
   * the Brain spawn is detached + its stdout is teed here so a paid run survives
   * daemon death mid-run. Absent on the CLI path. */
  resultFilePath?: string;
  /** ISO timestamp from the task registry's startedTs: used to compute
   * durationMs that is persisted in arch-model.meta.json. The registry is the
   * single source of truth for the start clock — do NOT capture a second
   * Date.now() inside generate. When absent (legacy/CLI callers), durationMs
   * is omitted from the written meta (no undefined on disk). */
  taskStartedTs?: string;
}

export interface ArchEstimate {
  estInputTokens: number;
  estOutputTokens: number;
  estUsd: number;
  model: ArchModel;
  contextBytes: number;
  subdirCount: number;
  symbolCount: number;
  capped: boolean;
  droppedSubdirs: string[];
  /** 📐 honest-metrics: how many subdirs were truncated to a budget share
   * (droppedSubdirs is always [] post-sharding — this is the real cap signal). */
  truncatedSubdirCount: number;
}

/** The model's output cap. `EST_OUTPUT_TOKENS = 31_000` is the assumed output;
 * the real `claude -p` run is capped at 32K and big-repo runs PEG it (the
 * recalibration comment on EST_OUTPUT_TOKENS records 30,824-32,858 observed
 * output on budget-capped contexts). So EST_OUTPUT_TOKENS sitting hard against
 * this cap IS the "near the ceiling" anchor — no second magic number
 * (Contingency 3): the predicate reuses it rather than inventing a threshold. */
export const ARCH_OUTPUT_CAP_TOKENS = 32_000;

/**
 * Pre-flight truncation predicate — PURE, repo-size-sensitive.
 *
 * Honest-signal grounding: `EST_OUTPUT_TOKENS` is a FLAT constant
 * and cannot tell a large repo from a small one. The only repo-size-sensitive
 * signal the pre-flight produces is on the INPUT side: `arch-context.ts`'s
 * budget-sharder reports `truncatedSubdirCount > 0` exactly when it had to
 * compress/shard subdir content to fit the 200K window. A budget-capped context
 * is *why* the model pegs its output cap (`EST_OUTPUT_TOKENS` lands hard against
 * `ARCH_OUTPUT_CAP_TOKENS`) → truncation risk. So budget pressure ⇒ warn.
 *
 * Conservative by design (spec: accept false negatives over false-positive nag):
 * a repo whose whole context fit comfortably (`truncatedSubdirCount === 0`)
 * never warns — matching the byte-identical no-regress path in `arch-context.ts`.
 *
 * Advisory only — the caller surfaces a heads-up line; it NEVER blocks.
 */
export function archGenerateMayTruncate(
  est: Pick<ArchEstimate, "truncatedSubdirCount">,
): boolean {
  return est.truncatedSubdirCount > 0;
}

export type ArchGenerateOutcome =
  | {
      kind: "generated";
      doc: ArchModelDoc;
      usage: BrainUsage;
      costUsd: number;
      softCapExceeded: boolean;
      softCapUsd: number;
      /** Share of claims that survived the grounding pass (0–100). */
      groundedPct: number;
      /** True when served from the on-disk cache (no Brain call). */
      fromCache: boolean;
      context: Pick<ArchContext, "estTokens" | "subdirCount" | "symbolCount" | "capped" | "droppedSubdirs">;
    }
  | { kind: "pre_check_failed"; message: string }
  | { kind: "cost_cap_exceeded"; usage: BrainUsage; costUsd: number; hardCapUsd: number }
  // malformed / integrity_failed run AFTER the Brain call — money was spent even
  // though the result was rejected. They carry `usage`+`costUsd` so the caller
  // records that spend (honest-metrics: a paid op MUST be recorded regardless of
  // outcome — never an invisible burn just because the LLM produced bad output).
  | { kind: "malformed"; message: string; usage: BrainUsage; costUsd: number }
  | { kind: "integrity_failed"; message: string; usage: BrainUsage; costUsd: number };

/**
 * Pure: exact USD for a real token breakdown + model (the rate table applied
 * analytically — reproduces each golden ledger event to within 1 ULP, well
 * inside the 1% test tolerance). Use when a
 * usage record lacks `total_cost_usd`; the ledgered figure stays authoritative
 * when present.
 *
 * Input guard: a non-finite or negative token field is treated
 * as 0 — that field's contribution is dropped, the other (valid) fields still
 * count. Direction chosen so the function can NEVER fabricate cost (it only
 * drops; a propagated negative would SUBTRACT from ledger totals, NaN would
 * poison the cap compare + the daily rollup) and never crashes/nulls on the
 * caller — the `total_cost_usd ?? archCostFromUsage(...)` fallback always
 * receives a finite figure ≥ 0.
 */
export function archCostFromUsage(
  usage: Pick<
    BrainUsage,
    "input_tokens" | "output_tokens" | "cache_creation_input_tokens" | "cache_read_input_tokens"
  >,
  model: ArchModel,
): number {
  const rate = MODEL_RATES[model];
  const tokens = (n: number): number => (Number.isFinite(n) && n > 0 ? n : 0);
  return (
    (tokens(usage.input_tokens) / 1e6) * rate.in +
    (tokens(usage.cache_creation_input_tokens) / 1e6) * rate.cacheWrite1h +
    (tokens(usage.cache_read_input_tokens) / 1e6) * rate.cacheRead +
    (tokens(usage.output_tokens) / 1e6) * rate.out
  );
}

/**
 * Pure: approximate USD for an input-token count + model (pre-flight estimate).
 * ALL input is priced at cacheWrite1h, not the plain input rate — every real
 * run shows the context landing as cache_creation (the CLI 1h-caches the whole
 * prompt on every call; plain input_tokens were 2-5 in all 6 golden events).
 * Prior formula (plain-input rate + 6K output + $0.25 flat) underestimated
 * 1.78× (est $0.82 vs ledgered $1.46-1.57 for the 160K-capped class).
 */
export function estimateArchCostUsd(inputTokens: number, model: ArchModel): number {
  const rate = MODEL_RATES[model];
  return (
    ((inputTokens + EST_CLI_CONTEXT_TOKENS) / 1e6) * rate.cacheWrite1h +
    (EST_OUTPUT_TOKENS / 1e6) * rate.out
  );
}

type InputsResult =
  | {
      ok: true;
      context: ArchContext;
      repoName: string;
      graph: RepoGraph;
      subdirEdges: SubdirEdge[];
      subdirs: SubdirsKeyspace;
      graphIndexedTs: string;
      fingerprint: string;
      validSubdirIds: Set<string>;
    }
  | { ok: false; message: string };

/** Pre-check + load graph/meta/overlay + assemble the signatures-only context. */
async function loadArchInputs(ctx: ArchGenerateCtx): Promise<InputsResult> {
  if (!existsSync(join(ctx.graphStorageDir, "meta.json"))) {
    return { ok: false, message: "No repo-graph found. Run `/siltpoke-index` first." };
  }
  // A corrupt graph.json/meta.json (truncated write, indexer crash mid-build)
  // must surface as a typed failure, not a rejected promise — keeps the
  // atomicity contract (caller never sees a throw mid-generate).
  try {
    const meta = await readMeta(ctx.graphStorageDir);
    if (!meta || meta.schemaVersion !== 1) {
      return { ok: false, message: "Repo-graph meta.json missing or unsupported. Re-index." };
    }
    const graph = await readGraph(ctx.graphStorageDir);
    const overlay = await ctx.loadOverlay();
    const aggregated = aggregateBySuperGroup(graph, overlay, meta.anchorMap);
    const projection = projectArchitecture(graph, overlay, meta);
    const context = assembleArchContext(graph, aggregated, projection);
    const subdirEdges: SubdirEdge[] = projection.edges.map((e) => ({
      source: e.source,
      target: e.target,
      weight: e.weight,
    }));
    const fingerprints = await readFingerprints(ctx.graphStorageDir);
    const subdirs: SubdirsKeyspace = projection.subdirs.map((s) => ({ id: s.id, path: s.path }));
    return {
      ok: true,
      context,
      repoName: projection.repo.name,
      graph,
      subdirEdges,
      subdirs,
      graphIndexedTs: meta.last_indexed_ts,
      fingerprint: computeRepoFingerprint(fingerprints),
      validSubdirIds: new Set(projection.subdirs.map((s) => s.id)),
    };
  } catch (e) {
    return { ok: false, message: `Failed to read repo-graph: ${e instanceof Error ? e.message : "unknown"}` };
  }
}

/** Pre-flight estimate — NO Brain call. UI shows "≈$estUsd · uses Claude". */
export async function estimateArchGenerate(
  ctx: ArchGenerateCtx,
): Promise<{ ok: true; estimate: ArchEstimate } | { ok: false; message: string }> {
  const inputs = await loadArchInputs(ctx);
  if (!inputs.ok) return { ok: false, message: inputs.message };
  const model = ctx.model ?? ARCH_DEFAULT_MODEL;
  const estInputTokens = inputs.context.estTokens;
  return {
    ok: true,
    estimate: {
      estInputTokens,
      estOutputTokens: EST_OUTPUT_TOKENS,
      estUsd: estimateArchCostUsd(estInputTokens, model),
      model,
      contextBytes: inputs.context.contextBytes,
      subdirCount: inputs.context.subdirCount,
      symbolCount: inputs.context.symbolCount,
      capped: inputs.context.capped,
      droppedSubdirs: inputs.context.droppedSubdirs,
      truncatedSubdirCount: inputs.context.truncatedSubdirs.length,
    },
  };
}

/**
 * Run one grounded C4 generate. Returns a validated `ArchModelDoc` (no coords,
 * no tier — those are downstream). Atomic: hard-cap aborts pre-doc; malformed →
 * typed failure; never a partial model.
 */
export async function runArchGenerate(ctx: ArchGenerateCtx): Promise<ArchGenerateOutcome> {
  const softCap = ctx.costSoftCapUsd ?? ARCH_DEFAULT_SOFT_CAP_USD;
  const hardCap = ctx.costHardCapUsd ?? ARCH_DEFAULT_HARD_CAP_USD;

  const inputs = await loadArchInputs(ctx);
  if (!inputs.ok) return { kind: "pre_check_failed", message: inputs.message };
  const ctxStats = pickContext(inputs.context);

  // Step 3 — cache lookup (unless force). A fresh model is a 0-Brain hit; a
  // stale one is treated as a miss here (the caller surfaces the re-generate prompt).
  if (!ctx.force) {
    const cached = await readArchModel(ctx.graphStorageDir, inputs.fingerprint, inputs.graphIndexedTs);
    if (cached && !cached.stale) {
      return {
        kind: "generated",
        doc: cached.model,
        usage: { cache_creation_input_tokens: 0, cache_read_input_tokens: 0, input_tokens: 0, output_tokens: 0, total_cost_usd: cached.meta.costUsd },
        costUsd: cached.meta.costUsd,
        softCapExceeded: cached.meta.costUsd > softCap,
        softCapUsd: softCap,
        groundedPct: cached.meta.groundedPct,
        fromCache: true,
        context: ctxStats,
      };
    }
  }

  const { markdown: raw, usage } = await ctx.brainProvider({
    systemPrompt: ARCH_SYSTEM_PROMPT,
    contextBundle: inputs.context.contextBundle,
    signal: ctx.signal,
    onSpawn: ctx.onSpawn,
    resultFilePath: ctx.resultFilePath,
  });
  // A null total_cost_usd from the SDK must never ledger/compare
  // as $0 (silent under-charge: the hard cap, the registry record AND the
  // usage ledger all read this figure). Fall back to the token-derived cost.
  const costUsd = usage.total_cost_usd ?? archCostFromUsage(usage, ctx.model ?? ARCH_DEFAULT_MODEL);

  // Hard cap aborts BEFORE producing a doc — no partial state.
  if (costUsd > hardCap) {
    return { kind: "cost_cap_exceeded", usage, costUsd, hardCapUsd: hardCap };
  }

  const parsed = parseArchDocFromText(raw);
  if (!parsed.ok) return { kind: "malformed", message: parsed.error, usage, costUsd };

  // Step 9 — grounding: tier every claim (cited | inferred) + groundedPct.
  const grounded = await groundArchModel(parsed.doc, inputs.graph, inputs.subdirEdges, inputs.subdirs, ctx.sourceProvider);
  // Sanitize reasonable-but-imperfect LLM output (drop dangling drillTo) into a
  // renderable model — both the cache AND the response use the sanitized doc.
  const doc = sanitizeArchModel(grounded.doc, inputs.validSubdirIds, inputs.subdirs);

  // Step 10 — integrity gate + atomic persist. A malformed model is rejected
  // (nothing written); a cost-capped run already returned above, so the cache
  // never sees an over-budget model.
  //
  // Duration: use the registry's startedTs (single source of truth, never
  // a second clock). Absent when called from a legacy/CLI site (no taskStartedTs
  // → omit the field; undefined is not written to JSON).
  // Guard Date.parse: an unparseable string returns NaN; Math.max(0, NaN) is NaN
  // and JSON.stringify would write null — silently wrong. Only use a finite result.
  const durationMs = ((): number | undefined => {
    if (ctx.taskStartedTs === undefined) return undefined;
    const parsed = Date.parse(ctx.taskStartedTs);
    if (!Number.isFinite(parsed)) return undefined;
    return Math.max(0, Date.now() - parsed);
  })();
  const cacheMeta: ArchModelMeta = {
    schemaVersion: 1,
    fingerprint: inputs.fingerprint,
    graphIndexedTs: inputs.graphIndexedTs,
    costUsd,
    groundedPct: grounded.groundedPct,
    model: ctx.model ?? ARCH_DEFAULT_MODEL,
    generatedTs: new Date().toISOString(),
    ...(durationMs !== undefined ? { durationMs } : {}),
    // Thread grounding counts (citedClaims/totalClaims/topologyBlindClaims)
    // from GroundResult into the cache meta so the SSR payload + POST response
    // can serve them to the client without a re-read of the model doc.
    citedClaims: grounded.citedClaims,
    totalClaims: grounded.totalClaims,
    topologyBlindClaims: grounded.topologyBlindClaims,
  };
  const written = writeArchModel(ctx.graphStorageDir, doc, cacheMeta, inputs.validSubdirIds);
  if (!written.ok) return { kind: "integrity_failed", message: written.error, usage, costUsd };

  return {
    kind: "generated",
    doc,
    usage,
    costUsd,
    softCapExceeded: costUsd > softCap,
    softCapUsd: softCap,
    groundedPct: grounded.groundedPct,
    fromCache: false,
    context: ctxStats,
  };
}

type ContextStats = Pick<ArchContext, "estTokens" | "subdirCount" | "symbolCount" | "capped" | "droppedSubdirs"> & {
  /** 📐 honest-metrics: the real cap signal post-sharding (dropped is always []). */
  truncatedSubdirCount: number;
};
function pickContext(c: ArchContext): ContextStats {
  return {
    estTokens: c.estTokens,
    subdirCount: c.subdirCount,
    symbolCount: c.symbolCount,
    capped: c.capped,
    droppedSubdirs: c.droppedSubdirs,
    truncatedSubdirCount: c.truncatedSubdirs.length,
  };
}
