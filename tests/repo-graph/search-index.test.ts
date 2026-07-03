/**
 * search-index tests (read-time defense).
 *
 * queryIndex consumers MUST wrap
 * `name_to_node_ids[query]` lookups to defend against prototype-
 * pollution names like `__proto__`, `constructor`, `toString`. This
 * module is the first read-time consumer to land the fix.
 */
import { test, expect, describe } from "bun:test";
import {
  buildSearchIndex,
  fuzzyMatch,
} from "../../src/repo-graph/search-index";
import {
  emptyGraph,
  emptyQueryIndex,
  type QueryIndex,
  type RepoGraph,
  type SiltpokeGraphNode,
} from "../../src/repo-graph/types";

function fnNode(path: string, name: string): SiltpokeGraphNode {
  return {
    id: `function:${path}:${name}`,
    type: "function",
    name,
    path,
    lineRange: [1, 10],
  };
}

function makeFixture(
  entries: Array<{ path: string; name: string }>,
): { graph: RepoGraph; queryIndex: QueryIndex } {
  const graph = emptyGraph();
  const queryIndex = emptyQueryIndex();
  for (const e of entries) {
    const node = fnNode(e.path, e.name);
    graph.nodes.push(node);
    // Object.hasOwn defends the fixture against Object.prototype keys
    // like "constructor" — mirrors the builder's own pattern.
    const existing = Object.hasOwn(queryIndex.name_to_node_ids, e.name)
      ? queryIndex.name_to_node_ids[e.name]!
      : [];
    existing.push(node.id);
    queryIndex.name_to_node_ids[e.name] = existing;
    queryIndex.path_to_node_ids[e.path] = [node.id];
  }
  return { graph, queryIndex };
}

describe("fuzzyMatch — basic ranking", () => {
  test("empty query returns empty matches", () => {
    const { graph, queryIndex } = makeFixture([{ path: "src/x.ts", name: "foo" }]);
    const index = buildSearchIndex(graph, queryIndex);
    expect(fuzzyMatch("", index)).toEqual([]);
  });

  test("exact match outranks prefix outranks substring", () => {
    const { graph, queryIndex } = makeFixture([
      { path: "src/a.ts", name: "runDoctor" }, // substring
      { path: "src/b.ts", name: "run" }, // exact
      { path: "src/c.ts", name: "runner" }, // prefix
    ]);
    const index = buildSearchIndex(graph, queryIndex);
    const matches = fuzzyMatch("run", index);
    expect(matches.map((m) => m.name)).toEqual(["run", "runner", "runDoctor"]);
  });

  test("case-insensitive matching", () => {
    const { graph, queryIndex } = makeFixture([
      { path: "src/x.ts", name: "RunDoctor" },
    ]);
    const index = buildSearchIndex(graph, queryIndex);
    expect(fuzzyMatch("rundoctor", index)).toHaveLength(1);
    expect(fuzzyMatch("RUNDOCTOR", index)).toHaveLength(1);
  });

  test("limit honored — caps result count", () => {
    const entries = Array.from({ length: 20 }, (_, i) => ({
      path: `src/f${i}.ts`,
      name: `fnPrefix${i}`,
    }));
    const { graph, queryIndex } = makeFixture(entries);
    const index = buildSearchIndex(graph, queryIndex);
    expect(fuzzyMatch("fnPrefix", index, 5)).toHaveLength(5);
    expect(fuzzyMatch("fnPrefix", index, 100)).toHaveLength(20);
  });

  test("default limit is 10", () => {
    const entries = Array.from({ length: 20 }, (_, i) => ({
      path: `src/f${i}.ts`,
      name: `fnPrefix${i}`,
    }));
    const { graph, queryIndex } = makeFixture(entries);
    const index = buildSearchIndex(graph, queryIndex);
    expect(fuzzyMatch("fnPrefix", index)).toHaveLength(10);
  });

  test("returns hydrated match shape with node_id + name + type + path + score", () => {
    const { graph, queryIndex } = makeFixture([
      { path: "src/cli/doctor.ts", name: "runDoctor" },
    ]);
    const index = buildSearchIndex(graph, queryIndex);
    const [m] = fuzzyMatch("runDoctor", index);
    expect(m).toEqual({
      node_id: "function:src/cli/doctor.ts:runDoctor",
      name: "runDoctor",
      type: "function",
      path: "src/cli/doctor.ts",
      score: 100,
    });
  });

  test("query with no matches returns empty array (no Levenshtein fallback at this layer)", () => {
    const { graph, queryIndex } = makeFixture([{ path: "src/x.ts", name: "foo" }]);
    const index = buildSearchIndex(graph, queryIndex);
    expect(fuzzyMatch("zzz_completely_unrelated", index)).toEqual([]);
  });
});

describe("fuzzyMatch — F24 prototype-pollution defense (read-time)", () => {
  test("query for `__proto__` does not return Object.prototype methods", () => {
    const { graph, queryIndex } = makeFixture([{ path: "src/x.ts", name: "foo" }]);
    const index = buildSearchIndex(graph, queryIndex);
    const matches = fuzzyMatch("__proto__", index);
    expect(matches).toEqual([]);
  });

  test("query for `constructor` does not return Object constructor", () => {
    const { graph, queryIndex } = makeFixture([{ path: "src/x.ts", name: "foo" }]);
    const index = buildSearchIndex(graph, queryIndex);
    const matches = fuzzyMatch("constructor", index);
    expect(matches).toEqual([]);
  });

  test("query for `toString` returns no false-positive Object.prototype hit", () => {
    const { graph, queryIndex } = makeFixture([{ path: "src/x.ts", name: "foo" }]);
    const index = buildSearchIndex(graph, queryIndex);
    expect(fuzzyMatch("toString", index)).toEqual([]);
  });

  test("legitimate user symbol named `constructor` IS surfaced (not blocked by defense)", () => {
    const { graph, queryIndex } = makeFixture([
      { path: "src/class.ts", name: "constructor" },
    ]);
    const index = buildSearchIndex(graph, queryIndex);
    const matches = fuzzyMatch("constructor", index);
    expect(matches).toHaveLength(1);
    expect(matches[0]!.name).toBe("constructor");
  });
});
