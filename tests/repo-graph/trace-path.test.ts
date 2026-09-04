/**
 * tracePath: depth-limited call path from an entry.
 *
 * Mirrors the trace.js contract: a greedy main-route spine, dimmed off-path
 * siblings, a real-named unresolvable tail, plus per-node shared/warn flags,
 * io from the signature, and purpose from the captured doc-comment. It NEVER
 * invents purpose text. Forks (branchOf) are intentionally deferred.
 */
import { test, expect, describe } from "bun:test";
import { tracePath } from "../../src/repo-graph/trace-path";
import { emptyGraph, emptyQueryIndex } from "../../src/repo-graph/types";
import type { RepoGraph, QueryIndex, SiltpokeGraphNode } from "../../src/repo-graph/types";

interface FnSpec {
  name: string;
  path?: string;
  line?: number;
  signature?: string;
  doc?: string;
}

class GraphBuilder {
  graph: RepoGraph = emptyGraph();
  queryIndex: QueryIndex = emptyQueryIndex();

  fn(spec: FnSpec): string {
    const path = spec.path ?? "src/a.ts";
    const node: SiltpokeGraphNode = {
      id: `function:${path}:${spec.name}`,
      type: "function",
      name: spec.name,
      path,
      lineRange: [spec.line ?? 1, (spec.line ?? 1) + 4],
      signature: spec.signature ?? `${spec.name}()`,
      ...(spec.doc ? { doc: spec.doc } : {}),
    };
    this.graph.nodes.push(node);
    this.queryIndex.name_to_node_ids[spec.name] ??= [];
    this.queryIndex.name_to_node_ids[spec.name].push(node.id);
    this.queryIndex.path_to_node_ids[path] ??= [];
    this.queryIndex.path_to_node_ids[path].push(node.id);
    return node.id;
  }

  call(callerName: string, calleeName: string, kind: "static" | "dynamic" = "static", weight = 1, callerPath = "src/a.ts") {
    const source = `function:${callerPath}:${callerName}`;
    this.graph.edges.push({
      id: `${source}::calls::${calleeName}`,
      source,
      target: calleeName,
      type: "calls",
      weight,
      call_kind: kind,
    });
    return this;
  }
}

describe("tracePath — spine", () => {
  test("linear resolved chain → ordered spine with entry role + resolved edges", () => {
    const b = new GraphBuilder();
    const a = b.fn({ name: "a", signature: "a(x): R", doc: "Root." });
    b.fn({ name: "bb" });
    b.fn({ name: "cc" });
    b.call("a", "bb").call("bb", "cc");

    const t = tracePath(b.graph, b.queryIndex, a, { depth: 6 });
    expect(t.spine).toEqual([
      "function:src/a.ts:a",
      "function:src/a.ts:bb",
      "function:src/a.ts:cc",
    ]);
    const entry = t.nodes.find((n) => n.id === a);
    expect(entry?.role).toBe("entry");
    expect(entry?.io).toEqual({ input: "x", output: "R" });
    expect(entry?.purpose).toEqual({ src: "jsdoc", text: "Root." });
    const spineEdges = t.edges.filter((e) => e.klass === "resolved");
    expect(spineEdges).toHaveLength(2);
  });

  test("respects the depth limit (depth=2 → 3 nodes)", () => {
    const b = new GraphBuilder();
    const a = b.fn({ name: "a" });
    for (const n of ["b", "c", "d", "e"]) b.fn({ name: n });
    b.call("a", "b").call("b", "c").call("c", "d").call("d", "e");
    const t = tracePath(b.graph, b.queryIndex, a, { depth: 2 });
    expect(t.spine).toHaveLength(3);
  });

  test("picks the child with more onward reach as the spine successor; other → off (dim)", () => {
    const b = new GraphBuilder();
    const a = b.fn({ name: "a" });
    b.fn({ name: "deep" });
    b.fn({ name: "shallow" });
    b.fn({ name: "deeper" });
    // deep has an onward call; shallow does not → spine follows deep
    b.call("a", "deep").call("a", "shallow").call("deep", "deeper");
    const t = tracePath(b.graph, b.queryIndex, a, { depth: 6 });
    expect(t.spine).toEqual([
      "function:src/a.ts:a",
      "function:src/a.ts:deep",
      "function:src/a.ts:deeper",
    ]);
    const shallow = t.nodes.find((n) => n.fn === "shallow");
    expect(shallow?.off).toBe("function:src/a.ts:a");
    expect(t.edges.some((e) => e.to === shallow?.id && e.klass === "dim")).toBe(true);
  });

  test("cycle does not loop forever", () => {
    const b = new GraphBuilder();
    const a = b.fn({ name: "a" });
    b.fn({ name: "b" });
    b.call("a", "b").call("b", "a");
    const t = tracePath(b.graph, b.queryIndex, a, { depth: 6 });
    expect(t.spine).toEqual(["function:src/a.ts:a", "function:src/a.ts:b"]);
  });
});

