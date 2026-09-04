/**
 * Pre-flight large-repo truncation predicate (`archGenerateMayTruncate`).
 *
 * The honest signal is on the INPUT side: a budget-capped context
 * (`truncatedSubdirCount > 0`) is why the model pegs its 32K output cap. The
 * predicate is PURE and repo-size-sensitive — it warns iff the pre-flight
 * budgeter had to shard. Non-vacuous: both branches asserted at the boundary
 * (0 → no-warn, 1 → warn).
 */
import { describe, expect, it } from "bun:test";
import { aggregateBySuperGroup } from "../../src/repo-graph/aggregator";
import { projectArchitecture } from "../../src/repo-graph/project-architecture";
import type { RepoGraph, RepoGraphMeta, SiltpokeGraphNode } from "../../src/repo-graph/types";
import { assembleArchContext } from "../../src/explain/arch-context";
import {
  ARCH_OUTPUT_CAP_TOKENS,
  archGenerateMayTruncate,
} from "../../src/explain/arch-generate";

describe("archGenerateMayTruncate (pre-flight predicate)", () => {
  it("does NOT warn when the whole context fit (truncatedSubdirCount === 0)", () => {
    // Boundary low side: zero sharding → the byte-identical no-regress path →
    // no false-positive nag (spec: accept false negatives over false positives).
    expect(archGenerateMayTruncate({ truncatedSubdirCount: 0 })).toBe(false);
  });

  it("WARNS at the boundary when one subdir was sharded (truncatedSubdirCount === 1)", () => {
    // Boundary high side: the budgeter had to compress to fit the 200K window →
    // output will likely peg the cap → truncation risk → advisory warn.
    expect(archGenerateMayTruncate({ truncatedSubdirCount: 1 })).toBe(true);
  });

  it("warns for a heavily-sharded large repo (truncatedSubdirCount >> 1)", () => {
    expect(archGenerateMayTruncate({ truncatedSubdirCount: 19 })).toBe(true);
  });

  it("anchors the cap on the existing constant, no second magic number", () => {
    // Contingency 3: EST_OUTPUT_TOKENS (31_000) sits hard against this cap —
    // documents WHY budget pressure means cap-pegging, reusing the SSOT.
    expect(ARCH_OUTPUT_CAP_TOKENS).toBe(32_000);
  });
});

// ── End-to-end wiring (non-vacuous): prove the predicate is fed by the REAL
// budget-pressure signal from `assembleArchContext`, not a hand-built number.
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
 parse_degraded: 0,
      skipped: { tree_sitter_failed: 0, too_large: 0, not_a_source_file: 0, file_cap: 0 },
      nodes: { file: 2, function: 2, class: 0, module: 0, symbol: 0 },
      edges: { imports: 0, calls: 0, contains: 0 },
    },
  };
}
const LONG_SIG = `export function PAD(${"aVeryLongParameterName: SomeExtremelyLongGenericTypeName<WithTypeArguments, AndEvenMoreOfThem>, ".repeat(2)}): Promise<AnEquallyVerboseReturnTypeForPadding>`;

/** Whole-budget-busting repo (claude-code shape) → forces sharding. */
function hugeRepo(): RepoGraph {
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

/** Tiny repo that fits the budget comfortably → no sharding. */
function tinyRepo(): RepoGraph {
  return {
    schemaVersion: 1,
    nodes: [
      fileNode("src/a/mod.ts"),
      fnNode("src/a/mod.ts", "foo", "export function foo(): void"),
    ],
    edges: [],
  };
}

function estFor(graph: RepoGraph): { truncatedSubdirCount: number } {
  const aggregated = aggregateBySuperGroup(graph, null);
  const projection = projectArchitecture(graph, null, meta("/x/preflight-demo"));
  const ctx = assembleArchContext(graph, aggregated, projection);
  return { truncatedSubdirCount: ctx.truncatedSubdirs.length };
}

describe("archGenerateMayTruncate — fed by the REAL assembleArchContext signal", () => {
  it("fires TRUE on a budget-busting repo that forces sharding", () => {
    const est = estFor(hugeRepo());
    expect(est.truncatedSubdirCount).toBeGreaterThan(0); // door opened: real sharding happened
    expect(archGenerateMayTruncate(est)).toBe(true);
  });

  it("stays FALSE on a tiny repo whose context fits (no false nag)", () => {
    const est = estFor(tinyRepo());
    expect(est.truncatedSubdirCount).toBe(0); // door: no sharding
    expect(archGenerateMayTruncate(est)).toBe(false);
  });
});
