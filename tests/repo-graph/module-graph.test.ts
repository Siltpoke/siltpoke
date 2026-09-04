import { expect, test } from "bun:test";
import { deriveModuleGraph, unresolvedRatio } from "../../src/repo-graph/module-graph";
import type { RepoGraph } from "../../src/repo-graph/types";

function fileNode(path: string) {
  return { id: `file:${path}:`, type: "file" as const, name: path.split("/").pop()!, path, lineRange: [1, 1] as [number, number] };
}
function importEdge(fromPath: string, rawTarget: string) {
  return { id: `file:${fromPath}:::imports::${rawTarget}`, source: `file:${fromPath}:`, target: rawTarget, type: "imports" as const, weight: 1 };
}

test("module edges aggregate resolved imports to directory modules, drop self-edges", () => {
  const graph: RepoGraph = {
    schemaVersion: 1,
    nodes: [fileNode("src/cli/run.ts"), fileNode("src/daemon/server.ts"), fileNode("src/daemon/util.ts")],
    edges: [
      importEdge("src/cli/run.ts", "../daemon/server"),  // cli -> daemon
      importEdge("src/daemon/server.ts", "./util"),      // daemon -> daemon (self, dropped)
      importEdge("src/cli/run.ts", "react"),             // external, ignored
    ],
  };
  const mg = deriveModuleGraph(graph);
  expect(mg.edges).toContainEqual(["src/cli/", "src/daemon/"]);
  expect(mg.edges.find(([a, b]) => a === b)).toBeUndefined();
  expect(mg.modules).toEqual(expect.arrayContaining(["src/cli/", "src/daemon/"]));
  expect(mg.resolvedInternal).toBe(2);
});

test("unresolved alias-shaped specifiers count toward the ratio; bare specifiers do not", () => {
  const graph: RepoGraph = {
    schemaVersion: 1,
    nodes: [fileNode("src/cli/run.ts"), fileNode("src/daemon/server.ts")],
    edges: [
      importEdge("src/cli/run.ts", "@/daemon/server"),   // alias-shaped, NO anchorMap → unresolved-internal
      importEdge("src/cli/run.ts", "node:fs"),           // bare/external → not counted
    ],
  };
  const mg = deriveModuleGraph(graph); // no anchorMap
  expect(mg.unresolvedInternal).toBe(1);
  expect(unresolvedRatio(mg)).toBeCloseTo(1.0);
});
