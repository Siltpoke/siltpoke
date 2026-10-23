/**
 * Defect [38] smoke for POST/GET /api/repo-graph/trace/purpose: an over-cap
 * purpose is kept. (Split out of repo-graph-trace.test.ts.)
 */
import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { mountRepoGraphRoutes } from "../../src/daemon/routes/repo-graph";
import { writeFingerprints, writeGraph, writeMeta, writeQueryIndex } from "../../src/repo-graph/store";
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

async function seed(graph: RepoGraph, queryIndex: QueryIndex): Promise<void> {
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
  };
  await writeMeta(storage_dir, meta);
}

const TEST_SECRET = "test-secret";

describe("POST/GET /api/repo-graph/trace/purpose (M3 grounded generate)", () => {
  function appWithBrain(markdown: string, opts: { costUsd?: number } = {}): Hono {
    const app = new Hono();
    mountRepoGraphRoutes(app, {
      cwd,
      home,
      secret: TEST_SECRET,
      explainSourceProvider: async () => "function packContext(o){ return ''; }\n",
      explainBrainProvider: async () => ({
        markdown,
        usage: { cache_creation_input_tokens: 0, cache_read_input_tokens: 0, input_tokens: 1, output_tokens: 1, total_cost_usd: opts.costUsd ?? 0.001 },
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

  test("an over-cap purpose is kept, the preamble skipped, and both routes carry cost + cap (defect [38] smoke)", async () => {
    const { graph, queryIndex } = seedTraceGraph();
    await seed(graph, queryIndex);
    await seedFp("src/router/context.ts", "sha-ctx");
    const app = appWithBrain(
      "Based on the code I've reviewed, let me compile it:\n\n# packContext\n\npackContext packs the transcript. See [src/router/context.ts:41].",
      { costUsd: 0.149 },
    );
    const post = await app.request("/api/repo-graph/trace/purpose", {
      method: "POST",
      headers: { "content-type": "application/json", "X-Siltpoke-Secret": TEST_SECRET },
      body: JSON.stringify({ node: "function:src/router/context.ts:packContext" }),
    });
    expect(post.status).toBe(200);
    const pb = await post.json();
    expect(pb.data.text).toBe("packContext packs the transcript. See [src/router/context.ts:41].");
    expect(pb.data.costUsd).toBe(0.149);
    expect(pb.data.hardCapUsd).toBe(0.1);

    const gb = await (await app.request("/api/repo-graph/trace/purpose?node=function:src/router/context.ts:packContext")).json();
    expect(gb.data.state).toBe("cached");
    expect(gb.data.text).not.toContain("Based on the code");
    expect(gb.data.costUsd).toBe(0.149);
    expect(gb.data.hardCapUsd).toBe(0.1);
  });
});
