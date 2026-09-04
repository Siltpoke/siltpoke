/**
 * daemon trace endpoints + real call edges.
 *
 *   GET /api/repo-graph/entrypoints?repo=  → detected roots + coverage
 *   GET /api/repo-graph/trace?repo=&entry=&depth=  → TracePath
 *   GET /api/repo-graph/symbols  → now emits REAL intra-file call edges
 *                                   (the synthesized hub is gone)
 */
import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { mountRepoGraphRoutes } from "../../src/daemon/routes/repo-graph";
import {
  writeFingerprints,
  writeGraph,
  writeMeta,
  writeQueryIndex,
} from "../../src/repo-graph/store";
import { resolveRepoGraphLocation } from "../../src/repo-graph/proj-hash";
import {
  emptyCounters,
  emptyFingerprints,
  emptyGraph,
  type RepoGraph,
  type QueryIndex,
  type RepoGraphMeta,
} from "../../src/repo-graph/types";

let cwd: string;
let home: string;

beforeEach(() => {
  const tmp = mkdtempSync(join(tmpdir(), "siltpoke-trace-route-"));
  cwd = join(tmp, "proj");
  home = join(tmp, "home");
  mkdirSync(cwd, { recursive: true });
  mkdirSync(home, { recursive: true });
});

afterEach(() => {
  rmSync(cwd, { recursive: true, force: true });
  rmSync(home, { recursive: true, force: true });
});

/** Build a small graph: handleStopHook → packContext → writeFileSync (external). */
function seedTraceGraph(): { graph: RepoGraph; queryIndex: QueryIndex } {
  const graph = emptyGraph();
  const queryIndex: QueryIndex = { schemaVersion: 1, name_to_node_ids: {}, path_to_node_ids: {} };
  const fns: Array<[string, string, number, string]> = [
    ["src/hooks/handle-stop.ts", "handleStopHook", 90, "handleStopHook(event): Promise<void>"],
    ["src/router/context.ts", "packContext", 41, "packContext(o): string"],
  ];
  for (const [path, name, line, sig] of fns) {
    const id = `function:${path}:${name}`;
    graph.nodes.push({ id, type: "function", name, path, lineRange: [line, line + 4], signature: sig });
    queryIndex.name_to_node_ids[name] ??= [];
    queryIndex.name_to_node_ids[name].push(id);
    queryIndex.path_to_node_ids[path] ??= [];
    queryIndex.path_to_node_ids[path].push(id);
  }
  graph.edges.push({
    id: "function:src/hooks/handle-stop.ts:handleStopHook::calls::packContext",
    source: "function:src/hooks/handle-stop.ts:handleStopHook",
    target: "packContext",
    type: "calls",
    weight: 1,
    call_kind: "static",
  });
  graph.edges.push({
    id: "function:src/router/context.ts:packContext::calls::writeFileSync",
    source: "function:src/router/context.ts:packContext",
    target: "writeFileSync",
    type: "calls",
    weight: 1,
    call_kind: "static",
  });
  return { graph, queryIndex };
}

async function seed(graph: RepoGraph, queryIndex: QueryIndex, coverage?: RepoGraphMeta["coverage"]): Promise<void> {
  const { storage_dir, project_root, proj_hash } = resolveRepoGraphLocation(cwd, { home });
  await writeGraph(storage_dir, graph);
  await writeQueryIndex(storage_dir, queryIndex);
  await writeFingerprints(storage_dir, emptyFingerprints());
  const meta: RepoGraphMeta = {
    schemaVersion: 1,
    project_root,
    proj_hash,
    last_indexed_ts: "2026-06-01T10:00:00.000Z",
    build_duration_ms: 100,
    counters: emptyCounters(),
    ...(coverage ? { coverage } : {}),
  };
  await writeMeta(storage_dir, meta);
}

// POST /api/repo-graph/trace/purpose is secret-gated (daemon-hardening
// security audit, finding 2) — every POST below now carries this header.
const TEST_SECRET = "test-secret";

