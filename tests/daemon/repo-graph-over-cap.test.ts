/**
 * Defect [38]: routes that serve a kept over-cap result must carry the cost
 * AND the hard cap, so the UI can flag it. (Split out of repo-graph.test.ts.)
 */
import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { mountRepoGraphRoutes } from "../../src/daemon/routes/repo-graph";
import { writeFingerprints, writeGraph, writeMeta, writeQueryIndex } from "../../src/repo-graph/store";
import { resolveRepoGraphLocation } from "../../src/repo-graph/proj-hash";
import { cacheKey, writeExplanation } from "../../src/explain/store";
import { EXPLANATION_SCHEMA_VERSION } from "../../src/explain/types";
import {
  emptyCounters,
  emptyFingerprints,
  emptyGraph,
  emptyQueryIndex,
  type RepoGraph,
  type RepoGraphMeta,
  type QueryIndex,
} from "../../src/repo-graph/types";
import { writeArchModel, type ArchModelMeta } from "../../src/explain/arch-cache";
import { ARCH_DEFAULT_HARD_CAP_USD } from "../../src/explain/arch-generate";
import { EXPLAIN_DEFAULT_HARD_CAP_USD } from "../../src/explain/explain";
import type { ArchModelDoc } from "../../src/explain/arch-model-schema";

let cwd: string;
let home: string;

const SECRET = "test-secret";

beforeEach(() => {
  const tmp = mkdtempSync(join(tmpdir(), "siltpoke-daemon-repograph-"));
  cwd = join(tmp, "proj");
  home = join(tmp, "home");
  mkdirSync(cwd, { recursive: true });
  mkdirSync(home, { recursive: true });
});

afterEach(() => {
  rmSync(cwd, { recursive: true, force: true });
  rmSync(home, { recursive: true, force: true });
});

async function seedGraph(graph: RepoGraph, opts: { queryIndex?: QueryIndex } = {}): Promise<void> {
  const { storage_dir, project_root, proj_hash } = resolveRepoGraphLocation(cwd, { home });
  await writeGraph(storage_dir, graph);
  await writeQueryIndex(storage_dir, opts.queryIndex ?? emptyQueryIndex());
  await writeFingerprints(storage_dir, emptyFingerprints());
  const meta: RepoGraphMeta = {
    schemaVersion: 1,
    project_root,
    proj_hash,
    last_indexed_ts: "2026-05-28T10:00:00.000Z",
    build_duration_ms: 100,
    counters: emptyCounters(),
  };
  await writeMeta(storage_dir, meta);
}

function makeGraphWith(entries: Array<{ id: string; name: string; path: string }>): RepoGraph {
  const g = emptyGraph();
  for (const e of entries) {
    g.nodes.push({ id: e.id, type: "file", name: e.name, path: e.path, lineRange: [1, 10], signature: undefined });
  }
  return g;
}

function archGraph(): RepoGraph {
  return makeGraphWith([
    { id: "file:src/cli/a.ts:", name: "a.ts", path: "src/cli/a.ts" },
    { id: "file:src/brain/b.ts:", name: "b.ts", path: "src/brain/b.ts" },
  ]);
}

function makeApp(): Hono {
  const app = new Hono();
  mountRepoGraphRoutes(app, { cwd, home, secret: SECRET });
  return app;
}

const ARCH_EV = [{ file: "src/cli/a.ts", line: 1 }];
const ARCH_DOC: ArchModelDoc = {
  boundary: "demo",
  bands: [{ id: "core", label: { value: "Core", evidence: ARCH_EV }, order: 0, members: ["cli", "brain"] }],
  nodes: [
    { id: "cli", kind: "cont", title: { value: "CLI", evidence: ARCH_EV }, band: { value: "core", evidence: ARCH_EV }, drillTo: "cli" },
    { id: "brain", kind: "cont", title: { value: "Brain", evidence: ARCH_EV }, band: { value: "core", evidence: ARCH_EV }, drillTo: "brain" },
  ],
  edges: [{ source: "cli", target: "brain", verb: { value: "uses", evidence: ARCH_EV } }],
};

function seedCachedModel(metaOver: Partial<ArchModelMeta> = {}): void {
  const { storage_dir } = resolveRepoGraphLocation(cwd, { home });
  mkdirSync(storage_dir, { recursive: true });
  const meta: ArchModelMeta = {
    schemaVersion: 1,
    fingerprint: "fp-test",
    graphIndexedTs: "2026-06-12T00:00:00Z",
    costUsd: 0.3,
    groundedPct: 78,
    model: "sonnet",
    generatedTs: "2026-06-12T00:00:00Z",
    ...metaOver,
  };
  writeArchModel(storage_dir, ARCH_DOC, meta, new Set(["cli", "brain"]));
}

describe("architecture-view generate", () => {
  test("GET /arch/model — carries the hard cap so a kept over-cap model can be flagged (defect [38])", async () => {
    await seedGraph(archGraph());
    seedCachedModel({ costUsd: 2.3 });
    const app = makeApp();
    const res = await app.fetch(new Request("http://localhost/api/repo-graph/arch/model"));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { costUsd: number; hardCapUsd: number } };
    expect(body.data.costUsd).toBe(2.3);
    expect(body.data.hardCapUsd).toBe(ARCH_DEFAULT_HARD_CAP_USD);
  });
});

describe("GET /api/repo-graph/explain/result", () => {
  test("carries the explanation's cost and the hard cap, so the modal can flag a kept over-cap result (defect [38])", async () => {
    const queryIndex = emptyQueryIndex();
    queryIndex.path_to_node_ids["src/x.ts"] = ["file:src/x.ts:"];
    await seedGraph(
      makeGraphWith([{ id: "file:src/x.ts:", name: "x.ts", path: "src/x.ts" }]),
      { queryIndex },
    );
    const { project_root } = resolveRepoGraphLocation(cwd, { home });
    await writeExplanation(project_root, cacheKey("file:src/x.ts:"), "# x.ts\nbody", {
      schemaVersion: EXPLANATION_SCHEMA_VERSION,
      target: "src/x.ts",
      target_node_id: "file:src/x.ts:",
      target_key_sha256: cacheKey("file:src/x.ts:"),
      graph_indexed_ts: new Date().toISOString(),
      brain_usage: {
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
        input_tokens: 0,
        output_tokens: 0,
        total_cost_usd: 0.148,
      },
      evidence_score: 1,
      low_confidence: false,
      depth: 1,
      created_ts: "2026-06-10T00:00:00.000Z",
      source_fingerprint: "abc123",
    });
    const res = await makeApp().fetch(
      new Request("http://localhost/api/repo-graph/explain/result?target=src%2Fx.ts"),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { costUsd: number | null; hardCapUsd: number } };
    expect(body.data.costUsd).toBe(0.148);
    expect(body.data.hardCapUsd).toBe(EXPLAIN_DEFAULT_HARD_CAP_USD);
  });
});
