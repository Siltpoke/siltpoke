/**
 * name-based CallResolver.
 *
 * The 4 confidence classes ARE the name-resolution outcomes:
 *   dynamic call          → unresolvable
 *   static, 0 matches     → unresolved
 *   static, exactly 1     → resolved
 *   static, >1 matches    → inferred
 */
import { test, expect, describe } from "bun:test";
import { makeNameBasedResolver } from "../../src/repo-graph/call-resolver";
import { emptyGraph, emptyQueryIndex } from "../../src/repo-graph/types";
import type { RepoGraph, QueryIndex } from "../../src/repo-graph/types";

function fnNode(path: string, name: string) {
  return {
    id: `function:${path}:${name}`,
    type: "function" as const,
    name,
    path,
    lineRange: [1, 3] as [number, number],
  };
}

function graphWith(...names: Array<[string, string]>): { graph: RepoGraph; queryIndex: QueryIndex } {
  const graph = emptyGraph();
  const queryIndex = emptyQueryIndex();
  for (const [path, name] of names) {
    const node = fnNode(path, name);
    graph.nodes.push(node);
    queryIndex.name_to_node_ids[name] ??= [];
    queryIndex.name_to_node_ids[name].push(node.id);
    queryIndex.path_to_node_ids[path] ??= [];
    queryIndex.path_to_node_ids[path].push(node.id);
  }
  return { graph, queryIndex };
}

describe("makeNameBasedResolver", () => {
  test("dynamic call → unresolvable regardless of name matches", () => {
    const { graph, queryIndex } = graphWith(["src/a.ts", "foo"]);
    const r = makeNameBasedResolver(graph, queryIndex);
    expect(r.resolve({ calleeName: "foo", callKind: "dynamic" })).toEqual({
      targetId: null,
      klass: "unresolvable",
    });
  });

  test("static call with no matching symbol → unresolved", () => {
    const { graph, queryIndex } = graphWith(["src/a.ts", "foo"]);
    const r = makeNameBasedResolver(graph, queryIndex);
    expect(r.resolve({ calleeName: "console", callKind: "static" })).toEqual({
      targetId: null,
      klass: "unresolved",
    });
  });

  test("static call with exactly one matching symbol → resolved", () => {
    const { graph, queryIndex } = graphWith(["src/a.ts", "foo"]);
    const r = makeNameBasedResolver(graph, queryIndex);
    expect(r.resolve({ calleeName: "foo", callKind: "static" })).toEqual({
      targetId: "function:src/a.ts:foo",
      klass: "resolved",
    });
  });

  test("static call with multiple matching symbols → inferred (first id)", () => {
    const { graph, queryIndex } = graphWith(["src/a.ts", "save"], ["src/b.ts", "save"]);
    const r = makeNameBasedResolver(graph, queryIndex);
    const res = r.resolve({ calleeName: "save", callKind: "static" });
    expect(res.klass).toBe("inferred");
    expect(res.targetId).toBe("function:src/a.ts:save");
  });

  test("empty callee name → unresolvable", () => {
    const { graph, queryIndex } = graphWith(["src/a.ts", "foo"]);
    const r = makeNameBasedResolver(graph, queryIndex);
    expect(r.resolve({ calleeName: "", callKind: "static" }).klass).toBe("unresolvable");
  });

  test("only function/class nodes count as callable (not bare symbols)", () => {
    const { graph, queryIndex } = graphWith(["src/a.ts", "foo"]);
    // add a non-callable symbol node sharing a name
    const sym = {
      id: "symbol:src/a.ts:CONFIG",
      type: "symbol" as const,
      name: "CONFIG",
      path: "src/a.ts",
      lineRange: [1, 1] as [number, number],
    };
    graph.nodes.push(sym);
    queryIndex.name_to_node_ids["CONFIG"] ??= [];
    queryIndex.name_to_node_ids["CONFIG"].push(sym.id);
    const r = makeNameBasedResolver(graph, queryIndex);
    expect(r.resolve({ calleeName: "CONFIG", callKind: "static" }).klass).toBe("unresolved");
  });
});
