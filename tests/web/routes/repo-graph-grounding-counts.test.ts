/**
 * SSR payload carries grounding counts (server half).
 *
 * Pins:
 *  1. SSR payload `generatedModel` includes citedClaims/totalClaims/topologyBlindClaims
 *     when the cached meta has them.
 *  2. Legacy meta WITHOUT counts → `generatedModel` fields absent (never 0).
 *
 * Run: bun test tests/web/routes/repo-graph-grounding-counts.test.ts
 */
import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { mountRepoGraphWebRoutes } from "../../../src/web/routes/repo-graph";
import { writeGraph, writeMeta, writeFingerprints } from "../../../src/repo-graph/store";
import { writeArchModel } from "../../../src/explain/arch-cache";
import type { ArchModelMeta } from "../../../src/explain/arch-cache";
import type { ArchModelDoc } from "../../../src/explain/arch-model-schema";
import { emptyGraph, emptyFingerprints } from "../../../src/repo-graph/types";
import type { RepoGraphMeta } from "../../../src/repo-graph/types";
import { resolveRepoGraphLocation } from "../../../src/repo-graph/proj-hash";

let cwd: string;
let home: string;

beforeEach(() => {
  const tmp = mkdtempSync(join(tmpdir(), "siltpoke-web-gcounts-"));
  cwd = join(tmp, "proj");
  home = join(tmp, "home");
  mkdirSync(cwd, { recursive: true });
  mkdirSync(home, { recursive: true });
});

afterEach(() => {
  rmSync(cwd, { recursive: true, force: true });
  rmSync(home, { recursive: true, force: true });
});

function makeApp(): Hono {
  const app = new Hono();
  mountRepoGraphWebRoutes(app, { cwd, home });
  return app;
}

/** Un-escape Hono's HTML-safe JSON and parse the data-initial payload. */
function parseInitial(html: string): Record<string, unknown> {
  const match = /data-initial="([^"]+)"/.exec(html);
  expect(match).not.toBeNull();
  const raw = match![1]!
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">");
  return JSON.parse(raw);
}

const EV = [{ file: "src/a/x.ts", line: 1 }];

const GOOD_DOC: ArchModelDoc = {
  boundary: "demo",
  bands: [{ id: "core", label: { value: "Core", evidence: EV }, order: 0, members: ["a"] }],
  nodes: [
    { id: "a", kind: "cont", title: { value: "A", evidence: EV }, band: { value: "core", evidence: EV }, drillTo: "a" },
  ],
  edges: [],
};

async function seedWithMeta(meta: Omit<ArchModelMeta, "schemaVersion" | "fingerprint" | "graphIndexedTs">): Promise<void> {
  const { storage_dir, project_root, proj_hash } = resolveRepoGraphLocation(cwd, { home });
  mkdirSync(storage_dir, { recursive: true });
  const graph = emptyGraph();
  const repoMeta: RepoGraphMeta = {
    schemaVersion: 1,
    project_root,
    proj_hash,
    last_indexed_ts: "2026-06-12T00:00:00Z",
    build_duration_ms: 1,
    counters: {
      files_walked: 0,
      files_cached: 0,
      skipped: { tree_sitter_failed: 0, too_large: 0, not_a_source_file: 0, file_cap: 0 },
      nodes: { file: 0, function: 0, class: 0, module: 0, symbol: 0 },
      edges: { imports: 0, calls: 0, contains: 0 },
    },
  };
  await writeGraph(storage_dir, graph);
  await writeMeta(storage_dir, repoMeta);
  await writeFingerprints(storage_dir, emptyFingerprints());

  const fullMeta: ArchModelMeta = {
    schemaVersion: 1,
    fingerprint: "fp-gcounts-test",
    graphIndexedTs: "2026-06-12T00:00:00Z",
    ...meta,
  };
  writeArchModel(storage_dir, GOOD_DOC, fullMeta, new Set(["a"]));
}

describe("SSR /repo-graph — generatedModel grounding counts in data-initial", () => {
  test("payload includes citedClaims/totalClaims/topologyBlindClaims when cached meta has them", async () => {
    await seedWithMeta({
      costUsd: 0.3,
      groundedPct: 78,
      model: "sonnet",
      generatedTs: "2026-06-12T00:00:00Z",
      citedClaims: 29,
      totalClaims: 37,
      topologyBlindClaims: 2,
    });

    const res = await makeApp().fetch(new Request(`http://localhost/repo-graph`));
    expect(res.status).toBe(200);
    const html = await res.text();
    const payload = parseInitial(html);
    const gm = payload.generatedModel as Record<string, unknown> | null;
    // ── generatedModel must be non-null and carry the 3 counts.
    expect(gm).not.toBeNull();
    expect(gm!.citedClaims).toBe(29);
    expect(gm!.totalClaims).toBe(37);
    expect(gm!.topologyBlindClaims).toBe(2);
  });

  test("legacy meta WITHOUT counts → generatedModel fields absent, never 0 (honesty rule)", async () => {
    await seedWithMeta({
      costUsd: 0.3,
      groundedPct: 78,
      model: "sonnet",
      generatedTs: "2026-06-12T00:00:00Z",
      // No citedClaims / totalClaims / topologyBlindClaims
    });

    const res = await makeApp().fetch(new Request(`http://localhost/repo-graph`));
    expect(res.status).toBe(200);
    const html = await res.text();
    const payload = parseInitial(html);
    const gm = payload.generatedModel as Record<string, unknown> | null;
    // ── counts MUST be absent (null/undefined), never 0.
    expect(gm).not.toBeNull();
    // JSON serialization of undefined fields omits them → the key will be absent.
    expect(gm!.citedClaims).toBeUndefined();
    expect(gm!.totalClaims).toBeUndefined();
    expect(gm!.topologyBlindClaims).toBeUndefined();
  });
});
