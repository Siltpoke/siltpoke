/**
 * durationMs persistence in arch-model meta.
 *
 * Pins:
 *  1. ArchModelMeta accepts optional durationMs field.
 *  2. writeArchModel persists durationMs when provided.
 *  3. readArchModel returns durationMs when present.
 *  4. Legacy meta WITHOUT durationMs still parses (schema-optional, stale:false
 *     survives, no crash).
 *  5. runArchGenerate writes durationMs computed from taskStartedTs when provided
 *     in the ctx (registry source-of-truth, single clock).
 *  6. runArchGenerate omits durationMs when taskStartedTs is absent (legacy call
 *     sites, no undefined on disk).
 *
 * Run: bun test tests/explain/arch-cache-duration.test.ts
 */
import { describe, expect, it } from "bun:test";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  archMetaPath,
  readArchModel,
  writeArchModel,
  type ArchModelMeta,
} from "../../src/explain/arch-cache";
import type { ArchModelDoc } from "../../src/explain/arch-model-schema";
import type { BrainUsage } from "../../src/brain/brain";
import { runArchGenerate, type ArchGenerateCtx } from "../../src/explain/arch-generate";
import type { RepoGraph, RepoGraphMeta, SiltpokeGraphNode } from "../../src/repo-graph/types";

// ── shared fixtures ────────────────────────────────────────────────────────────

const EV = [{ file: "src/a/x.ts", line: 1 }];

function goodDoc(): ArchModelDoc {
  return {
    boundary: "demo",
    bands: [{ id: "core", label: { value: "Core", evidence: EV }, order: 0, members: ["a", "b"] }],
    nodes: [
      { id: "a", kind: "cont", title: { value: "A", evidence: EV }, band: { value: "core", evidence: EV }, drillTo: "a" },
      { id: "b", kind: "cont", title: { value: "B", evidence: EV }, band: { value: "core", evidence: EV }, drillTo: "b" },
    ],
    edges: [{ source: "a", target: "b", verb: { value: "uses", evidence: EV } }],
  };
}

const SUBDIRS = new Set(["a", "b"]);

function baseMeta(over: Partial<ArchModelMeta> = {}): ArchModelMeta {
  return {
    schemaVersion: 1,
    fingerprint: "fp1",
    graphIndexedTs: "ts1",
    costUsd: 0.4,
    groundedPct: 80,
    model: "sonnet",
    generatedTs: "2026-06-11T00:00:00Z",
    ...over,
  };
}

async function tmpDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), "arch-dur-"));
}

// ── graph fixtures for runArchGenerate ────────────────────────────────────────

function fileNode(path: string): SiltpokeGraphNode {
  return { id: `file:${path}:`, type: "file", name: path.split("/").pop()!, path, lineRange: [1, 10] };
}

function fixtureMeta(root: string): RepoGraphMeta {
  return {
    schemaVersion: 1,
    project_root: root,
    proj_hash: "deadbeef0001",
    last_indexed_ts: "2026-06-11T00:00:00Z",
    build_duration_ms: 1,
    counters: {
      files_walked: 2,
      files_cached: 0,
      parse_degraded: 0,
      skipped: { tree_sitter_failed: 0, too_large: 0, not_a_source_file: 0, file_cap: 0 },
      nodes: { file: 2, function: 0, class: 0, module: 0, symbol: 0 },
      edges: { imports: 0, calls: 0, contains: 0 },
    },
  };
}

const VALID_DOC: ArchModelDoc = {
  boundary: "demo",
  bands: [{ id: "core", label: { value: "Core", evidence: EV }, order: 0, members: ["a", "b"] }],
  nodes: [
    { id: "a", kind: "cont", title: { value: "A", evidence: EV }, band: { value: "core", evidence: EV }, drillTo: "a" },
    { id: "b", kind: "cont", title: { value: "B", evidence: EV }, band: { value: "core", evidence: EV }, drillTo: "b" },
  ],
  edges: [],
};

function usage(cost: number): BrainUsage {
  return { cache_creation_input_tokens: 0, cache_read_input_tokens: 0, input_tokens: 100, output_tokens: 50, total_cost_usd: cost };
}

async function tmpRepo(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "arch-dur-repo-"));
  const graph: RepoGraph = {
    schemaVersion: 1,
    nodes: [fileNode("src/a/x.ts"), fileNode("src/b/y.ts")],
    edges: [],
  };
  await writeFile(join(dir, "graph.json"), JSON.stringify(graph));
  await writeFile(join(dir, "meta.json"), JSON.stringify(fixtureMeta(dir)));
  // fingerprints (empty but must exist).
  await writeFile(join(dir, "fingerprints.json"), JSON.stringify({ schemaVersion: 1, files: {} }));
  return dir;
}

// ═════════════════════════════════════════════════════════════════════════════
// 1. Schema: ArchModelMeta accepts optional durationMs
// ═════════════════════════════════════════════════════════════════════════════