describe("tracePath — confidence + flags", () => {
  test("named-but-unindexed call → warn on parent + real-named unresolvable tail", () => {
    const b = new GraphBuilder();
    const a = b.fn({ name: "a" });
    b.fn({ name: "b" });
    b.call("a", "b").call("b", "writeFileSync"); // writeFileSync has no node → unresolved
    const t = tracePath(b.graph, b.queryIndex, a, { depth: 6 });
    const parent = t.nodes.find((n) => n.fn === "b");
    expect(parent?.warn).toBe(true);
    const tail = t.nodes.find((n) => n.fn === "writeFileSync");
    expect(tail?.klass).toBe("unresolvable");
    expect(tail?.tailOf).toBe("function:src/a.ts:b");
    expect(tail?.purpose).toEqual({ src: "unresolvable" });
    expect(t.edges.some((e) => e.to === tail?.id && e.klass === "unresolved")).toBe(true);
  });

  test("dynamic-only dispatch → NO warn, no fabricated node (tightened M4)", () => {
    const b = new GraphBuilder();
    const a = b.fn({ name: "a" });
    b.fn({ name: "b" });
    b.call("a", "b").call("b", "", "dynamic");
    const t = tracePath(b.graph, b.queryIndex, a, { depth: 6 });
    // A pure dynamic call draws no edge → no "may continue" badge (that flagged
    // nearly every node). warn only marks a node with a DRAWN unresolved tail.
    expect(t.nodes.find((n) => n.fn === "b")?.warn).toBeUndefined();
    // and still no synthetic node with an empty/invented name
    expect(t.nodes.every((n) => n.fn !== "" && n.fn !== "(dynamic)")).toBe(true);
  });

  test("shared:true when a node is reachable from >1 entrypoint", () => {
    const b = new GraphBuilder();
    const a = b.fn({ name: "a" });
    const x = b.fn({ name: "x" });
    b.fn({ name: "common" });
    b.call("a", "common").call("x", "common");
    const t = tracePath(b.graph, b.queryIndex, a, { depth: 6, entrypointIds: [a, x] });
    expect(t.nodes.find((n) => n.fn === "common")?.shared).toBe(true);
  });

  test("purpose is none (never invented) when the node has no doc-comment", () => {
    const b = new GraphBuilder();
    const a = b.fn({ name: "a" }); // no doc
    const t = tracePath(b.graph, b.queryIndex, a, { depth: 6 });
    expect(t.nodes.find((n) => n.id === a)?.purpose).toEqual({ src: "none" });
  });

  test("trace node carries the graph node type (file root renders as file)", () => {
    const b = new GraphBuilder();
    const fileId = "file:src/entry.ts:";
    b.graph.nodes.push({
      id: fileId,
      type: "file",
      name: "entry.ts",
      path: "src/entry.ts",
      lineRange: [1, 1],
    });
    b.queryIndex.path_to_node_ids["src/entry.ts"] ??= [];
    b.queryIndex.path_to_node_ids["src/entry.ts"].push(fileId);
    b.fn({ name: "helper", path: "src/entry.ts" });
    b.graph.edges.push({
      id: `${fileId}::calls::helper`,
      source: fileId,
      target: "helper",
      type: "calls",
      weight: 1,
      call_kind: "static",
    });
    const t = tracePath(b.graph, b.queryIndex, fileId, { depth: 4, entrypointIds: [fileId] });
    expect(t.nodes.find((n) => n.id === fileId)?.type).toBe("file");
    expect(t.nodes.find((n) => n.fn === "helper")?.type).toBe("function");
  });

  // Off-path siblings carry a fan-in `weight` (global resolved in-degree) so
  // the renderer can rank + cap the dimmed left column by how widely-called each
  // is — the most-called are the most relevant context to keep visible.
  test("off-path nodes carry a fan-in weight = global resolved in-degree", () => {
    const b = new GraphBuilder();
    const a = b.fn({ name: "a" });
    b.fn({ name: "x" }); // a second caller, to push popular's in-degree to 2
    b.fn({ name: "deep" });
    b.fn({ name: "deeper" });
    b.fn({ name: "popular" }); // off-path sibling, called by both a and x
    b.fn({ name: "lonely" }); // off-path sibling, called by a only
    // spine follows deep (has onward reach); popular + lonely fall off-path.
    b.call("a", "deep").call("deep", "deeper");
    b.call("a", "popular").call("x", "popular").call("a", "lonely");
    const t = tracePath(b.graph, b.queryIndex, a, { depth: 6 });
    const popular = t.nodes.find((n) => n.fn === "popular");
    const lonely = t.nodes.find((n) => n.fn === "lonely");
    expect(popular?.off).toBe(a);
    expect(lonely?.off).toBe(a);
    expect(popular?.weight).toBe(2); // called by a + x
    expect(lonely?.weight).toBe(1); // called by a only
    // and the more-called sibling outranks the less-called one
    expect((popular?.weight ?? 0) > (lonely?.weight ?? 0)).toBe(true);
  });
});
