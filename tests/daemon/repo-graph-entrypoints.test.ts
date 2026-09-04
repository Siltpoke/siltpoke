/**
 * Task 8 (generic entrypoint detection) — route wiring:
 *
 *   GET /api/repo-graph/entrypoints → passes the active repo's project_root
 *     through to detectEntrypointsWithWarnings and surfaces `warnings`.
 *   GET /api/repo-graph/trace (no ?entry) → defaults to the first ranked
 *     detected entry, NOT a hardcoded "cli" — so a repo with no preset cli
 *     (siltpoke's own authored allow-list) no longer 404s.
 *
 * Existing preset-cli coverage lives in repo-graph-trace.test.ts; this file
 * is scoped to the generic (bin-strategy) wiring these two handlers gained.
 */
import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
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
  const tmp = mkdtempSync(join(tmpdir(), "siltpoke-ep-route-"));
  cwd = join(tmp, "proj");
  home = join(tmp, "home");
  mkdirSync(cwd, { recursive: true });
  mkdirSync(home, { recursive: true });
});

afterEach(() => {
  rmSync(cwd, { recursive: true, force: true });
  rmSync(home, { recursive: true, force: true });
});

/**
 * A graph with ONE indexed file ("cli.js") holding a single exported
 * function (the bin strategy's Tier-1 root) — deliberately carries NONE of
 * siltpoke's own preset names (handleStopHook/startDaemon/Dashboard), so the
 * bin strategy is the only thing that can produce an entrypoint. This is
 * the "generic, non-siltpoke repo" fixture the whole task is about.
 */
function seedBinOnlyGraph(): { graph: RepoGraph; queryIndex: QueryIndex } {
  const graph = emptyGraph();
  const queryIndex: QueryIndex = { schemaVersion: 1, name_to_node_ids: {}, path_to_node_ids: {} };
  const id = "function:cli.js:runCli";
  graph.nodes.push({
    id,
    type: "function",
    name: "runCli",
    path: "cli.js",
    lineRange: [1, 10],
    signature: "runCli(): void",
    exported: true,
  });
  queryIndex.name_to_node_ids["runCli"] = [id];
  queryIndex.path_to_node_ids["cli.js"] = [id];
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

/** package.json#bin pointing directly at the indexed "cli.js" (no dist/ remap). */
function writePackageJsonWithBin(): void {
  writeFileSync(
    join(cwd, "package.json"),
    JSON.stringify({ name: "acme-tool", bin: { acme: "./cli.js" } }),
  );
}

const TEST_SECRET = "test-secret";

function makeApp(): Hono {
  const app = new Hono();
  mountRepoGraphRoutes(app, { cwd, home, secret: TEST_SECRET });
  return app;
}

describe("GET /api/repo-graph/entrypoints — generic detection wired (repoRoot, warnings)", () => {
  test("project_root is passed through to detection: a package.json#bin entry appears + warnings is an array", async () => {
    const { graph, queryIndex } = seedBinOnlyGraph();
    await seed(graph, queryIndex);
    writePackageJsonWithBin();

    const res = await makeApp().request("/api/repo-graph/entrypoints");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(Array.isArray(body.data.warnings)).toBe(true);
    const bin = body.data.entrypoints.find((e: { source?: string }) => e.source === "bin");
    expect(bin).toBeDefined();
    expect(bin.fn).toBe("runCli");
  });

  test("no package.json / no repoRoot signal → bin strategy skips silently (no throw, no bin entries)", async () => {
    const { graph, queryIndex } = seedBinOnlyGraph();
    await seed(graph, queryIndex);
    // deliberately no writePackageJsonWithBin() — project_root has no manifest

    const res = await makeApp().request("/api/repo-graph/entrypoints");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(body.data.entrypoints.some((e: { source?: string }) => e.source === "bin")).toBe(false);
  });
});

describe("GET /api/repo-graph/trace — default entry parity (no preset cli)", () => {
  test("no ?entry, no preset cli detected → 200 rooted at the first ranked (bin) entry, not a 404", async () => {
    const { graph, queryIndex } = seedBinOnlyGraph();
    await seed(graph, queryIndex);
    writePackageJsonWithBin();

    const res = await makeApp().request("/api/repo-graph/trace");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(body.data.entry).toBe("function:cli.js:runCli");
    expect(body.data.spine[0]).toBe("function:cli.js:runCli");
  });
});
