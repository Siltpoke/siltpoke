// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Copyright (c) 2026 Jiaqi Duan
/**
 * The architecture-view LLM-derive — repo-scope context assembler.
 *
 * Builds the whole-repo, SIGNATURES-ONLY context the Brain reads to derive a C4
 * model in one pass (L1). It reads `node.signature` + `node.doc` from the repo
 * graph — declaration text captured at index time — and NEVER reads source files,
 * so no function body can leak into the prompt by construction.
 *
 * Shape per subdir: header (path · purpose · file count · group) + each symbol's
 * `name [type] signature @ path:line` (the `@ path:line` are citation anchors the
 * model uses for `[file:line]` evidence) + a cross-subdir import-count edge list.
 *
 * Pure: (graph, aggregated, projection) → context string + size estimate. 📐:
 * when the assembled context exceeds the token budget, EVERY subdir gets a
 * deterministic budget share (water-filling: floor + proportional + one
 * redistribution pass; order-preserving tail cuts, zero scoring) and the cuts
 * are reported per subdir (`truncatedSubdirs`) — `estTokens ≤ budget` holds
 * unconditionally, every cut is reported, never silent, and a repo whose full
 * context FITS produces a byte-identical bundle (no-regress, sha-pinned).
 */
import type { AggregatedGraph } from "./../repo-graph/aggregator";
import type { ArchitectureProjection } from "./../repo-graph/project-architecture";
import type { RepoGraph, SiltpokeGraphNode } from "./../repo-graph/types";

/** Above this ESTIMATE, the single-pass context is capped to the largest
 * subdirs (no silent truncation — the overflow is reported).
 *
 * Window math (constants calibrated on the 2026-06-10 instrumented burn,
 * task 2bbc7621 / uuid 0f996153): a 599,836-char capped context tokenized to a
 * measured `input_tokens: 150000` → 2.955 chars/token on signature-dense content,
 * not the folklore 4 — that run still blew the 200K window after the size cap
 * landed (`terminal_reason: "blocking_limit"`, output topped its 32K cap, and
 * output tokens count against the window too). With CHARS_PER_TOKEN = 2.9
 * (conservative ≤ measured 2.955) a 160K-token estimate is ≤ ~157K real;
 * 157K input + 32K max output + ~3K system prompt ≈ 192K ≤ 200K, leaving ~8K
 * slack ON TOP of the conservative divisor. */
export const ARCH_CONTEXT_BUDGET_TOKENS = 160_000;
/** Per-symbol signature hard cap — defensive against a pathological one-liner. */
const SIG_MAX_CHARS = 240;
/** 📐 sharding floor: the minimum slice a subdir gets under pressure — small
 * enough to fit many subdirs, large enough (~20 signature lines at the
 * measured ~72 tok/line) that the model can still draw a meaningful container
 * from it. The ≤-budget invariant outranks the floor (proportional scale-down
 * when floors alone overshoot). Calibrate against the $0 assembly read-out. */
export const SHARD_FLOOR_TOKENS = 1_500;
/** Chars→tokens divisor, measured not guessed: 2.955 on the burn-#2 corpus
 * (see budget comment above); 2.9 keeps the estimate on the safe (over) side. */
const CHARS_PER_TOKEN = 2.9;

export interface ArchContext {
  contextBundle: string;
  estTokens: number;
  contextBytes: number;
  subdirCount: number;
  symbolCount: number;
  /** True iff the budget forced dropping subdirs OR truncating one. */
  capped: boolean;
  /** Subdir paths omitted by the cap (empty when not capped). */
  droppedSubdirs: string[];
  /** 📐 Every subdir truncated to its budget share (order-preserving tail
   * cuts, never a scoring pass). Empty when the full context fit. */
  truncatedSubdirs: Array<{ path: string; omittedSymbols: number }>;
}

function estTokensOf(s: string): number {
  return Math.ceil(s.length / CHARS_PER_TOKEN);
}

/** Symbol-bearing node types (file nodes carry no signature worth listing). */
function isSymbolNode(n: SiltpokeGraphNode): boolean {
  return n.type === "function" || n.type === "class" || n.type === "module" || n.type === "symbol";
}

