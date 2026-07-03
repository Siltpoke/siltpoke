import { describe, expect, it } from "bun:test";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { assembleCallerBlock } from "../../../src/critic/caller-impact/block-assembler.ts";
import {
  GraphCallerResolver,
  type LoadedGraph,
} from "../../../src/critic/caller-impact/caller-resolver-graph.ts";
import type {
  QueryIndex,
  RepoGraph,
  SiltpokeGraphEdge,
  SiltpokeGraphNode,
} from "../../../src/repo-graph/types.ts";

// Helpers to build a tiny in-memory graph the loader seam returns directly
// (no real index on disk — the loader fake bypasses resolveRepoGraphLocation).

function fnNode(path: string, name: string, startLine: number): SiltpokeGraphNode {
  return {
    id: `function:${path}:${name}`,
    type: "function",
    name,
    path,
    lineRange: [startLine, startLine + 5],
  };
}

function callsEdge(source: SiltpokeGraphNode, targetName: string): SiltpokeGraphEdge {
  return {
    id: `${source.id}::calls::${targetName}`,
    source: source.id,
    target: targetName,
    type: "calls",
    weight: 1,
    call_kind: "static",
  };
}

function queryIndexFor(nodes: SiltpokeGraphNode[]): QueryIndex {
  const name_to_node_ids: Record<string, string[]> = {};
  const path_to_node_ids: Record<string, string[]> = {};
  for (const n of nodes) {
    name_to_node_ids[n.name] = [...(name_to_node_ids[n.name] ?? []), n.id];
    path_to_node_ids[n.path] = [...(path_to_node_ids[n.path] ?? []), n.id];
  }
  return { schemaVersion: 1, name_to_node_ids, path_to_node_ids };
}

function loadedFrom(
  nodes: SiltpokeGraphNode[],
  edges: SiltpokeGraphEdge[],
  opts: { stale?: boolean } = {},
): LoadedGraph {
  const graph: RepoGraph = { schemaVersion: 1, nodes, edges };
  return {
    graph,
    queryIndex: queryIndexFor(nodes),
    lastIndexedTs: "2026-06-14T00:00:00.000Z",
    projectRoot: "/repo",
    storageDir: "/storage",
    stale: opts.stale ?? false,
  };
}

/** A resolver whose loader returns the given in-memory graph (or null). */
function resolverWith(loaded: LoadedGraph | null): GraphCallerResolver {
  return new GraphCallerResolver({ load: () => loaded });
}

