/**
 * prompt-assembly.ts tests.
 */
import { test, expect, describe } from "bun:test";
import {
  EXPLAIN_SYSTEM_PROMPT,
  SNIPPET_MAX_BYTES,
  TOTAL_BUDGET_BYTES_DEFAULT,
  assemblePrompt,
  resolveCallsFromSource,
} from "../../src/explain/prompt-assembly";
import { buildSymbolTable } from "../../src/repo-graph/symbol-table";
import type {
  QueryIndex,
  RepoGraph,
  SiltpokeGraphNode,
} from "../../src/repo-graph/types";
import { buildSubgraph } from "../../src/repo-graph/subgraph";

function node(
  type: SiltpokeGraphNode["type"],
  path: string,
  name: string,
  start = 1,
  end = 10,
): SiltpokeGraphNode {
  return {
    id: `${type}:${path}:${name}`,
    type,
    name,
    path,
    lineRange: [start, end],
  };
}

function makeGraph(): { graph: RepoGraph; qi: QueryIndex } {
  const fileA = node("file", "src/a.ts", "a.ts", 1, 100);
  const fnFoo = node("function", "src/a.ts", "foo", 10, 30);
  const fnBar = node("function", "src/b.ts", "bar", 5, 20);
  const fnBaz = node("function", "src/c.ts", "baz", 1, 8);
  const graph: RepoGraph = {
    schemaVersion: 1,
    nodes: [fileA, fnFoo, fnBar, fnBaz],
    edges: [
      {
        id: `${fileA.id}::contains::${fnFoo.id}`,
        source: fileA.id,
        target: fnFoo.id,
        type: "contains",
        weight: 1,
      },
      {
        id: `${fileA.id}::imports::./b`,
        source: fileA.id,
        target: "./b",
        type: "imports",
        weight: 1,
      },
    ],
  };
  const qi: QueryIndex = {
    schemaVersion: 1,
    name_to_node_ids: {
      foo: [fnFoo.id],
      bar: [fnBar.id],
      baz: [fnBaz.id],
    },
    path_to_node_ids: {
      "src/a.ts": [fileA.id, fnFoo.id],
      "src/b.ts": [fnBar.id],
      "src/c.ts": [fnBaz.id],
    },
  };
  return { graph, qi };
}

describe("EXPLAIN_SYSTEM_PROMPT", () => {
  test("includes citation-format instruction", () => {
    expect(EXPLAIN_SYSTEM_PROMPT).toMatch(/\[file:line\]|file:line/i);
  });

  test("includes few-shot example block", () => {
    expect(EXPLAIN_SYSTEM_PROMPT).toMatch(/example|few-shot|sample/i);
  });

  test("under 4KB so it leaves room for the context bundle", () => {
    expect(Buffer.byteLength(EXPLAIN_SYSTEM_PROMPT, "utf8")).toBeLessThan(4096);
  });
});