/** Render one symbol as a single signatures-only line. NEVER reads source.
 *
 * `signature`/`doc` come from the indexed repo (trust = whatever the user chose
 * to index). A hostile repo could embed prompt-injection text in a declaration;
 * the `\s+ → " "` normalize flattens any multi-line payload to one line, the C4
 * prompt frames this strictly as structured data, and — the real safety net —
 * the grounding pass falsifies any claim against real `[file:line]` evidence,
 * so an injected instruction can't manufacture a grounded fact. */
function renderSymbol(n: SiltpokeGraphNode): string {
  const sig = n.signature ? ` — ${n.signature.replace(/\s+/g, " ").slice(0, SIG_MAX_CHARS)}` : "";
  const doc = n.doc ? `  // ${n.doc.replace(/\s+/g, " ").slice(0, 120)}` : "";
  const loc = `@ ${n.path}:${n.lineRange[0]}`;
  return `- ${n.name} [${n.type}]${sig} ${loc}${doc}`;
}

/** Render the per-subdir block: header + symbols grouped by FILE (signatures
 * only). V1: the per-file sub-blocks surface file + class boundaries so the model
 * can split a multi-responsibility directory into multiple grounded containers
 * (a single-responsibility directory still reads as one cohesive block). Files are
 * sorted for deterministic output (stable cache + tests). */
function renderSubdirLines(
  subdirPath: string,
  purpose: string,
  group: string,
  fileCount: number,
  symbols: SiltpokeGraphNode[],
): string[] {
  const head = `### ${subdirPath}  (group: ${group}; ${fileCount} files${
    purpose ? `; purpose: "${purpose}"` : ""
  })`;
  const byFile = new Map<string, SiltpokeGraphNode[]>();
  for (const s of symbols) {
    const arr = byFile.get(s.path);
    if (arr) arr.push(s);
    else byFile.set(s.path, [s]);
  }
  const fileBlocks: string[] = [];
  for (const path of [...byFile.keys()].sort()) {
    const syms = byFile.get(path)!;
    const rel = path.startsWith(subdirPath) ? path.slice(subdirPath.length) : path;
    fileBlocks.push(`#### ${rel}  (${syms.length} symbol${syms.length === 1 ? "" : "s"})`);
    for (const s of syms) fileBlocks.push(renderSymbol(s));
  }
  return [head, ...fileBlocks];
}

/** single-block cap: order-preserving tail-cut of a subdir's rendered lines
 * to a char budget. Once any line fails to fit, EVERYTHING after it is cut
 * (no cherry-picking smaller later lines back in — the cut is a strict tail).
 * Only symbol lines count toward `omittedSymbols`; the omission note is
 * appended where the model reads it. Never scores or reorders symbols. */
function truncateSubdirLines(
  lines: string[],
  maxChars: number,
): { block: string; omittedSymbols: number } {
  const note = (n: number) => `[NOTE] +${n} more symbols truncated to fit the single-pass budget`;
  const reserve = note(9_999_999).length + 1;
  const out: string[] = [];
  let chars = 0;
  let omitted = 0;
  let cut = false;
  for (const line of lines) {
    if (!cut && chars + line.length + 1 <= maxChars - reserve) {
      out.push(line);
      chars += line.length + 1;
    } else {
      cut = true;
      if (line.startsWith("- ")) omitted++;
    }
  }
  if (omitted > 0) out.push(note(omitted));
  else if (cut) out.push("[NOTE] context truncated to fit its budget share");
  return { block: out.join("\n"), omittedSymbols: omitted };
}

/**
 * Assemble the whole-repo signatures-only context. Groups symbols by the
 * aggregator's subdir set (longest-prefix path match), preserves projection
 * group order, appends the cross-subdir import-count edge summary.
 */