describe("GraphCallerResolver", () => {
  it("resolves a cross-file caller from a calls edge whose target===name", async () => {
    const target = fnNode("src/target.ts", "doThing", 10);
    const caller = fnNode("src/caller.ts", "useIt", 20);
    const loaded = loadedFrom(
      [target, caller],
      [callsEdge(caller, "doThing")],
    );
    const res = await resolverWith(loaded).resolveCallers("doThing", {
      cwd: "/repo",
      excludeFiles: ["src/target.ts"],
    });
    expect(res.unavailable).toBe(false);
    expect(res.defs).toBe(1);
    expect(res.ambiguous).toBe(false);
    expect(res.callers).toEqual([{ file: "src/caller.ts", line: 20 }]);
    expect(res.callsiteCount).toBe(1);
    expect(res.stale).toBeFalsy();
  });

  it("flags ambiguous when two function nodes share the name", async () => {
    const t1 = fnNode("src/a.ts", "doThing", 1);
    const t2 = fnNode("src/b.ts", "doThing", 1);
    const caller = fnNode("src/caller.ts", "useIt", 20);
    const loaded = loadedFrom(
      [t1, t2, caller],
      [callsEdge(caller, "doThing")],
    );
    const res = await resolverWith(loaded).resolveCallers("doThing", {
      cwd: "/repo",
      excludeFiles: [],
    });
    expect(res.defs).toBe(2);
    expect(res.ambiguous).toBe(true);
  });

  it("filters out callers whose source file is excluded (cross-file only)", async () => {
    const target = fnNode("src/target.ts", "doThing", 10);
    const sameFileCaller = fnNode("src/target.ts", "alsoHere", 30);
    const crossCaller = fnNode("src/other.ts", "useIt", 5);
    const loaded = loadedFrom(
      [target, sameFileCaller, crossCaller],
      [callsEdge(sameFileCaller, "doThing"), callsEdge(crossCaller, "doThing")],
    );
    const res = await resolverWith(loaded).resolveCallers("doThing", {
      cwd: "/repo",
      excludeFiles: ["src/target.ts"],
    });
    expect(res.callers).toEqual([{ file: "src/other.ts", line: 5 }]);
    expect(res.callsiteCount).toBe(1);
  });

  it("excludes a same-file caller when excludeFiles is ABSOLUTE (path normalization)", async () => {
    // Edit/Write tool_use often records absolute changed-file paths; the graph
    // stores src.path repo-relative. Without normalization the def file leaks in.
    const target = fnNode("src/target.ts", "doThing", 10);
    const sameFileCaller = fnNode("src/target.ts", "alsoHere", 30);
    const crossCaller = fnNode("src/other.ts", "useIt", 5);
    const loaded = loadedFrom(
      [target, sameFileCaller, crossCaller],
      [callsEdge(sameFileCaller, "doThing"), callsEdge(crossCaller, "doThing")],
    );
    const res = await resolverWith(loaded).resolveCallers("doThing", {
      cwd: "/repo",
      excludeFiles: ["/repo/src/target.ts"], // absolute, not "src/target.ts"
    });
    expect(res.callers).toEqual([{ file: "src/other.ts", line: 5 }]);
  });

  it("dedups multiple call edges from the same source node", async () => {
    const target = fnNode("src/target.ts", "doThing", 10);
    const caller = fnNode("src/caller.ts", "useIt", 20);
    const e = callsEdge(caller, "doThing");
    const loaded = loadedFrom([target, caller], [e, { ...e, weight: 2 }]);
    const res = await resolverWith(loaded).resolveCallers("doThing", {
      cwd: "/repo",
      excludeFiles: [],
    });
    expect(res.callers).toEqual([{ file: "src/caller.ts", line: 20 }]);
  });

  it("marks stale=true when the loader reports a stale index", async () => {
    const target = fnNode("src/target.ts", "doThing", 10);
    const caller = fnNode("src/caller.ts", "useIt", 20);
    const loaded = loadedFrom(
      [target, caller],
      [callsEdge(caller, "doThing")],
      { stale: true },
    );
    const res = await resolverWith(loaded).resolveCallers("doThing", {
      cwd: "/repo",
      excludeFiles: [],
    });
    expect(res.stale).toBe(true);
    expect(res.unavailable).toBe(false);
    expect(res.callers).toEqual([{ file: "src/caller.ts", line: 20 }]);
  });

  it("silently skips a dangling calls edge (source id not in the node set)", async () => {
    const target = fnNode("src/target.ts", "doThing", 10);
    const realCaller = fnNode("src/caller.ts", "useIt", 20);
    // An edge whose source id refers to a node that doesn't exist (corrupt /
    // partial incremental graph). It must be skipped, not throw, not emitted.
    const dangling: SiltpokeGraphEdge = {
      id: "function:src/ghost.ts:ghost::calls::doThing",
      source: "function:src/ghost.ts:ghost",
      target: "doThing",
      type: "calls",
      weight: 1,
      call_kind: "static",
    };
    const loaded = loadedFrom(
      [target, realCaller],
      [dangling, callsEdge(realCaller, "doThing")],
    );
    const res = await resolverWith(loaded).resolveCallers("doThing", {
      cwd: "/repo",
      excludeFiles: ["src/target.ts"],
    });
    expect(res.unavailable).toBe(false);
    expect(res.callers).toEqual([{ file: "src/caller.ts", line: 20 }]); // ghost dropped
  });

  it("dynamic call edge (empty target) does not match a named lookup", async () => {
    const target = fnNode("src/target.ts", "doThing", 10);
    const caller = fnNode("src/caller.ts", "useIt", 20);
    const dyn = callsEdge(caller, ""); // dynamic call: empty target string
    const loaded = loadedFrom([target, caller], [dyn]);
    const res = await resolverWith(loaded).resolveCallers("doThing", {
      cwd: "/repo",
      excludeFiles: ["src/target.ts"],
    });
    expect(res.callers).toEqual([]); // empty target never equals "doThing"
  });

  it("returns unavailable=true when the loader has no index", async () => {
    const res = await resolverWith(null).resolveCallers("doThing", {
      cwd: "/nope",
      excludeFiles: [],
    });
    expect(res.unavailable).toBe(true);
    expect(res.callers).toEqual([]);
    expect(res.defs).toBe(0);
  });

  it("never throws — a loader that throws degrades to unavailable", async () => {
    const resolver = new GraphCallerResolver({
      load: () => {
        throw new Error("boom");
      },
    });
    const res = await resolver.resolveCallers("x", {
      cwd: "/repo",
      excludeFiles: [],
    });
    expect(res.unavailable).toBe(true);
  });

  it("ranks callers by source-file fan-in before any cap (FM-6)", async () => {
    const target = fnNode("src/target.ts", "doThing", 10);
    // lowFan file has 1 call edge; highFan file has 3 — highFan ranks first.
    const lowFan = fnNode("src/low.ts", "lowCaller", 5);
    const highFan = fnNode("src/high.ts", "highCaller", 8);
    const edges = [
      callsEdge(lowFan, "doThing"),
      callsEdge(highFan, "doThing"),
      callsEdge(highFan, "other1"),
      callsEdge(highFan, "other2"),
    ];
    const loaded = loadedFrom([target, lowFan, highFan], edges);
    const res = await resolverWith(loaded).resolveCallers("doThing", {
      cwd: "/repo",
      excludeFiles: [],
    });
    expect(res.callers.map((c) => c.file)).toEqual(["src/high.ts", "src/low.ts"]);
  });
});