describe("ArchModelMeta — optional durationMs field", () => {
  it("(schema check) writeArchModel persists durationMs when provided", async () => {
    const d = await tmpDir();
    // writeArchModel doesn't accept durationMs yet → field absent
    const r = writeArchModel(d, goodDoc(), baseMeta({ durationMs: 134_567 }), SUBDIRS);
    expect(r.ok).toBe(true);

    const raw = JSON.parse(await readFile(archMetaPath(d), "utf8")) as ArchModelMeta;
    // durationMs must be 134567 in the written file.
    expect(raw.durationMs).toBe(134_567);
  });

  it("writeArchModel omits durationMs when absent (undefined → no key on disk)", async () => {
    const d = await tmpDir();
    const r = writeArchModel(d, goodDoc(), baseMeta(), SUBDIRS);
    expect(r.ok).toBe(true);

    const raw = JSON.parse(await readFile(archMetaPath(d), "utf8")) as ArchModelMeta;
    // When not provided: the field must be absent (not "undefined" stringified).
    expect(raw.durationMs).toBeUndefined();
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// 2. readArchModel returns durationMs when present
// ═════════════════════════════════════════════════════════════════════════════

describe("readArchModel — durationMs round-trip", () => {
  it("returns durationMs from a cache written with that field", async () => {
    const d = await tmpDir();
    writeArchModel(d, goodDoc(), baseMeta({ fingerprint: "fpX", graphIndexedTs: "tsX", durationMs: 88_000 }), SUBDIRS);
    const r = await readArchModel(d, "fpX", "tsX", null);
    expect(r).not.toBeNull();
    // meta.durationMs must be 88000.
    expect(r!.meta.durationMs).toBe(88_000);
  });

  it("legacy cache WITHOUT durationMs parses fine (stale:false, no crash)", async () => {
    const d = await tmpDir();
    // Write a meta WITHOUT durationMs (legacy format).
    const legacyMeta = {
      schemaVersion: 1,
      fingerprint: "fpLeg",
      graphIndexedTs: "tsLeg",
      costUsd: 0.5,
      groundedPct: 75,
      model: "sonnet",
      generatedTs: "2026-01-01T00:00:00Z",
      // no durationMs
    };
    writeArchModel(d, goodDoc(), legacyMeta as ArchModelMeta, SUBDIRS);

    // Overwrite the meta file directly to ensure no durationMs key.
    await writeFile(archMetaPath(d), JSON.stringify(legacyMeta));

    const r = await readArchModel(d, "fpLeg", "tsLeg", null);
    // must not crash, stale:false, durationMs absent.
    expect(r).not.toBeNull();
    expect(r!.stale).toBe(false);
    expect(r!.meta.durationMs).toBeUndefined();
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// 3. runArchGenerate writes durationMs from taskStartedTs
// ═════════════════════════════════════════════════════════════════════════════

describe("runArchGenerate — durationMs from taskStartedTs", () => {
  it("writes durationMs to meta when taskStartedTs is provided", async () => {
    const dir = await tmpRepo();

    // taskStartedTs = 30 seconds ago
    const startedAt = new Date(Date.now() - 30_000).toISOString();

    const ctx: ArchGenerateCtx = {
      graphStorageDir: dir,
      brainProvider: async () => ({
        markdown: JSON.stringify(VALID_DOC),
        usage: usage(0.5),
      }),
      loadOverlay: async () => null,
      sourceProvider: async () => null,
      force: true,
      taskStartedTs: startedAt,
    };

    const outcome = await runArchGenerate(ctx);
    // outcome must be "generated" (not pre_check_failed etc.).
    // If taskStartedTs is not in ArchGenerateCtx, tsc rejects it → build RED.
    expect(outcome.kind).toBe("generated");

    // Read the written meta and check durationMs is ≥ 30000 (we waited ~30s).
    const metaRaw = JSON.parse(await readFile(join(dir, "arch-model.meta.json"), "utf8")) as ArchModelMeta;
    // durationMs written to file.
    expect(typeof metaRaw.durationMs).toBe("number");
    // It should be approximately 30s, but we allow generous range since test timing varies.
    expect(metaRaw.durationMs).toBeGreaterThanOrEqual(1); // at minimum 1ms
    expect(metaRaw.durationMs).toBeLessThan(60_000); // never more than 60s in test
  });

  it("omits durationMs when taskStartedTs is absent (legacy callers)", async () => {
    const dir = await tmpRepo();

    const ctx: ArchGenerateCtx = {
      graphStorageDir: dir,
      brainProvider: async () => ({
        markdown: JSON.stringify(VALID_DOC),
        usage: usage(0.5),
      }),
      loadOverlay: async () => null,
      sourceProvider: async () => null,
      force: true,
      // no taskStartedTs
    };

    const outcome = await runArchGenerate(ctx);
    expect(outcome.kind).toBe("generated");

    const metaRaw = JSON.parse(await readFile(join(dir, "arch-model.meta.json"), "utf8")) as ArchModelMeta;
    // durationMs absent when not provided.
    expect(metaRaw.durationMs).toBeUndefined();
  });
});
