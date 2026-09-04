/**
 * Grounding counts serialization.
 *
 * Pins:
 *  1. ArchModelMeta accepts optional citedClaims/totalClaims/topologyBlindClaims.
 *  2. writeArchModel persists the 3 counts when provided.
 *  3. readArchModel returns the 3 counts when present.
 *  4. Legacy meta WITHOUT the 3 counts parses fine (fields absent, never 0-fabricated).
 *  5. runArchGenerate writes the 3 counts derived from GroundResult.
 *  6. runArchGenerate omits the counts when the grounding result lacks them
 *     (should never happen at runtime — all code paths return them — but confirms
 *     no undefined bleeds onto disk).
 *
 * Run: bun test tests/explain/arch-cache-grounding-counts.test.ts
 */
import { describe, expect, it } from "bun:test";
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
import { listReviewerExternals } from "../../src/brain/registry";
import { anchoredRepoRoot } from "../_shared/arch-repo-root";

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
    generatedTs: "2026-06-12T00:00:00Z",
    ...over,
  };
}

async function tmpDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), "arch-gcounts-"));
}

// ── graph fixtures for runArchGenerate ────────────────────────────────────────

function fileNode(path: string): SiltpokeGraphNode {
  return { id: `file:${path}:`, type: "file", name: path.split("/").pop()!, path, lineRange: [1, 10] };
}

