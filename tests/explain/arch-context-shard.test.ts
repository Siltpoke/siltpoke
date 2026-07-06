/** budget-sharding — every subdir gets a slice; sharding ONLY under pressure.
 *
 * Before budget-sharding (the largest-first-whole-blocks cap): a one-huge-many-
 * small repo (the claude-code shape) ships ONLY the huge subdir — the other
 * subdirs are dropped whole, so the LLM never sees them and 19/20 containers
 * end up member-less (root of the A-line's honest "no file evidence" reads).
 *
 * THE NO-REGRESS SOUL (a standing rule): a repo whose full context FITS the budget
 * produces a BYTE-IDENTICAL bundle — sharding must never touch the generate
 * behavior of already-healthy repos. Pinned by a sha256 snapshot taken on
 * pre-sharding code.
 */
import { createHash } from "node:crypto";
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
    schemaVersion: 1, project_root: root, proj_hash: "deadbeef0000",
    last_indexed_ts: "2026-06-03T00:00:00Z", build_duration_ms: 1,
    counters: {
      files_walked: 2, files_cached: 0,
      skipped: { tree_sitter_failed: 0, too_large: 0, not_a_source_file: 0, file_cap: 0 },
      nodes: { file: 2, function: 2, class: 0, module: 0, symbol: 0 },
      edges: { imports: 0, calls: 0, contains: 0 },
    },
  };
}
const LONG_SIG = `export function PAD(${"aVeryLongParameterName: SomeExtremelyLongGenericTypeName<WithTypeArguments, AndEvenMoreOfThem>, ".repeat(2)}): Promise<AnEqualleyVerboseReturnTypeForPadding>`;

/** claude-code shape: one subdir alone over the whole budget + many small. */
function oneHugeManySmall(): RepoGraph {
  const nodes: SiltpokeGraphNode[] = [];
  for (let f = 0; f < 10; f++) {
    const path = `src/huge/file${String(f).padStart(2, "0")}.ts`;
    nodes.push(fileNode(path));
    for (let i = 0; i < 400; i++) nodes.push(fnNode(path, `huge_${f}_${i}`, LONG_SIG));
  }
  for (let d = 0; d < 12; d++) {
    const path = `src/small${String(d).padStart(2, "0")}/mod.ts`;
    nodes.push(fileNode(path));
    for (let i = 0; i < 30; i++) nodes.push(fnNode(path, `s${d}_${i}`, LONG_SIG));
  }
  return { schemaVersion: 1, nodes, edges: [] };
}

function assemble(graph: RepoGraph) {
  const aggregated = aggregateBySuperGroup(graph, null);
  const projection = projectArchitecture(graph, null, meta("/x/shard-demo"));
  return assembleArchContext(graph, aggregated, projection);
}

describe("budget-sharding — breadth under pressure, byte-silence when healthy", () => {
  it("over-budget repo: EVERY subdir appears in the bundle (≤ budget, truncations reported)", () => {
    const ctx = assemble(oneHugeManySmall());
    expect(ctx.estTokens).toBeLessThanOrEqual(ARCH_CONTEXT_BUDGET_TOKENS); // invariant inherited
    // ── Before budget-sharding, the small subdirs are dropped whole — the
    // bundle contains ONLY huge_* symbols and droppedSubdirs has 12 entries.
    for (let d = 0; d < 12; d++) {
      expect(ctx.contextBundle).toContain(`- s${d}_0 `); // first symbol of each small subdir (tail-cut keeps heads)
    }
    expect(ctx.droppedSubdirs).toEqual([]); // nothing dropped WHOLE anymore
    expect(ctx.subdirCount).toBe(13);
    // the huge subdir is truncated to its share, and says so
    expect(ctx.truncatedSubdirs.some((t) => t.path === "src/huge/" && t.omittedSymbols > 0)).toBe(true);
  });

  it("the huge subdir still gets the LION'S share (proportional, not equal-split)", () => {
    const ctx = assemble(oneHugeManySmall());
    const hugeShipped = (ctx.contextBundle.match(/- huge_/g) ?? []).length;
    const small0Shipped = (ctx.contextBundle.match(/- s0_/g) ?? []).length;
    expect(hugeShipped).toBeGreaterThan(small0Shipped * 5); // proportionality sanity
    expect(small0Shipped).toBeGreaterThanOrEqual(1); // floor: never starved to zero
  });

  it("NO-REGRESS SOUL: a repo that fits produces a byte-identical bundle (sha256 pinned on pre-sharding code)", () => {
    const nodes: SiltpokeGraphNode[] = [];
    for (let d = 0; d < 3; d++) {
      const path = `src/dir${d}/mod.ts`;
      nodes.push(fileNode(path));
      for (let i = 0; i < 20; i++) nodes.push(fnNode(path, `fits_${d}_${i}`, LONG_SIG));
    }
    const ctx = assemble({ schemaVersion: 1, nodes, edges: [] });
    expect(ctx.capped).toBe(false);
    expect(ctx.truncatedSubdirs ?? []).toEqual([]); // tolerant: field is plural after sharding, absent before
    expect(ctx.droppedSubdirs).toEqual([]);
    const sha = createHash("sha256").update(ctx.contextBundle).digest("hex");
    // Pinned from a pre-sharding run — sharding must not move a single byte here.
    expect(sha).toBe("92c88a3d536709ad5fec5be4e98bfd28f57cac0ccde305c9cd44cf95846f9057");
  });
});
