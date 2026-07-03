/**
 * symbol-table.ts tests.
 */
import { test, expect, describe } from "bun:test";
import {
  buildSymbolTable,
  type SymbolTable,
} from "../../src/repo-graph/symbol-table";
import {
  emptyGraph,
  emptyQueryIndex,
  type RepoGraph,
  type QueryIndex,
} from "../../src/repo-graph/types";

function nodeOf(
  type: "file" | "function" | "class" | "symbol" | "module",
  relPath: string,
  name: string,
  startLine = 1,
  endLine = 10,
) {
  const id = `${type}:${relPath}:${name}`;
  return {
    id,
    type,
    name,
    path: relPath,
    lineRange: [startLine, endLine] as [number, number],
  };
}

describe("buildSymbolTable", () => {
  test("empty graph + queryIndex → empty table", () => {
    const table = buildSymbolTable(emptyGraph(), emptyQueryIndex());
    expect(table.name_to_candidates.size).toBe(0);
    expect(table.path_to_node_ids.size).toBe(0);
  });

  test("single function indexed under its name with file:line preview", () => {
    const graph: RepoGraph = {
      schemaVersion: 1,
      nodes: [nodeOf("function", "src/cli/doctor.ts", "runDoctor", 42, 87)],
      edges: [],
    };
    const qi: QueryIndex = {
      schemaVersion: 1,
      name_to_node_ids: {
        runDoctor: ["function:src/cli/doctor.ts:runDoctor"],
      },
      path_to_node_ids: {
        "src/cli/doctor.ts": ["function:src/cli/doctor.ts:runDoctor"],
      },
    };
    const table = buildSymbolTable(graph, qi);

    const matches = table.name_to_candidates.get("runDoctor") ?? [];
    expect(matches).toHaveLength(1);
    expect(matches[0]).toEqual({
      nodeId: "function:src/cli/doctor.ts:runDoctor",
      type: "function",
      path: "src/cli/doctor.ts",
      lineRange: [42, 87],
      name: "runDoctor",
    });
    expect(table.path_to_node_ids.get("src/cli/doctor.ts")).toEqual([
      "function:src/cli/doctor.ts:runDoctor",
    ]);
  });

  test("multi-match name returns all candidates ordered as in queryIndex", () => {
    const graph: RepoGraph = {
      schemaVersion: 1,
      nodes: [
        nodeOf("function", "src/state/critic-event-log-parse.ts", "parse", 18, 80),
        nodeOf("function", "src/brain/schema.ts", "parse", 24, 56),
        nodeOf("function", "src/repo-graph/extractor.ts", "parse", 67, 90),
      ],
      edges: [],
    };
    const qi: QueryIndex = {
      schemaVersion: 1,
      name_to_node_ids: {
        parse: [
          "function:src/state/critic-event-log-parse.ts:parse",
          "function:src/brain/schema.ts:parse",
          "function:src/repo-graph/extractor.ts:parse",
        ],
      },
      path_to_node_ids: {},
    };
    const table = buildSymbolTable(graph, qi);

    const matches = table.name_to_candidates.get("parse") ?? [];
    expect(matches).toHaveLength(3);
    expect(matches.map((m) => m.path)).toEqual([
      "src/state/critic-event-log-parse.ts",
      "src/brain/schema.ts",
      "src/repo-graph/extractor.ts",
    ]);
  });

  test("queryIndex entry pointing to missing graph node is skipped, no crash", () => {
    const graph: RepoGraph = {
      schemaVersion: 1,
      nodes: [nodeOf("function", "src/x.ts", "foo")],
      edges: [],
    };
    const qi: QueryIndex = {
      schemaVersion: 1,
      name_to_node_ids: {
        foo: ["function:src/x.ts:foo", "function:src/missing.ts:foo"],
      },
      path_to_node_ids: {},
    };
    const table = buildSymbolTable(graph, qi);

    const matches = table.name_to_candidates.get("foo") ?? [];
    expect(matches).toHaveLength(1);
    expect(matches[0].path).toBe("src/x.ts");
  });

  test("case-sensitive lookup (does not lowercase keys)", () => {
    const graph: RepoGraph = {
      schemaVersion: 1,
      nodes: [
        nodeOf("class", "src/components/Foo.tsx", "Foo"),
        nodeOf("function", "src/util.ts", "foo"),
      ],
      edges: [],
    };
    const qi: QueryIndex = {
      schemaVersion: 1,
      name_to_node_ids: {
        Foo: ["class:src/components/Foo.tsx:Foo"],
        foo: ["function:src/util.ts:foo"],
      },
      path_to_node_ids: {},
    };
    const table = buildSymbolTable(graph, qi);

    expect(table.name_to_candidates.get("Foo")).toHaveLength(1);
    expect(table.name_to_candidates.get("foo")).toHaveLength(1);
    expect(table.name_to_candidates.get("FOO")).toBeUndefined();
  });

  test("prototype-pollution-safe — name 'constructor' or 'toString' do not collide with Object.prototype", () => {
    const graph: RepoGraph = {
      schemaVersion: 1,
      nodes: [
        nodeOf("function", "src/x.ts", "constructor"),
        nodeOf("function", "src/y.ts", "toString"),
      ],
      edges: [],
    };
    const qi: QueryIndex = {
      schemaVersion: 1,
      name_to_node_ids: {
        constructor: ["function:src/x.ts:constructor"],
        toString: ["function:src/y.ts:toString"],
      },
      path_to_node_ids: {},
    };
    const table = buildSymbolTable(graph, qi);

    expect(table.name_to_candidates.get("constructor")).toHaveLength(1);
    expect(table.name_to_candidates.get("toString")).toHaveLength(1);
    expect(table.name_to_candidates.get("hasOwnProperty")).toBeUndefined();
  });

  test("listAllNames returns sorted unique names for Levenshtein fallback", () => {
    const graph: RepoGraph = {
      schemaVersion: 1,
      nodes: [
        nodeOf("function", "src/a.ts", "alpha"),
        nodeOf("function", "src/b.ts", "beta"),
        nodeOf("class", "src/c.ts", "Charlie"),
      ],
      edges: [],
    };
    const qi: QueryIndex = {
      schemaVersion: 1,
      name_to_node_ids: {
        alpha: ["function:src/a.ts:alpha"],
        beta: ["function:src/b.ts:beta"],
        Charlie: ["class:src/c.ts:Charlie"],
      },
      path_to_node_ids: {},
    };
    const table = buildSymbolTable(graph, qi);

    expect(table.listAllNames()).toEqual(["Charlie", "alpha", "beta"]);
  });
});
