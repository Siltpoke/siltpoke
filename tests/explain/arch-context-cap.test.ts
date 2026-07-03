/** arch-context single-block cap bypass.
 *
 * Bug: the budget loop's drop condition (`runningTokens + cost > BUDGET &&
 * kept.size > 0`) exempted the FIRST (largest) subdir — a single huge subdir
 * (claude-code's utils: 5829 fns) shipped an oversized context straight into
 * `claude -p`, which died exit-1 at the 200K window (6/6 failures on record).
 *
 * THE INVARIANT under test: assembled `estTokens ≤ ARCH_CONTEXT_BUDGET_TOKENS`
 * always — including when one subdir's block alone exceeds the whole budget.
 * Oversized first block → order-preserving tail truncation + reported count,
 * never a scoring pass, never an oversized pass-through.
 */
import { describe, expect, it } from "bun:test";
import { aggregateBySuperGroup } from "../../src/repo-graph/aggregator";
import { projectArchitecture } from "../../src/repo-graph/project-architecture";
import type { RepoGraph, RepoGraphMeta, SiltpokeGraphNode } from "../../src/repo-graph/types";
import {
  ARCH_CONTEXT_BUDGET_TOKENS,
  assembleArchContext,
} from "../../src/explain/arch-context";

function fileNode(path: string): SiltpokeGraphNode {
  return { id: `file:${path}:`, type: "file", name: path.split("/").pop()!, path, lineRange: [1, 80] };
}
function fnNode(path: string, name: string, signature: string): SiltpokeGraphNode {
  return { id: `function:${path}:${name}`, type: "function", name, path, lineRange: [12, 40], signature };
}
function meta(root: string): RepoGraphMeta {
  return {
    schemaVersion: 1,
    project_root: root,
    proj_hash: "deadbeef0000",
    last_indexed_ts: "2026-06-03T00:00:00Z",
    build_duration_ms: 1,
    counters: {
      files_walked: 2,
      files_cached: 0,
      skipped: { tree_sitter_failed: 0, too_large: 0, not_a_source_file: 0, file_cap: 0 },
      nodes: { file: 2, function: 2, class: 0, module: 0, symbol: 0 },
      edges: { imports: 0, calls: 0, contains: 0 },
    },
  };
}

const LONG_SIG = `export function PAD(${"aVeryLongParameterName: SomeExtremelyLongGenericTypeName<WithTypeArguments, AndEvenMoreOfThem>, ".repeat(2)}): Promise<AnEqualleyVerboseReturnTypeForPadding>`;

/** One subdir whose symbols alone far exceed the token budget — the
 * claude-code utils/ shape. Counts sized well past ARCH_CONTEXT_BUDGET_TOKENS
 * at any plausible divisor. */
function hugeSingleSubdirGraph(): RepoGraph {
  const nodes: SiltpokeGraphNode[] = [];
  for (let f = 0; f < 10; f++) {
    const path = `src/huge/file${String(f).padStart(2, "0")}.ts`;
    nodes.push(fileNode(path));
    for (let i = 0; i < 400; i++) {
      nodes.push(fnNode(path, `fn_${f}_${i}`, LONG_SIG));
    }
  }
  return { schemaVersion: 1, nodes, edges: [] };
}

function buildHuge() {
  const graph = hugeSingleSubdirGraph();
  const aggregated = aggregateBySuperGroup(graph, null);
  const projection = projectArchitecture(graph, null, meta("/x/huge-demo"));
  return assembleArchContext(graph, aggregated, projection);
}

