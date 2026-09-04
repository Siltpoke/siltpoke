// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
// Copyright (c) 2026 Jiaqi Duan
/**
 * Explain orchestrator.
 *
 * The 13-step flow:
 *   1. Pre-check (graph storage exists + schemaVersion 1)
 *   2. Load graph + queryIndex + meta
 *   3. Build symbol table
 *   4. Resolve target (handle 0 / 1 / multi)
 *   5. Cache lookup (unless --force)
 *   6. Build subgraph
 *   7. Load source files for nodes in subgraph
 *   8. Assemble Brain prompt
 *   9. Call Brain (injected provider)
 *   10. Cost-cap gate
 *   11. Score citations
 *   12. Append depth-hint footer when depth=1
 *   13. Persist explanation + sidecar
 *
 * Brain is injected via `BrainProvider` so the orchestrator stays pure +
 * testable. CLI wiring supplies the real provider that shells out to
 * `claude -p`.
 */

import { existsSync } from "node:fs";
import { join } from "node:path";
import type { BrainUsage } from "../brain/brain";
import { loadRepoGraphConfig } from "../config/repo-graph-config";
import { siltpokeRoot } from "../installer/paths";
import { ledgerBrainCall } from "../state/usage";
import { readIndexStaleness } from "../repo-graph/index-health";
import { resolveTarget } from "../repo-graph/query";
import { stalenessVerdict, type StalenessVerdict } from "../repo-graph/staleness-verdict";
import {
  readFingerprints,
  readGraph,
  readMeta,
  readQueryIndex,
} from "../repo-graph/store";
import { buildSubgraph } from "../repo-graph/subgraph";
import {
  buildSymbolTable,
  type NodeCandidate,
} from "../repo-graph/symbol-table";
import type { RepoGraph } from "../repo-graph/types";
import { readCachedExplanation } from "./cache";
import {
  scoreCitations,
  type KnownFile,
} from "./evidence-score";
import {
  assemblePrompt,
} from "./prompt-assembly";
import {
  cacheKey,
  writeExplanation,
} from "./store";
import {
  EXPLANATION_SCHEMA_VERSION,
  type ExplainResult,
  type ExplanationMeta,
} from "./types";

const DEFAULT_DEPTH: 1 | 2 = 1;
// Default cost caps raised from $0.005 / $0.02 after F29 smoke (2026-05-28):
// real `claude -p` subprocess invocations charge ~$0.03-0.06 per call due to
// CLI system-context cache creation. The original $0.005 design estimate was
// 6-12x low. New defaults: soft warns above expected ceiling; hard cap aborts
// only on truly pathological calls. Env vars `SILTPOKE_EXPLAIN_SOFT_CAP_USD`
// and `SILTPOKE_EXPLAIN_HARD_CAP_USD` still override at runtime.
const DEFAULT_SOFT_CAP_USD = 0.05;
const DEFAULT_HARD_CAP_USD = 0.1;
const LOW_CONFIDENCE_THRESHOLD = 0.9;

export type SourceProvider = (path: string) => Promise<string | null>;
/** Minimal killable subprocess handle the provider can hand back (structural —
 * matches Bun.Subprocess + the daemon's TaskRegistry KillableProc, no import). */
export interface ProcHandle {
  readonly pid?: number;
  kill(signal?: number | string): void;
}

export type BrainProvider = (input: {
  systemPrompt: string;
  contextBundle: string;
  /** When present, ties the `claude -p` subprocess to this signal (abort →
   * SIGTERM). ABSENT = today's exact spawn (no abort wiring) — back-compat. */
  signal?: AbortSignal;
  /** Called with the spawned subprocess so a long-task registry can hold the
   * handle for SIGKILL escalation. Absent in the CLI path. */
  onSpawn?: (proc: ProcHandle) => void;
  /** When present (the daemon path), the child stdout is teed to this file
   * AS IT DRAINS — the per-task result file is the source of truth that survives
   * the daemon dying mid-run. ABSENT = the CLI path (result only in memory). */
  resultFilePath?: string;
}) => Promise<{ markdown: string; usage: BrainUsage }>;