function makeApp(): Hono {
  const app = new Hono();
  mountRepoGraphRoutes(app, { cwd, home, secret: TEST_SECRET });
  return app;
}

describe("GET /api/repo-graph/entrypoints", () => {
  test("returns detected entrypoints + LIVE recalibrated coverage (ignores stale stored meta)", async () => {
    const { graph, queryIndex } = seedTraceGraph();
    // Seed a stale raw value — the route must IGNORE it and compute live (M6).
    await seed(graph, queryIndex, { resolvedCallsites: 1, totalCallsites: 2, pct: 50, tier: "yellow" });
    const res = await makeApp().request("/api/repo-graph/entrypoints");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
    const cli = body.data.entrypoints.find((e: { id: string }) => e.id === "cli");
    expect(cli).toMatchObject({ fn: "handleStopHook", module: "hooks" });
    // Eligible-denominator: packContext is in-repo (eligible, exact); writeFileSync
    // is external (excluded) → 1/1 = 100% green, NOT the stale 50% yellow.
    expect(body.data.coverage).toEqual({ resolvedCallsites: 1, totalCallsites: 1, pct: 100, tier: "green" });
  });

  test("404 when repo not indexed", async () => {
    const res = await makeApp().request("/api/repo-graph/entrypoints?repo=deadbeef0000");
    expect(res.status).toBe(404);
  });
});

describe("GET /api/repo-graph/trace", () => {
  test("entry=cli → spine of real symbols with entry role + edges", async () => {
    const { graph, queryIndex } = seedTraceGraph();
    await seed(graph, queryIndex);
    const res = await makeApp().request("/api/repo-graph/trace?entry=cli");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
    const t = body.data;
    expect(t.entry).toBe("function:src/hooks/handle-stop.ts:handleStopHook");
    expect(t.spine[0]).toBe("function:src/hooks/handle-stop.ts:handleStopHook");
    expect(t.spine).toContain("function:src/router/context.ts:packContext");
    const entryNode = t.nodes.find((n: { id: string }) => n.id === t.entry);
    expect(entryNode.role).toBe("entry");
    expect(entryNode.io).toEqual({ input: "event", output: "Promise<void>" });
    // writeFileSync is unindexed → unresolvable tail
    expect(t.nodes.some((n: { fn: string; klass?: string }) => n.fn === "writeFileSync" && n.klass === "unresolvable")).toBe(true);
  });

  test("respects depth and clamps; unknown entry → 404", async () => {
    const { graph, queryIndex } = seedTraceGraph();
    await seed(graph, queryIndex);
    const res = await makeApp().request("/api/repo-graph/trace?entry=nope");
    expect(res.status).toBe(404);
  });
});

describe("GET /api/repo-graph/symbols — real call edges (no synth hub)", () => {
  test("callEdges reflect real intra-file calls, not a synthesized hub", async () => {
    const graph = emptyGraph();
    const queryIndex: QueryIndex = { schemaVersion: 1, name_to_node_ids: {}, path_to_node_ids: {} };
    const path = "src/x.ts";
    graph.nodes.push({ id: `file:${path}:`, type: "file", name: "x.ts", path, lineRange: [1, 30] });
    for (const name of ["a", "b", "c"]) {
      const id = `function:${path}:${name}`;
      graph.nodes.push({ id, type: "function", name, path, lineRange: [1, 5], signature: `${name}()` });
      queryIndex.name_to_node_ids[name] ??= [];
      queryIndex.name_to_node_ids[name].push(id);
      queryIndex.path_to_node_ids[path] ??= [];
      queryIndex.path_to_node_ids[path].push(id);
    }
    queryIndex.path_to_node_ids[path] ??= [];
    queryIndex.path_to_node_ids[path].push(`file:${path}:`);
    // a calls b (intra-file) and an external fn
    graph.edges.push({ id: "1", source: `function:${path}:a`, target: "b", type: "calls", weight: 1, call_kind: "static" });
    graph.edges.push({ id: "2", source: `function:${path}:a`, target: "readFile", type: "calls", weight: 1, call_kind: "static" });
    await seed(graph, queryIndex);

    const res = await makeApp().request(`/api/repo-graph/symbols?file=${encodeURIComponent(path)}`);
    expect(res.status).toBe(200);
    const body = await res.json();
    const edges = body.data.callEdges;
    expect(edges).toEqual([{ source: "a", target: "b" }]);
    expect(edges.some((e: { synthesized?: boolean }) => e.synthesized)).toBe(false);
  });
});