describe("arch-context budget — no single-block exemption (the invariant)", () => {
  it("a single subdir block exceeding the whole budget is hard-truncated: estTokens ≤ budget", () => {
    const ctx = buildHuge();
    // ── THE INVARIANT. Pre-fix code passes the oversized first block through
    // (estTokens ≈ 240k here) and this line is the crisp RED.
    expect(ctx.estTokens).toBeLessThanOrEqual(ARCH_CONTEXT_BUDGET_TOKENS);
    // The truncation is honest, not silent.
    expect(ctx.capped).toBe(true);
    // 📐 conscious update: singular truncatedSubdir → plural truncatedSubdirs.
    const huge = ctx.truncatedSubdirs.find((t) => t.path === "src/huge/");
    expect(huge).toBeDefined();
    expect(huge!.omittedSymbols).toBeGreaterThan(0);
  });

  it("truncation is order-preserving tail-cut with an in-bundle note (no symbol scoring)", () => {
    const ctx = buildHuge();
    // Files render in sorted order — early file's symbols survive, the tail dies.
    expect(ctx.contextBundle).toContain("fn_0_0");
    expect(ctx.contextBundle).not.toContain("fn_9_399");
    // The note names the omitted count where the model reads it.
    expect(ctx.contextBundle).toMatch(/\+\d+ more symbols truncated to fit the single-pass budget/);
    // symbolCount reflects what actually shipped, not the pre-cut total.
    expect(ctx.symbolCount).toBeLessThan(4000);
    expect(ctx.symbolCount).toBeGreaterThan(0);
  });

  it("📐 CONSCIOUS FLIP (was: whole-drop regression): a big+small pair that fits TOGETHER ships whole — and even under pressure nothing is dropped whole anymore", () => {
    // First subdir fits comfortably; second would overflow → dropped whole.
    const nodes: SiltpokeGraphNode[] = [];
    for (let f = 0; f < 6; f++) {
      const path = `src/big/file${f}.ts`;
      nodes.push(fileNode(path));
      for (let i = 0; i < 260; i++) nodes.push(fnNode(path, `big_${f}_${i}`, LONG_SIG));
    }
    const smallPath = "src/small/only.ts";
    nodes.push(fileNode(smallPath));
    for (let i = 0; i < 600; i++) nodes.push(fnNode(smallPath, `small_${i}`, LONG_SIG));
    const graph: RepoGraph = { schemaVersion: 1, nodes, edges: [] };
    const aggregated = aggregateBySuperGroup(graph, null);
    const projection = projectArchitecture(graph, null, meta("/x/two-demo"));
    const ctx = assembleArchContext(graph, aggregated, projection);

    expect(ctx.estTokens).toBeLessThanOrEqual(ARCH_CONTEXT_BUDGET_TOKENS);
    // 📐 FLIP: pre-📐 src/small/ was DROPPED WHOLE here; sharding never drops
    // whole — this fixture (155k total) now fits the 160k budget entirely.
    expect(ctx.droppedSubdirs).toEqual([]);
    expect(ctx.contextBundle).toContain("small_0");
  });

  it("truncation + mass-drop combined still holds the invariant (capNote reserved)", () => {
    // Reviewer-M scenario: a huge first subdir (truncated) PLUS many remaining
    // subdirs (all dropped) — the long capNote listing every dropped path must
    // not push the final bundle back over budget.
    const nodes: SiltpokeGraphNode[] = [];
    for (let f = 0; f < 10; f++) {
      const path = `src/huge/file${String(f).padStart(2, "0")}.ts`;
      nodes.push(fileNode(path));
      for (let i = 0; i < 400; i++) nodes.push(fnNode(path, `fn_${f}_${i}`, LONG_SIG));
    }
    for (let d = 0; d < 60; d++) {
      const path = `src/package-${String(d).padStart(2, "0")}-with-a-rather-long-directory-name/mod.ts`;
      nodes.push(fileNode(path));
      nodes.push(fnNode(path, `tiny_${d}`, LONG_SIG));
    }
    const graph: RepoGraph = { schemaVersion: 1, nodes, edges: [] };
    const aggregated = aggregateBySuperGroup(graph, null);
    const projection = projectArchitecture(graph, null, meta("/x/combo-demo"));
    const ctx = assembleArchContext(graph, aggregated, projection);

    expect(ctx.estTokens).toBeLessThanOrEqual(ARCH_CONTEXT_BUDGET_TOKENS); // invariant survives the combo
    // 📐 FLIP: the 60 tinies were dropped whole pre-📐; now everyone ships a slice.
    expect(ctx.truncatedSubdirs.some((t) => t.path === "src/huge/")).toBe(true);
    expect(ctx.droppedSubdirs).toEqual([]);
    expect(ctx.subdirCount).toBe(61);
  });
});