export interface ExplainCtx {
  cwd: string;
  graphStorageDir: string;
  sourceProvider: SourceProvider;
  brainProvider: BrainProvider;
  costSoftCapUsd?: number;
  costHardCapUsd?: number;
  ttyInteractive?: boolean;
  now?: () => Date;
  /** Long-task cancel: ties the Brain subprocess to this signal (abort→SIGTERM). */
  signal?: AbortSignal;
  /** Receives the spawned subprocess handle (for registry SIGKILL escalation). */
  onSpawn?: (proc: ProcHandle) => void;
  /** Per-task result file (`~/.siltpoke/tasks/<taskId>.out`) — detached spawn
   * + stdout tee so a paid run survives daemon death. Absent on the CLI path. */
  resultFilePath?: string;
  /** Cost-honesty: when set, a real (non-cache) Brain call appends a
   *  usage-events ledger row to this base (`~/.siltpoke`). Absent = no ledger
   *  (keeps the existing test suite + any caller that opts out unaffected). */
  ledgerBasePath?: string;
  /** Optional audit tag for the ledger row; defaults to the cache key. The
   *  detached daemon explain passes its task id to preserve today's tag. */
  ledgerSessionId?: string;
  /** Siltpoke home dir (`~/.siltpoke`), used to load the repo-graph config's
   *  `staleness_warn_pct` and to locate the fingerprints the staleness verdict
   *  compares against. Absent = falls back to `siltpokeRoot()` (mirrors how
   *  `ledgerBasePath` callers already assume today's default root); only test
   *  injection needs to pass this explicitly. */
  home?: string;
}

export interface ExplainOptions {
  target: string;
  depth?: 1 | 2;
  force?: boolean;
}

export type ExplainOutcome =
  | {
      kind: "explained";
      result: ExplainResult;
      lowConfidence: boolean;
      truncated: boolean;
      usage: BrainUsage;
      /** True iff `total_cost_usd` exceeded the configured soft cap. Surfaces as a warning footer in the CLI. */
      softCapExceeded: boolean;
      /** The soft cap value that was checked, for display. */
      softCapUsd: number;
      /** Index-staleness verdict for the repo-graph this explanation was drawn
       *  from. Attached on BOTH the cache-hit AND cache-miss success returns —
       *  a cached explanation must not silently drop the warning (R9). */
      staleness: StalenessVerdict;
    }
  | { kind: "ambiguous"; candidates: NodeCandidate[] }
  | { kind: "not_found"; target: string; suggestions: string[] }
  | { kind: "pre_check_failed"; message: string }
  | { kind: "cost_cap_exceeded"; usage: BrainUsage; costUsd: number };

function buildKnownFiles(graph: RepoGraph): Map<string, KnownFile> {
  const out = new Map<string, KnownFile>();
  for (const node of graph.nodes) {
    if (node.type !== "file") continue;
    out.set(node.path, { path: node.path, maxLine: node.lineRange[1] });
  }
  return out;
}

async function loadSubgraphSources(
  paths: string[],
  provider: SourceProvider,
): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const seen = new Set<string>();
  for (const path of paths) {
    if (seen.has(path)) continue;
    seen.add(path);
    const content = await provider(path);
    if (content !== null) out.set(path, content);
  }
  return out;
}