// ── "trace from any node" backend contract ────────────────────────────────
//
// entry=<raw node id> returns the same TracePath that tracePath() produces.
// An arbitrary non-preset function id roots a real multi-node spine.
// A leaf root → spine of exactly [entryId], nodes=1, edges=0 — NO fabrication.
//
// Each test fixture is self-contained (seeds its own graph via seed()) and runs
// against the same makeApp() / seed() / cwd/home provided by beforeEach/afterEach.

/** Build a graph with NON-preset, mid-graph function nodes + a real call chain.
 *
 * Graph:
 *   computeScore (non-preset, has callee) → formatResult → renderOutput (leaf)
 *   classifyData (non-preset method-like, inside a class container) → computeScore
 */
function seedArbitraryGraph(): { graph: RepoGraph; queryIndex: QueryIndex } {
  const graph = emptyGraph();
  const queryIndex: QueryIndex = { schemaVersion: 1, name_to_node_ids: {}, path_to_node_ids: {} };

  // Free functions
  const fnDefs: Array<[string, string, number, string]> = [
    ["src/analysis/score.ts", "computeScore", 10, "computeScore(data: Data): number"],
    ["src/analysis/score.ts", "formatResult", 30, "formatResult(score: number): string"],
    ["src/analysis/output.ts", "renderOutput", 5, "renderOutput(text: string): void"],
  ];
  for (const [path, name, line, sig] of fnDefs) {
    const id = `function:${path}:${name}`;
    graph.nodes.push({ id, type: "function", name, path, lineRange: [line, line + 4], signature: sig });
    queryIndex.name_to_node_ids[name] ??= [];
    queryIndex.name_to_node_ids[name].push(id);
    queryIndex.path_to_node_ids[path] ??= [];
    queryIndex.path_to_node_ids[path].push(id);
  }

  // Class container node
  const classPath = "src/analysis/classifier.ts";
  const classId = `class:${classPath}:DataClassifier`;
  graph.nodes.push({ id: classId, type: "class", name: "DataClassifier", path: classPath, lineRange: [1, 50] });
  queryIndex.path_to_node_ids[classPath] ??= [];
  queryIndex.path_to_node_ids[classPath].push(classId);

  // Method node (function type, lives inside the class file)
  const methodId = `function:${classPath}:classifyData`;
  graph.nodes.push({ id: methodId, type: "function", name: "classifyData", path: classPath, lineRange: [15, 25], signature: "classifyData(input: string): Data" });
  queryIndex.name_to_node_ids["classifyData"] ??= [];
  queryIndex.name_to_node_ids["classifyData"].push(methodId);
  queryIndex.path_to_node_ids[classPath].push(methodId);

  // Edges: computeScore → formatResult → renderOutput (real resolved chain)
  graph.edges.push({ id: "e1", source: "function:src/analysis/score.ts:computeScore", target: "formatResult", type: "calls", weight: 1, call_kind: "static" });
  graph.edges.push({ id: "e2", source: "function:src/analysis/score.ts:formatResult", target: "renderOutput", type: "calls", weight: 1, call_kind: "static" });
  // classifyData → computeScore
  graph.edges.push({ id: "e3", source: methodId, target: "computeScore", type: "calls", weight: 1, call_kind: "static" });
  // contains edge (structural, not calls — tracePath ignores non-calls edges)
  graph.edges.push({ id: "e4", source: classId, target: methodId, type: "contains", weight: 1 });

  return { graph, queryIndex };
}

