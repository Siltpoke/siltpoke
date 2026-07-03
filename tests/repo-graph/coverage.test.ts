/**
 * repo-level coverage gate.
 *
 * Coverage = of the IN-REPO-ELIGIBLE call sites (target name defined somewhere
 * in the repo, so a resolver COULD link it), how many were pinned to a single
 * confident definition (klass "resolved"). External / stdlib calls (no in-repo
 * definition — unlinkable by ANY static resolver) and dynamic dispatch are
 * EXCLUDED from the denominator; ambiguous (inferred, >1 candidate) calls count
 * against confidence (precision). This replaces the raw resolved/all metric,
 * which read ~30% RED on every healthy TS repo (70% of calls are external).
 * Drives the gate: green ≥60 / yellow ≥40 / red.
 */
import { test, expect, describe } from "bun:test";
import { computeCoverage } from "../../src/repo-graph/coverage";
import { emptyGraph, emptyQueryIndex } from "../../src/repo-graph/types";
import type { RepoGraph, QueryIndex, SiltpokeGraphEdge } from "../../src/repo-graph/types";

function fn(path: string, name: string) {
  return {
    id: `function:${path}:${name}`,
    type: "function" as const,
    name,
    path,
    lineRange: [1, 2] as [number, number],
  };
}

function callEdge(
  source: string,
  target: string,
  kind: "static" | "dynamic",
  weight = 1,
): SiltpokeGraphEdge {
  return { id: `${source}::calls::${target}`, source, target, type: "calls", weight, call_kind: kind };
}

/** Graph where `defined` names exist as fn nodes and `calls` are call edges. */
function makeGraph(defined: string[], calls: SiltpokeGraphEdge[]): { graph: RepoGraph; queryIndex: QueryIndex } {
  const graph = emptyGraph();
  const queryIndex = emptyQueryIndex();
  for (const name of defined) {
    const node = fn("src/a.ts", name);
    graph.nodes.push(node);
    queryIndex.name_to_node_ids[name] ??= [];
    queryIndex.name_to_node_ids[name].push(node.id);
    queryIndex.path_to_node_ids["src/a.ts"] ??= [];
    queryIndex.path_to_node_ids["src/a.ts"].push(node.id);
  }
  graph.edges.push(...calls);
  return { graph, queryIndex };
}

describe("computeCoverage (eligible-denominator recalibration)", () => {
  test("all eligible calls confidently resolved → 100% green", () => {
    const { graph, queryIndex } = makeGraph(
      ["a", "b"],
      [callEdge("function:src/a.ts:a", "b", "static")],
    );
    const cov = computeCoverage(graph, queryIndex);
    expect(cov.totalCallsites).toBe(1); // eligible
    expect(cov.resolvedCallsites).toBe(1); // confident
    expect(cov.pct).toBe(100);
    expect(cov.tier).toBe("green");
  });

  // THE KEY FIX: external / stdlib calls (no in-repo definition) are NOT
  // eligible — they can't drag the tier. A repo that links every in-repo call
  // stays green even when most call VOLUME is external (the 70% TS floor).
  test("external/stdlib calls are excluded from the denominator (don't drag the tier)", () => {
    const { graph, queryIndex } = makeGraph(
      ["a", "b"],
      [
        callEdge("function:src/a.ts:a", "b", "static", 3), // in-repo, exact ×3
        callEdge("function:src/a.ts:a", "writeFileSync", "static", 20), // external ×20
        callEdge("function:src/a.ts:a", "slice", "static", 50), // stdlib ×50
        callEdge("function:src/a.ts:a", "", "dynamic", 10), // dynamic ×10
      ],
    );
    const cov = computeCoverage(graph, queryIndex);
    expect(cov.totalCallsites).toBe(3); // only the in-repo-eligible 3
    expect(cov.resolvedCallsites).toBe(3);
    expect(cov.pct).toBe(100);
    expect(cov.tier).toBe("green");
  });

  test("ambiguous (inferred, >1 candidate) lowers confidence — precision signal", () => {
    const graph = emptyGraph();
    const queryIndex = emptyQueryIndex();
    // "save" defined twice → an inferred (ambiguous) call; "a"/"b" exact.
    for (const path of ["src/a.ts", "src/b.ts"]) {
      const node = fn(path, "save");
      graph.nodes.push(node);
      queryIndex.name_to_node_ids["save"] ??= [];
      queryIndex.name_to_node_ids["save"].push(node.id);
    }
    for (const name of ["a", "b"]) {
      const node = fn("src/a.ts", name);
      graph.nodes.push(node);
      queryIndex.name_to_node_ids[name] ??= [];
      queryIndex.name_to_node_ids[name].push(node.id);
    }
    graph.edges.push(
      callEdge("function:src/a.ts:a", "b", "static"), // exact (confident)
      callEdge("function:src/a.ts:a", "save", "static"), // inferred (ambiguous) → NOT confident
    );
    const cov = computeCoverage(graph, queryIndex);
    expect(cov.totalCallsites).toBe(2); // both eligible (defined in repo)
    expect(cov.resolvedCallsites).toBe(1); // only the exact one is confident
    expect(cov.pct).toBe(50);
    expect(cov.tier).toBe("yellow");
  });

  test("mostly-ambiguous eligible calls → red tier", () => {
    const graph = emptyGraph();
    const queryIndex = emptyQueryIndex();
    for (const path of ["src/a.ts", "src/b.ts", "src/c.ts"]) {
      const node = fn(path, "save");
      graph.nodes.push(node);
      queryIndex.name_to_node_ids["save"] ??= [];
      queryIndex.name_to_node_ids["save"].push(node.id);
    }
    const exact = fn("src/a.ts", "only");
    graph.nodes.push(exact);
    queryIndex.name_to_node_ids["only"] = [exact.id];
    graph.edges.push(
      callEdge("function:src/a.ts:save", "save", "static", 3), // inferred ×3
      callEdge("function:src/a.ts:save", "only", "static", 1), // exact ×1
    );
    const cov = computeCoverage(graph, queryIndex);
    expect(cov.totalCallsites).toBe(4); // eligible
    expect(cov.resolvedCallsites).toBe(1); // confident
    expect(cov.pct).toBe(25);
    expect(cov.tier).toBe("red");
  });

  test("no in-repo-eligible calls → 0% red (nothing confident to draw)", () => {
    const { graph, queryIndex } = makeGraph(
      ["a"],
      [callEdge("function:src/a.ts:a", "externalOnly", "static")],
    );
    const cov = computeCoverage(graph, queryIndex);
    expect(cov.totalCallsites).toBe(0);
    expect(cov.pct).toBe(0);
    expect(cov.tier).toBe("red");
  });
});