export function assembleArchContext(
  graph: RepoGraph,
  aggregated: AggregatedGraph,
  projection: ArchitectureProjection,
): ArchContext {
  // Subdir paths (trailing slash) from the aggregator — the canonical grouping.
  const subdirPaths = aggregated.subdirNodes
    .map((s) => s.path)
    .sort((a, b) => b.length - a.length); // longest first → correct prefix match
  const purposeByPath = new Map(aggregated.subdirNodes.map((s) => [s.path, s.purpose]));
  const groupByPath = new Map(aggregated.subdirNodes.map((s) => [s.path, s.superGroup]));
  const fileCountByPath = new Map(aggregated.subdirNodes.map((s) => [s.path, s.fileCount]));

  // Bucket every symbol node into its owning subdir (longest-prefix match).
  const symbolsByPath = new Map<string, SiltpokeGraphNode[]>();
  for (const node of graph.nodes) {
    if (!isSymbolNode(node)) continue;
    const owner = subdirPaths.find((p) => node.path.startsWith(p));
    if (!owner) continue;
    const arr = symbolsByPath.get(owner) ?? [];
    arr.push(node);
    symbolsByPath.set(owner, arr);
  }

  // Cross-subdir import-count edges (skip self + zero).
  const edgeLines = aggregated.aggregatedEdges
    .filter((e) => e.source !== e.target && e.count > 0)
    .map((e) => `  ${e.source} → ${e.target}  ×${e.count}`);

  // Order subdirs by projection group order, then by size desc within a group.
  const groupOrder = new Map(projection.groups.map((g, i) => [g.title, i]));
  const orderedSubdirs = [...symbolsByPath.keys()].sort((a, b) => {
    const ga = groupOrder.get(groupByPath.get(a) ?? "") ?? 999;
    const gb = groupOrder.get(groupByPath.get(b) ?? "") ?? 999;
    if (ga !== gb) return ga - gb;
    return (fileCountByPath.get(b) ?? 0) - (fileCountByPath.get(a) ?? 0);
  });

  // 📐 budget-sharding: under pressure EVERY subdir gets a slice of the budget
  // (the old largest-first-whole-blocks cap shipped ONLY the giant subdir on
  // claude-code-shaped repos → 19/20 member-less containers). NO-REGRESS SOUL:
  // when the full context FITS, this is byte-identical to the pre-📐 path —
  // sharding never touches a healthy repo's generate behavior.
  const blocks: string[] = [];
  const dropped: string[] = []; // always empty post-📐 (nothing dropped WHOLE); kept for the contract
  const truncatedSubdirs: Array<{ path: string; omittedSymbols: number }> = [];
  let runningTokens = estTokensOf(edgeLines.join("\n")) + 200; // edges + header slack
  const bySizeDesc = [...orderedSubdirs].sort(
    (a, b) => (fileCountByPath.get(b) ?? 0) - (fileCountByPath.get(a) ?? 0),
  );
  const kept = new Set<string>();
  const blockByPath = new Map<string, string>();
  // Standing reserve (reviewer-M): the shard capNote is a short fixed
  // sentence (counts, no path list) — reserve its worst case up front so kept
  // content ≤ effectiveBudget ∧ capNote ≤ reserve ⇒ bundle ≤ budget.
  const worstCapNoteTokens = estTokensOf(
    `\n\n[NOTE] context budget-sharded: ${bySizeDesc.length} of ${bySizeDesc.length} subdirs truncated to their budget share. Derive from the modules shown.`,
  );
  const effectiveBudget = ARCH_CONTEXT_BUDGET_TOKENS - worstCapNoteTokens;

  // Render every block once; decide whole-vs-shard from the total.
  const rendered = bySizeDesc.map((path) => {
    const lines = renderSubdirLines(
      path,
      purposeByPath.get(path) ?? "",
      groupByPath.get(path) ?? "",
      fileCountByPath.get(path) ?? 0,
      symbolsByPath.get(path) ?? [],
    );
    const block = lines.join("\n");
    return { path, lines, block, cost: estTokensOf(block) };
  });
  const available = effectiveBudget - runningTokens;
  const totalCost = rendered.reduce((n, r) => n + r.cost, 0);

  if (totalCost <= available) {
    // Fits whole — the pre-📐 happy path, byte-identical (sha-pinned in tests).
    for (const r of rendered) {
      blockByPath.set(r.path, r.block);
      runningTokens += r.cost;
      kept.add(r.path);
    }
  } else {
    // Water-filling, deterministic, one redistribution pass, ZERO scoring:
    //   share_i = max(FLOOR, available · cost_i / total), capped at cost_i;
    //   leftover from under-floor/under-share subdirs flows once to the still-
    //   truncated ones (proportional to their unmet need); if floors alone
    //   overshoot (pathological many-subdir case) everything scales down
    //   proportionally — the ≤-budget invariant always wins over the floor.
    const alloc = new Map<string, number>();
    for (const r of rendered) {
      const proportional = Math.floor((available * r.cost) / totalCost);
      alloc.set(r.path, Math.min(r.cost, Math.max(SHARD_FLOOR_TOKENS, proportional)));
    }
    const allocBudgetSum = [...alloc.values()].reduce((a, b) => a + b, 0);
    if (allocBudgetSum > available) {
      // Overshoot — scale down ONLY the above-floor portions; min(cost, FLOOR)
      // is protected (the $0 read-out exposed 1-symbol subdirs losing their
      // ONLY symbol to a blanket shave — a subdir that fits whole ships whole).
      // Σprotected ≤ N·FLOOR ≪ available in practice; the degenerate
      // many-subdir case falls back to a blanket scale (invariant > floor).
      const protectedOf = (r: { cost: number }) => Math.min(r.cost, SHARD_FLOOR_TOKENS);
      const protectedSum = rendered.reduce((n, r) => n + protectedOf(r), 0);
      if (protectedSum <= available) {
        const extraSum = allocBudgetSum - protectedSum;
        const extraBudget = available - protectedSum;
        for (const r of rendered) {
          const prot = protectedOf(r);
          const extra = (alloc.get(r.path) ?? 0) - prot;
          alloc.set(r.path, prot + (extraSum > 0 ? Math.floor((extra * extraBudget) / extraSum) : 0));
        }
      } else {
        for (const [p, a] of alloc) alloc.set(p, Math.floor((a * available) / allocBudgetSum));
      }
    } else if (allocBudgetSum < available) {
      // one redistribution pass: leftover → still-truncated subdirs by unmet need.
      const leftover = available - allocBudgetSum;
      const unmet = rendered.filter((r) => (alloc.get(r.path) ?? 0) < r.cost);
      const unmetTotal = unmet.reduce((n, r) => n + (r.cost - (alloc.get(r.path) ?? 0)), 0);
      if (unmetTotal > 0) {
        for (const r of unmet) {
          const need = r.cost - (alloc.get(r.path) ?? 0);
          const extra = Math.floor((leftover * need) / unmetTotal);
          alloc.set(r.path, Math.min(r.cost, (alloc.get(r.path) ?? 0) + extra));
        }
      }
    }
    let emittedSum = 0; // ACTUAL emitted tokens — distinct from the planning sum above
    for (const r of rendered) {
      const share = alloc.get(r.path) ?? 0;
      if (share >= r.cost) {
        blockByPath.set(r.path, r.block);
        emittedSum += r.cost;
      } else {
        const t = truncateSubdirLines(r.lines, share * CHARS_PER_TOKEN);
        blockByPath.set(r.path, t.block);
        truncatedSubdirs.push({ path: r.path, omittedSymbols: t.omittedSymbols });
        emittedSum += estTokensOf(t.block);
      }
      kept.add(r.path);
    }
    runningTokens += emittedSum;
  }

  // Emit kept subdirs in the display order (group order), not size order.
  for (const path of orderedSubdirs) {
    if (!kept.has(path)) continue;
    blocks.push(blockByPath.get(path)!);
  }

  const capNote = truncatedSubdirs.length
    ? `\n\n[NOTE] context budget-sharded: ${truncatedSubdirs.length} of ${bySizeDesc.length} subdirs truncated to their budget share. Derive from the modules shown.`
    : "";
  const contextBundle = [
    `# Repository: ${projection.repo.name}  (${projection.subdirs.length} subdirs, signatures only)`,
    "",
    "## Modules (one block per subdir; symbols are SIGNATURES ONLY — no bodies)",
    blocks.join("\n\n"),
    "",
    "## Cross-subdir import edges (source → target × count)",
    edgeLines.join("\n") || "  (none)",
    capNote,
  ].join("\n");

  // Count only SHIPPED symbols — `symbolCount` reflects what actually went to
  // the Brain: kept subdirs minus every truncated subdir's omitted tail.
  const keptSymbolCount =
    [...kept].reduce((n, p) => n + (symbolsByPath.get(p)?.length ?? 0), 0) -
    truncatedSubdirs.reduce((n, t) => n + t.omittedSymbols, 0);

  return {
    contextBundle,
    estTokens: estTokensOf(contextBundle),
    contextBytes: contextBundle.length,
    subdirCount: kept.size,
    symbolCount: keptSymbolCount,
    capped: dropped.length > 0 || truncatedSubdirs.length > 0,
    droppedSubdirs: dropped,
    truncatedSubdirs,
  };
}