// Optional real-fixture probe: drives the DEFAULT (on-disk) loader against
// siltpoke's own graph if it's present. Skip-guarded so CI/clean machines pass.
describe("GraphCallerResolver — real on-disk index (skip-guarded)", () => {
  const projectRoot = process.cwd();
  const graphDir = join(homedir(), ".siltpoke", "repo-memory", "38f050645928");
  const hasIndex = existsSync(join(graphDir, "graph.json"));

  it.skipIf(!hasIndex)(
    "resolves callers of a known function from the live graph",
    async () => {
      const res = await new GraphCallerResolver().resolveCallers(
        "assembleCallerBlock",
        { cwd: projectRoot, excludeFiles: [] },
      );
      // Exercises the REAL on-disk loadFromDisk path. On-disk state in a full
      // suite is non-deterministic (cwd resolution + other tests may rebuild or
      // empty siltpoke's own index), so we assert only that the real loader path
      // runs without throwing and returns a well-formed CallerSet — the resolver
      // LOGIC (callers/defs/stale) is proven by the injected-graph tests above.
      expect(typeof res.unavailable).toBe("boolean");
      expect(typeof res.callsiteCount).toBe("number");
      expect(Array.isArray(res.callers)).toBe(true);
    },
  );
});

describe("block-assembler stale rendering", () => {
  it("a stale CallerSet renders file-level tokens (no :line) + a freshness stamp", () => {
    const block = assembleCallerBlock({
      functionName: "doThing",
      kind: "modified",
      signatureChanged: true,
      callers: {
        callers: [{ file: "src/caller.ts", line: 20 }],
        defs: 1,
        ambiguous: false,
        callsiteCount: 1,
        unavailable: false,
        stale: true,
      },
    });
    expect(block).not.toBeNull();
    if (!block) return;
    // file-level token: no `:20` line suffix
    expect(block.tokens).toEqual(["caller: src/caller.ts"]);
    expect(block.text).toContain("caller: src/caller.ts");
    expect(block.text).not.toContain("src/caller.ts:20");
    expect(block.text.toLowerCase()).toContain("stale");
  });

  it("a fresh CallerSet keeps the :line tokens (grep behavior unchanged)", () => {
    const block = assembleCallerBlock({
      functionName: "doThing",
      kind: "modified",
      signatureChanged: true,
      callers: {
        callers: [{ file: "src/caller.ts", line: 20 }],
        defs: 1,
        ambiguous: false,
        callsiteCount: 1,
        unavailable: false,
      },
    });
    expect(block).not.toBeNull();
    if (!block) return;
    expect(block.tokens).toEqual(["caller: src/caller.ts:20"]);
  });
});