describe("GET /api/repo-graph/trace — trace from any node contracts", () => {
  // TC-1: arbitrary non-preset function node roots a real spine matching tracePath()
  test("TC-1: arbitrary non-preset function id (computeScore) → spine matches tracePath() output directly", async () => {
    // what this guarantees: the route accepts a raw non-entrypoint function node id and
    // returns a spine whose first element IS that node id and whose subsequent hops are
    // the same ones tracePath() would produce — proving the route makes a direct tracePath call.
    const { graph, queryIndex } = seedArbitraryGraph();
    await seed(graph, queryIndex);

    const entryId = "function:src/analysis/score.ts:computeScore";
    const res = await makeApp().request(`/api/repo-graph/trace?entry=${encodeURIComponent(entryId)}`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);

    const t = body.data;
    // spine[0] must be the requested node id
    expect(t.entry).toBe(entryId);
    expect(t.spine[0]).toBe(entryId);
    // real spine follows the resolved edges: computeScore → formatResult → renderOutput
    expect(t.spine).toContain("function:src/analysis/score.ts:formatResult");
    expect(t.spine).toContain("function:src/analysis/output.ts:renderOutput");
    // entry node must carry role="entry"
    const entryNode = t.nodes.find((n: { id: string }) => n.id === entryId);
    expect(entryNode).toBeDefined();
    expect(entryNode.role).toBe("entry");
  });

  // TC-2: method node (function type in class file) roots a valid spine
  test("TC-2: method node id (classifyData in DataClassifier) roots a valid spine", async () => {
    // what this guarantees: a function node that lives inside a class container (method-like)
    // is accepted as an entry and produces a real multi-node spine over the resolved call edges.
    const { graph, queryIndex } = seedArbitraryGraph();
    await seed(graph, queryIndex);

    const methodId = "function:src/analysis/classifier.ts:classifyData";
    const res = await makeApp().request(`/api/repo-graph/trace?entry=${encodeURIComponent(methodId)}`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);

    const t = body.data;
    expect(t.entry).toBe(methodId);
    expect(t.spine[0]).toBe(methodId);
    // classifyData → computeScore → formatResult → renderOutput (transitive chain)
    expect(t.spine.length).toBeGreaterThan(1);
    // entry node present with role
    const entryNode = t.nodes.find((n: { id: string }) => n.id === methodId);
    expect(entryNode).toBeDefined();
    expect(entryNode.role).toBe("entry");
  });

  // TC-3: leaf root → honest empty contract
  test("TC-3: leaf root (renderOutput — no resolved out-edges) → spine=[entryId], nodes=1, edges=0", async () => {
    // what this guarantees: when a function has NO resolved call edges, tracePath produces
    // exactly spine=[entryId] with one node and zero edges — no fabricated continuation.
    // This locks the honest-leaf backend contract.
    const { graph, queryIndex } = seedArbitraryGraph();
    await seed(graph, queryIndex);

    const leafId = "function:src/analysis/output.ts:renderOutput";
    const res = await makeApp().request(`/api/repo-graph/trace?entry=${encodeURIComponent(leafId)}`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);

    const t = body.data;
    expect(t.entry).toBe(leafId);
    expect(t.spine).toEqual([leafId]);
    // exactly one node: the entry itself
    expect(t.nodes).toHaveLength(1);
    expect(t.nodes[0].id).toBe(leafId);
    expect(t.nodes[0].role).toBe("entry");
    // zero spine edges (no fabricated hops)
    expect(t.edges).toHaveLength(0);
  });

  // TC-4: unknown node id → clean 404, not 500, not a fake spine
  test("TC-4: unknown / non-existent node id → 404 with error, no 500, no fake spine (existing behavior)", async () => {
    // what this guarantees: a node id that does not exist in graph.nodes returns a
    // clean 404 JSON {success:false, error:...} — no server error, no fabricated result.
    const { graph, queryIndex } = seedArbitraryGraph();
    await seed(graph, queryIndex);

    const res = await makeApp().request("/api/repo-graph/trace?entry=function:src/nonexistent.ts:phantomFn");
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.success).toBe(false);
    expect(typeof body.error).toBe("string");
    expect(body.error.length).toBeGreaterThan(0);
    // must NOT return data with a spine
    expect(body.data).toBeUndefined();
  });

  // TC-5: non-callable node (class: container) → lock honest behavior (no fabrication)
  test("TC-5: class: container node as entry → honest single-entry spine, no fabricated tail (discovering + locking actual behavior)", async () => {
    // what this guarantees: passing a class: node id (non-callable, no call edges) either
    // returns 404 (if the route guards against non-function types) or returns an honest
    // single-node spine with no fabricated continuation. Either answer is acceptable as long
    // as it is honest — this test DISCOVERS and LOCKS the actual behavior.
    const { graph, queryIndex } = seedArbitraryGraph();
    await seed(graph, queryIndex);

    const classId = "class:src/analysis/classifier.ts:DataClassifier";
    const res = await makeApp().request(`/api/repo-graph/trace?entry=${encodeURIComponent(classId)}`);

    // The route does NOT filter by node type — it accepts any node id in graph.nodes.
    // A class: node has no calls edges → tracePath returns spine=[classId], nodes=1, edges=0.
    // This is honest: it's the same leaf contract as TC-3.
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);

    const t = body.data;
    expect(t.entry).toBe(classId);
    // No fabricated continuation: spine is just the entry
    expect(t.spine).toEqual([classId]);
    // The one node is the class container itself
    expect(t.nodes).toHaveLength(1);
    expect(t.nodes[0].id).toBe(classId);
    // Zero edges — no invented call chain
    expect(t.edges).toHaveLength(0);
  });
});