export async function runExplain(
  opts: ExplainOptions,
  ctx: ExplainCtx,
): Promise<ExplainOutcome> {
  const depth: 1 | 2 = opts.depth ?? DEFAULT_DEPTH;
  const softCap = ctx.costSoftCapUsd ?? DEFAULT_SOFT_CAP_USD;
  const hardCap = ctx.costHardCapUsd ?? DEFAULT_HARD_CAP_USD;
  const now = ctx.now ?? (() => new Date());

  // Step 1 — pre-check
  if (!existsSync(join(ctx.graphStorageDir, "meta.json"))) {
    return {
      kind: "pre_check_failed",
      message:
        "No repo-graph found. Open Code Map and pick this repo to build the structural index.",
    };
  }
  const meta = await readMeta(ctx.graphStorageDir);
  if (!meta || meta.schemaVersion !== 1) {
    return {
      kind: "pre_check_failed",
      message:
        "Repo-graph meta.json missing or unsupported. Re-index this repo from Code Map.",
    };
  }

  // Staleness verdict — computed ONCE per `runExplain` call (this single
  // `const` IS the memoization; deliberately not a module-global, R14) and
  // attached to BOTH the cache-hit and cache-miss "explained" returns below
  // so a served-from-cache explanation never silently drops the warning (R9).
  const home = ctx.home ?? siltpokeRoot();
  const rgCfg = await loadRepoGraphConfig(home);
  const staleness = stalenessVerdict(
    await readIndexStaleness({ cwd: ctx.cwd, home }),
    rgCfg.staleness_warn_pct,
  );

  // Step 2 — load graph + queryIndex
  const graph = await readGraph(ctx.graphStorageDir);
  const queryIndex = await readQueryIndex(ctx.graphStorageDir);

  // Step 3 — symbol table
  const symbolTable = buildSymbolTable(graph, queryIndex);

  // Step 4 — resolve
  const resolution = resolveTarget(opts.target, graph, symbolTable);
  if (resolution.kind === "not_found") {
    return {
      kind: "not_found",
      target: opts.target,
      suggestions: resolution.suggestions,
    };
  }
  if (resolution.kind === "ambiguous") {
    return { kind: "ambiguous", candidates: resolution.candidates };
  }

  const targetNode = resolution.node;
  const key = cacheKey(targetNode.nodeId);

  // Load source fingerprints once to gate cache lookup +
  // populate explanation meta on write. `targetNode.path` is the file
  // the explanation is about; missing entry means file isn't tracked
  // by the index (treat as "no expectation" — preserves backward-compat).
  const fingerprints = await readFingerprints(ctx.graphStorageDir);
  const targetFingerprint = fingerprints.files[targetNode.path]?.content_sha256;

  // Step 5 — cache
  if (!opts.force) {
    const cached = await readCachedExplanation(
      ctx.cwd,
      key,
      meta.last_indexed_ts,
      targetFingerprint,
    );
    if (cached) {
      const cachedCost = cached.meta.brain_usage.total_cost_usd ?? 0;
      return {
        kind: "explained",
        result: cached,
        lowConfidence: cached.meta.low_confidence,
        truncated: false,
        usage: cached.meta.brain_usage,
        softCapExceeded: cachedCost > softCap,
        softCapUsd: softCap,
        staleness,
      };
    }
  }

  // Step 6 — subgraph
  const subgraph = buildSubgraph(targetNode.nodeId, graph, depth);

  // Step 7 — load source for subgraph paths
  const paths = [
    ...new Set(subgraph.nodes.map((n) => n.path).filter((p) => p && p.length > 0)),
  ];
  const sources = await loadSubgraphSources(paths, ctx.sourceProvider);

  // Step 8 — assemble prompt
  const prompt = assemblePrompt({
    targetId: targetNode.nodeId,
    subgraph,
    symbolTable,
    sources,
  });

  // Step 9 — Brain call
  const { markdown: rawMarkdown, usage } = await ctx.brainProvider({
    systemPrompt: prompt.systemPrompt,
    contextBundle: prompt.contextBundle,
    signal: ctx.signal,
    onSpawn: ctx.onSpawn,
    resultFilePath: ctx.resultFilePath,
  });
  const costUsd = usage.total_cost_usd ?? 0;

  // Honest ledger (cost-honesty batch A): a real Brain call ran (this is the
  // cache-MISS path — a hit returned at Step 5, before any spend). Fires for
  // BOTH the success path below AND the cost_cap_exceeded early-return — both
  // spent real money. The single shared writer; the daemon detached route no
  // longer ledgers inline (would double-bill). Gated on ledgerBasePath so
  // opt-out callers / the existing test suite are unaffected.
  if (ctx.ledgerBasePath) {
    await ledgerBrainCall(ctx.ledgerBasePath, {
      kind: "explain",
      session_id: ctx.ledgerSessionId ?? key,
      usage,
    });
  }

  // Step 10 — cost-cap gate (hard cap aborts before persistence)
  if (costUsd > hardCap) {
    return { kind: "cost_cap_exceeded", usage, costUsd };
  }
  const softCapExceeded = costUsd > softCap;

  // Step 11 — evidence score
  const knownFiles = buildKnownFiles(graph);
  // Source paths we *loaded* are also legitimate citation targets even if
  // the graph happened not to have a file node for them.
  for (const path of sources.keys()) {
    if (!knownFiles.has(path)) {
      const content = sources.get(path) ?? "";
      const lineCount = Math.max(1, content.split(/\r?\n/).length);
      knownFiles.set(path, { path, maxLine: lineCount });
    }
  }
  const evidence = scoreCitations(rawMarkdown, knownFiles);
  const lowConfidence = evidence.score < LOW_CONFIDENCE_THRESHOLD;

  // Step 12 — depth-hint footer
  let markdown = rawMarkdown.trimEnd();
  if (depth === 1) {
    markdown += "\n\n💡 Try `--depth 2` for transitive callers and call-graph context.\n";
  } else {
    markdown += "\n";
  }

  // Step 13 — persist
  const explanationMeta: ExplanationMeta = {
    schemaVersion: EXPLANATION_SCHEMA_VERSION,
    target: opts.target,
    target_node_id: targetNode.nodeId,
    target_key_sha256: key,
    graph_indexed_ts: meta.last_indexed_ts,
    brain_usage: usage,
    evidence_score: evidence.score,
    low_confidence: lowConfidence,
    depth,
    created_ts: now().toISOString(),
    source_fingerprint: targetFingerprint,
  };
  const result = await writeExplanation(ctx.cwd, key, markdown, explanationMeta);

  return {
    kind: "explained",
    result,
    lowConfidence,
    truncated: prompt.truncated || subgraph.truncated,
    usage,
    softCapExceeded,
    softCapUsd: softCap,
    staleness,
  };
}