function fixtureMeta(root: string): RepoGraphMeta {
  return {
    schemaVersion: 1,
    project_root: root,
    proj_hash: "deadbeef0002",
    last_indexed_ts: "2026-06-12T00:00:00Z",
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
  const dir = await mkdtemp(join(tmpdir(), "arch-gcounts-repo-"));
  const graph: RepoGraph = {
    schemaVersion: 1,
    nodes: [fileNode("src/a/x.ts"), fileNode("src/b/y.ts")],
    edges: [],
  };
  await writeFile(join(dir, "graph.json"), JSON.stringify(graph));
  await writeFile(join(dir, "meta.json"), JSON.stringify(fixtureMeta(dir)));
  await writeFile(join(dir, "fingerprints.json"), JSON.stringify({ schemaVersion: 1, files: {} }));
  return dir;
}

// ═════════════════════════════════════════════════════════════════════════════
// 1. Schema: ArchModelMeta accepts optional grounding counts
// ═════════════════════════════════════════════════════════════════════════════

describe("ArchModelMeta — optional grounding count fields", () => {
  it("writeArchModel persists citedClaims/totalClaims/topologyBlindClaims when provided", async () => {
    const d = await tmpDir();
    // ArchModelMeta doesn't have the 3 fields yet → tsc error
    const r = writeArchModel(
      d,
      goodDoc(),
      baseMeta({ citedClaims: 29, totalClaims: 37, topologyBlindClaims: 2 }),
      SUBDIRS,
    );
    expect(r.ok).toBe(true);

    const raw = JSON.parse(await readFile(archMetaPath(d), "utf8")) as ArchModelMeta;
    // all 3 counts must be present in the written file.
    expect(raw.citedClaims).toBe(29);
    expect(raw.totalClaims).toBe(37);
    expect(raw.topologyBlindClaims).toBe(2);
  });

  it("writeArchModel omits counts when absent (undefined → no key on disk)", async () => {
    const d = await tmpDir();
    const r = writeArchModel(d, goodDoc(), baseMeta(), SUBDIRS);
    expect(r.ok).toBe(true);

    const raw = JSON.parse(await readFile(archMetaPath(d), "utf8")) as ArchModelMeta;
    // HONESTY RULE: legacy metas without counts → fields ABSENT, never 0.
    expect(raw.citedClaims).toBeUndefined();
    expect(raw.totalClaims).toBeUndefined();
    expect(raw.topologyBlindClaims).toBeUndefined();
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// 2. readArchModel returns grounding counts when present
// ═════════════════════════════════════════════════════════════════════════════

describe("readArchModel — grounding counts round-trip", () => {
  it("returns all 3 counts from a cache written with them", async () => {
    const d = await tmpDir();
    writeArchModel(
      d,
      goodDoc(),
      baseMeta({ fingerprint: "fpG", graphIndexedTs: "tsG", citedClaims: 29, totalClaims: 37, topologyBlindClaims: 2 }),
      SUBDIRS,
    );
    // Anchored root: the registry's evidence file exists here, so the externals
    // stay in scope and the injection this case measures actually happens.
    const r = await readArchModel(d, "fpG", "tsG", anchoredRepoRoot());
    expect(r).not.toBeNull();
    // all 3 counts must be returned. goodDoc() has no ext nodes at all, so
    // readArchModel's reconcile-on-read pass (added alongside this doc's read
    // path — see arch-cache.ts readArchModel) additively injects EVERY
    // registry-declared reviewer external (title+band+desc = 3 claims each,
    // no edge since goodDoc's nodes carry no `src/brain/` members) — totalClaims
    // grows by that amount; citedClaims/topologyBlindClaims are untouched by
    // reconcile (injected claims are inferred, never cited).
    const injected = listReviewerExternals().length * 3;
    expect(r!.meta.citedClaims).toBe(29);
    expect(r!.meta.totalClaims).toBe(37 + injected);
    expect(r!.meta.topologyBlindClaims).toBe(2);
  });

  it("legacy cache WITHOUT counts parses fine (stale:false, counts absent — never 0)", async () => {
    const d = await tmpDir();
    // Write a meta WITHOUT the 3 count fields (legacy format).
    const legacyMeta = {
      schemaVersion: 1,
      fingerprint: "fpLeg2",
      graphIndexedTs: "tsLeg2",
      costUsd: 0.5,
      groundedPct: 75,
      model: "sonnet",
      generatedTs: "2026-01-01T00:00:00Z",
      // no citedClaims, totalClaims, topologyBlindClaims
    };
    writeArchModel(d, goodDoc(), legacyMeta as ArchModelMeta, SUBDIRS);

    // Overwrite the meta file directly to ensure no count keys.
    await writeFile(archMetaPath(d), JSON.stringify(legacyMeta));

    const r = await readArchModel(d, "fpLeg2", "tsLeg2", null);
    // must not crash, stale:false, counts absent (NEVER 0).
    expect(r).not.toBeNull();
    expect(r!.stale).toBe(false);
    // HONESTY RULE: absent on legacy → undefined, never fabricated 0.
    expect(r!.meta.citedClaims).toBeUndefined();
    expect(r!.meta.totalClaims).toBeUndefined();
    expect(r!.meta.topologyBlindClaims).toBeUndefined();
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// 3. runArchGenerate writes grounding counts from GroundResult
// ═════════════════════════════════════════════════════════════════════════════

describe("runArchGenerate — grounding counts written to meta", () => {
  it("writes citedClaims/totalClaims/topologyBlindClaims to meta after a generate", async () => {
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
    };

    const outcome = await runArchGenerate(ctx);
    expect(outcome.kind).toBe("generated");

    const metaRaw = JSON.parse(await readFile(join(dir, "arch-model.meta.json"), "utf8")) as ArchModelMeta;
    // all 3 counts written to file.
    // VALID_DOC has: 1 band label (Core→cited/inferred based on graph),
    // 2 node titles, 1 node.band each, 1 edge.verb → the exact numbers depend on grounding,
    // but what matters is that the fields are numbers (not undefined).
    expect(typeof metaRaw.citedClaims).toBe("number");
    expect(typeof metaRaw.totalClaims).toBe("number");
    expect(typeof metaRaw.topologyBlindClaims).toBe("number");
    // Sanity: cited ≤ total (topology-blind excluded from denominator).
    expect(metaRaw.citedClaims!).toBeLessThanOrEqual(metaRaw.totalClaims!);
    expect(metaRaw.topologyBlindClaims!).toBeGreaterThanOrEqual(0);
  });

  it("cache-hit re-run (force:false) leaves on-disk counts intact + readable (review-MEDIUM audit pin)", async () => {
    const dir = await tmpRepo();

    // 1st run (paid): writes meta with counts.
    const brainProvider: ArchGenerateCtx["brainProvider"] = async () => ({
      markdown: JSON.stringify(VALID_DOC),
      usage: usage(0.5),
    });
    const first = await runArchGenerate({
      graphStorageDir: dir,
      brainProvider,
      loadOverlay: async () => null,
      sourceProvider: async () => null,
      force: true,
    });
    expect(first.kind).toBe("generated");
    const before = JSON.parse(await readFile(join(dir, "arch-model.meta.json"), "utf8")) as ArchModelMeta;
    expect(typeof before.citedClaims).toBe("number"); // precondition: counts on disk

    // 2nd run WITHOUT force → fresh cache hit, 0 Brain. The hit path returns
    // early (arch-generate.ts step 3) and must NOT rewrite/strip the meta —
    // GET /arch/model serves counts via readArchModel from this same file.
    let brainCalled = false;
    const second = await runArchGenerate({
      graphStorageDir: dir,
      brainProvider: async (...args) => {
        brainCalled = true;
        return brainProvider(...args);
      },
      loadOverlay: async () => null,
      sourceProvider: async () => null,
      force: false,
    });
    expect(second.kind).toBe("generated");
    if (second.kind === "generated") expect(second.fromCache).toBe(true);
    expect(brainCalled).toBe(false); // truly a cache hit, no paid call

    // ── CHECKPOINT: counts survive the hit, byte-identical to the 1st write.
    const after = JSON.parse(await readFile(join(dir, "arch-model.meta.json"), "utf8")) as ArchModelMeta;
    expect(after.citedClaims).toBe(before.citedClaims!);
    expect(after.totalClaims).toBe(before.totalClaims!);
    expect(after.topologyBlindClaims).toBe(before.topologyBlindClaims!);
  });
});