describe("assemblePrompt — budget", () => {
  test("default total budget is 16KB", () => {
    expect(TOTAL_BUDGET_BYTES_DEFAULT).toBe(16 * 1024);
  });

  test("includes target source first", () => {
    const { graph, qi } = makeGraph();
    const st = buildSymbolTable(graph, qi);
    const targetId = "function:src/a.ts:foo";
    const sub = buildSubgraph(targetId, graph, 1);
    const sources = new Map<string, string>([
      ["src/a.ts", "function foo() {\n  return bar();\n}\n"],
      ["src/b.ts", "export function bar() {\n  return 1;\n}\n"],
    ]);
    const out = assemblePrompt({
      targetId,
      subgraph: sub,
      symbolTable: st,
      sources,
    });
    expect(out.contextBundle).toContain("foo");
    expect(out.contextBundle).toContain("src/a.ts");
    expect(out.includedSources).toContain("src/a.ts");
  });

  test("snippet truncation marker appears when source > SNIPPET_MAX_BYTES", () => {
    const big = "a".repeat(SNIPPET_MAX_BYTES + 50);
    const { graph, qi } = makeGraph();
    const st = buildSymbolTable(graph, qi);
    const targetId = "function:src/a.ts:foo";
    const sub = buildSubgraph(targetId, graph, 1);
    const sources = new Map<string, string>([
      ["src/a.ts", big],
    ]);
    const out = assemblePrompt({
      targetId,
      subgraph: sub,
      symbolTable: st,
      sources,
    });
    expect(out.contextBundle).toContain("truncated");
    expect(Buffer.byteLength(out.contextBundle, "utf8")).toBeLessThanOrEqual(
      TOTAL_BUDGET_BYTES_DEFAULT,
    );
  });

  test("hard total cap honored when bundle would otherwise exceed budget", () => {
    const big = "z".repeat(SNIPPET_MAX_BYTES * 2);
    const { graph, qi } = makeGraph();
    const st = buildSymbolTable(graph, qi);
    const targetId = "function:src/a.ts:foo";
    const sub = buildSubgraph(targetId, graph, 1);
    const sources = new Map<string, string>([
      ["src/a.ts", big],
    ]);
    const out = assemblePrompt({
      targetId,
      subgraph: sub,
      symbolTable: st,
      sources,
      budgetBytes: 256,
    });
    expect(Buffer.byteLength(out.contextBundle, "utf8")).toBeLessThanOrEqual(256);
    expect(out.truncated).toBe(true);
  });

  test("explicit budget override honored", () => {
    const { graph, qi } = makeGraph();
    const st = buildSymbolTable(graph, qi);
    const targetId = "function:src/a.ts:foo";
    const sub = buildSubgraph(targetId, graph, 1);
    const sources = new Map<string, string>([
      ["src/a.ts", "a".repeat(5000)],
    ]);
    const out = assemblePrompt({
      targetId,
      subgraph: sub,
      symbolTable: st,
      sources,
      budgetBytes: 1024,
    });
    expect(Buffer.byteLength(out.contextBundle, "utf8")).toBeLessThanOrEqual(1024);
  });
});

describe("assemblePrompt — citation hints", () => {
  test("target source block labeled with file path so Brain can cite", () => {
    const { graph, qi } = makeGraph();
    const st = buildSymbolTable(graph, qi);
    const targetId = "function:src/a.ts:foo";
    const sub = buildSubgraph(targetId, graph, 1);
    const sources = new Map<string, string>([
      ["src/a.ts", "function foo() {}\n"],
    ]);
    const out = assemblePrompt({
      targetId,
      subgraph: sub,
      symbolTable: st,
      sources,
    });
    // The bundle must include the path so the Brain knows how to cite.
    expect(out.contextBundle).toContain("src/a.ts");
  });
});

describe("resolveCallsFromSource", () => {
  test("identifies callees that appear in source AND in symbol table", () => {
    const { graph, qi } = makeGraph();
    const st = buildSymbolTable(graph, qi);
    const body =
      "export function foo() {\n  bar();\n  baz();\n  console.log('x');\n}\n";
    const out = resolveCallsFromSource(body, st, {
      excludeSelfName: "foo",
      cap: 50,
    });
    const names = out.map((c) => c.name).sort();
    expect(names).toEqual(["bar", "baz"]);
  });

  test("excludes the target's own identifier (no self-recursion noise)", () => {
    const { graph, qi } = makeGraph();
    const st = buildSymbolTable(graph, qi);
    const body = "function foo() { foo(); return bar(); }";
    const out = resolveCallsFromSource(body, st, {
      excludeSelfName: "foo",
      cap: 50,
    });
    expect(out.map((c) => c.name)).not.toContain("foo");
  });

  test("respects cap", () => {
    const { graph, qi } = makeGraph();
    const st = buildSymbolTable(graph, qi);
    const body = "function f() { bar(); baz(); }";
    const out = resolveCallsFromSource(body, st, {
      excludeSelfName: "f",
      cap: 1,
    });
    expect(out).toHaveLength(1);
  });

  test("returns empty when source is empty", () => {
    const { graph, qi } = makeGraph();
    const st = buildSymbolTable(graph, qi);
    const out = resolveCallsFromSource("", st, {
      excludeSelfName: "x",
      cap: 50,
    });
    expect(out).toHaveLength(0);
  });
});