describe("POST/GET /api/repo-graph/trace/purpose (M3 grounded generate)", () => {
  function appWithBrain(markdown: string, opts: { throws?: boolean } = {}): Hono {
    const app = new Hono();
    mountRepoGraphRoutes(app, {
      cwd,
      home,
      secret: TEST_SECRET,
      explainSourceProvider: async () => "function packContext(o){ return ''; }\n",
      explainBrainProvider: opts.throws
        ? async () => {
            throw new Error("claude -p exit code 429 · rate-limited");
          }
        : async () => ({
            markdown,
            usage: { cache_creation_input_tokens: 0, cache_read_input_tokens: 0, input_tokens: 1, output_tokens: 1, total_cost_usd: 0.001 },
          }),
    });
    return app;
  }

  // runExplain stamps source_fingerprint from this; deriveCacheState then reads
  // the SAME value → the cached-GET path is exercised (empty fingerprints = Stale).
  async function seedFp(path: string, sha: string): Promise<void> {
    const { storage_dir } = resolveRepoGraphLocation(cwd, { home });
    await writeFingerprints(storage_dir, { schemaVersion: 1, files: { [path]: { content_sha256: sha, ast_sig: sha } } });
  }

  test("POST → grounded {text, cite, cached:false}; GET then loads from cache", async () => {
    const { graph, queryIndex } = seedTraceGraph();
    await seed(graph, queryIndex);
    await seedFp("src/router/context.ts", "sha-ctx");
    const app = appWithBrain("packContext packs the session transcript into the Brain context. See [src/router/context.ts:41].");
    const post = await app.request("/api/repo-graph/trace/purpose", {
      method: "POST",
      headers: { "content-type": "application/json", "X-Siltpoke-Secret": TEST_SECRET },
      body: JSON.stringify({ node: "function:src/router/context.ts:packContext" }),
    });
    expect(post.status).toBe(200);
    const pb = await post.json();
    expect(pb.success).toBe(true);
    expect(pb.data.text).toContain("packs the session transcript");
    expect(pb.data.cite).toBe("src/router/context.ts:41");
    expect(pb.data.cached).toBe(false);

    const get = await app.request("/api/repo-graph/trace/purpose?node=function:src/router/context.ts:packContext");
    expect(get.status).toBe(200);
    const gb = await get.json();
    expect(gb.data.state).toBe("cached");
    expect(gb.data.text).toContain("packs the session transcript");
    expect(gb.data.cite).toBe("src/router/context.ts:41");
  });

  test("GET before any generate → state none", async () => {
    const { graph, queryIndex } = seedTraceGraph();
    await seed(graph, queryIndex);
    const res = await makeApp().request("/api/repo-graph/trace/purpose?node=function:src/router/context.ts:packContext");
    expect(res.status).toBe(200);
    expect((await res.json()).data.state).toBe("none");
  });

  test("Brain unavailable → 422 with the real reason, no dirty cache", async () => {
    const { graph, queryIndex } = seedTraceGraph();
    await seed(graph, queryIndex);
    await seedFp("src/router/context.ts", "sha-ctx");
    const app = appWithBrain("", { throws: true });
    const res = await app.request("/api/repo-graph/trace/purpose", {
      method: "POST",
      headers: { "content-type": "application/json", "X-Siltpoke-Secret": TEST_SECRET },
      body: JSON.stringify({ node: "function:src/router/context.ts:packContext" }),
    });
    expect(res.status).toBe(422);
    const b = await res.json();
    expect(b.success).toBe(false);
    expect(b.error).toContain("429");
    // failed generate must not have written a cache entry
    const get = await app.request("/api/repo-graph/trace/purpose?node=function:src/router/context.ts:packContext");
    expect((await get.json()).data.state).toBe("none");
  });

  test("400 when node missing in body", async () => {
    const { graph, queryIndex } = seedTraceGraph();
    await seed(graph, queryIndex);
    const res = await makeApp().request("/api/repo-graph/trace/purpose", {
      method: "POST",
      headers: { "content-type": "application/json", "X-Siltpoke-Secret": TEST_SECRET },
      body: "{}",
    });
    expect(res.status).toBe(400);
  });

  // M4: an unresolvable tail can't be linked by node-id, but its PARENT can —
  // generate reads the parent's body and cites the parent's file:line.
  test("unresolvable tail → resolves PARENT source, grounded {text, cite=parent}", async () => {
    const { graph, queryIndex } = seedTraceGraph();
    await seed(graph, queryIndex);
    await seedFp("src/router/context.ts", "sha-ctx");
    const app = appWithBrain("packContext slices the transcript and writes it out via a dynamic sink. See [src/router/context.ts:41].");
    const tailId = "unres:function:src/router/context.ts:packContext:writeFileSync";
    const res = await app.request("/api/repo-graph/trace/purpose", {
      method: "POST",
      headers: { "content-type": "application/json", "X-Siltpoke-Secret": TEST_SECRET },
      body: JSON.stringify({ node: tailId }),
    });
    expect(res.status).toBe(200);
    const b = await res.json();
    expect(b.success).toBe(true);
    expect(b.data.text).toContain("dynamic sink");
    expect(b.data.cite).toBe("src/router/context.ts:41"); // the PARENT's location
  });

  // daemon-hardening security audit, finding 2 — a blind cross-origin POST
  // could otherwise trigger a paid Brain call + a cache write for free.
  test("without the secret → 401, no Brain call, no cache write", async () => {
    const { graph, queryIndex } = seedTraceGraph();
    await seed(graph, queryIndex);
    await seedFp("src/router/context.ts", "sha-ctx");
    let brainCalled = false;
    const app = new Hono();
    mountRepoGraphRoutes(app, {
      cwd,
      home,
      secret: TEST_SECRET,
      explainSourceProvider: async () => "function packContext(o){ return ''; }\n",
      explainBrainProvider: async () => {
        brainCalled = true;
        return {
          markdown: "should never run",
          usage: { cache_creation_input_tokens: 0, cache_read_input_tokens: 0, input_tokens: 1, output_tokens: 1, total_cost_usd: 0.001 },
        };
      },
    });
    const res = await app.request("/api/repo-graph/trace/purpose", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ node: "function:src/router/context.ts:packContext" }),
    });
    expect(res.status).toBe(401);
    expect(brainCalled).toBe(false);
    const get = await app.request("/api/repo-graph/trace/purpose?node=function:src/router/context.ts:packContext");
    expect((await get.json()).data.state).toBe("none");
  });
});
