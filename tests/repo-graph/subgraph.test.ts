/**
 * subgraph.ts tests.
 *
 * Subgraph layer works ON the persisted graph edges only (contains / imports
 * are populated at index time; calls / extends / references are deferred). Calls
 * resolution at query time lands in the explain orchestrator where source is
 * already being loaded for the Brain prompt.
 */
import { test, expect, describe } from "bun:test";
import {
  buildSubgraph,
  NEIGHBOR_CAP,
} from "../../src/repo-graph/subgraph";
import type {
  RepoGraph,
  SiltpokeGraphNode,
  SiltpokeGraphEdge,
} from "../../src/repo-graph/types";

function makeNode(
  id: string,
  type: SiltpokeGraphNode["type"],
  name: string,
  path: string,
  startLine = 1,
  endLine = 10,
): SiltpokeGraphNode {
  return { id, type, name, path, lineRange: [startLine, endLine] };
}

function makeEdge(
  source: string,
  target: string,
  type: SiltpokeGraphEdge["type"],
  weight = 1,
): SiltpokeGraphEdge {
  return {
    id: `${source}::${type}::${target}`,
    source,
    target,
    type,
    weight,
  };
}

describe("buildSubgraph", () => {
  test("depth=1 collects target + 1-hop contains + imports neighbors", () => {
    const fileId = "file:src/cli/doctor.ts:";
    const fnId = "function:src/cli/doctor.ts:runDoctor";
    const importTarget = "./doctor-config";
    const graph: RepoGraph = {
      schemaVersion: 1,
      nodes: [
        makeNode(fileId, "file", "doctor.ts", "src/cli/doctor.ts", 1, 100),
        makeNode(fnId, "function", "runDoctor", "src/cli/doctor.ts", 42, 87),
        makeNode(
          "function:src/cli/doctor.ts:loadDoctorConfig",
          "function",
          "loadDoctorConfig",
          "src/cli/doctor.ts",
          5,
          20,
        ),
      ],
      edges: [
        makeEdge(fileId, fnId, "contains"),
        makeEdge(fileId, "function:src/cli/doctor.ts:loadDoctorConfig", "contains"),
        makeEdge(fileId, importTarget, "imports"),
      ],
    };

    const sub = buildSubgraph(fnId, graph, 1);

    expect(sub.target.id).toBe(fnId);
    expect(sub.nodes.map((n) => n.id)).toContain(fnId);
    // file is reachable via incoming `contains`
    expect(sub.nodes.map((n) => n.id)).toContain(fileId);
    // contains edge between file and target included
    const containsEdge = sub.edges.find(
      (e) => e.type === "contains" && e.target === fnId,
    );
    expect(containsEdge).toBeDefined();
  });

  test("depth=2 expands one more hop", () => {
    const a = "function:src/a.ts:a";
    const b = "function:src/b.ts:b";
    const c = "function:src/c.ts:c";
    const graph: RepoGraph = {
      schemaVersion: 1,
      nodes: [
        makeNode(a, "function", "a", "src/a.ts"),
        makeNode(b, "function", "b", "src/b.ts"),
        makeNode(c, "function", "c", "src/c.ts"),
      ],
      edges: [
        makeEdge(a, b, "calls"),
        makeEdge(b, c, "calls"),
      ],
    };

    const sub1 = buildSubgraph(a, graph, 1);
    const sub2 = buildSubgraph(a, graph, 2);

    expect(sub1.nodes.map((n) => n.id)).toEqual(
      expect.arrayContaining([a, b]),
    );
    expect(sub1.nodes.map((n) => n.id)).not.toContain(c);
    expect(sub2.nodes.map((n) => n.id)).toEqual(
      expect.arrayContaining([a, b, c]),
    );
  });

  test("traverses both incoming and outgoing edges (undirected reach)", () => {
    const caller = "function:src/caller.ts:caller";
    const callee = "function:src/callee.ts:callee";
    const target = "function:src/target.ts:target";
    const graph: RepoGraph = {
      schemaVersion: 1,
      nodes: [
        makeNode(caller, "function", "caller", "src/caller.ts"),
        makeNode(callee, "function", "callee", "src/callee.ts"),
        makeNode(target, "function", "target", "src/target.ts"),
      ],
      edges: [
        makeEdge(caller, target, "calls"),
        makeEdge(target, callee, "calls"),
      ],
    };

    const sub = buildSubgraph(target, graph, 1);
    expect(sub.nodes.map((n) => n.id)).toEqual(
      expect.arrayContaining([caller, target, callee]),
    );
  });

  test("target not in graph throws", () => {
    const graph: RepoGraph = {
      schemaVersion: 1,
      nodes: [],
      edges: [],
    };
    expect(() => buildSubgraph("missing", graph, 1)).toThrow(
      /target node not found/i,
    );
  });

  test("respects NEIGHBOR_CAP per node — hub with 100 callers truncates to cap", () => {
    const hub = "function:src/hub.ts:hub";
    const nodes: SiltpokeGraphNode[] = [
      makeNode(hub, "function", "hub", "src/hub.ts"),
    ];
    const edges: SiltpokeGraphEdge[] = [];
    for (let i = 0; i < 100; i++) {
      const callerId = `function:src/caller-${i}.ts:caller${i}`;
      nodes.push(
        makeNode(callerId, "function", `caller${i}`, `src/caller-${i}.ts`),
      );
      edges.push(makeEdge(callerId, hub, "calls"));
    }
    const graph: RepoGraph = { schemaVersion: 1, nodes, edges };
    const sub = buildSubgraph(hub, graph, 1);

    // target + at most NEIGHBOR_CAP neighbors
    expect(sub.nodes.length).toBeLessThanOrEqual(NEIGHBOR_CAP + 1);
    expect(sub.truncated).toBe(true);
  });

  test("no truncation flag set when under cap", () => {
    const fileId = "file:src/x.ts:";
    const fnId = "function:src/x.ts:foo";
    const graph: RepoGraph = {
      schemaVersion: 1,
      nodes: [
        makeNode(fileId, "file", "x.ts", "src/x.ts"),
        makeNode(fnId, "function", "foo", "src/x.ts"),
      ],
      edges: [makeEdge(fileId, fnId, "contains")],
    };
    const sub = buildSubgraph(fnId, graph, 1);
    expect(sub.truncated).toBe(false);
  });

  test("includes raw string import edges (the indexer leaves targets as strings)", () => {
    const fileId = "file:src/a.ts:";
    const fnId = "function:src/a.ts:foo";
    const graph: RepoGraph = {
      schemaVersion: 1,
      nodes: [
        makeNode(fileId, "file", "a.ts", "src/a.ts"),
        makeNode(fnId, "function", "foo", "src/a.ts"),
      ],
      edges: [
        makeEdge(fileId, fnId, "contains"),
        makeEdge(fileId, "./b", "imports"),
        makeEdge(fileId, "node:fs/promises", "imports"),
      ],
    };
    const sub = buildSubgraph(fnId, graph, 1);
    const importEdges = sub.edges.filter((e) => e.type === "imports");
    expect(importEdges.map((e) => e.target)).toEqual(
      expect.arrayContaining(["./b", "node:fs/promises"]),
    );
  });
});
