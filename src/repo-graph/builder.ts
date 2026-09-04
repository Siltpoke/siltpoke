// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
// Copyright (c) 2026 Jiaqi Duan
/**
 * Builder orchestrator.
 *
 * Drives:
 *   walker → fingerprint cache check → parse (if cache miss) → extract
 *   → merge file's nodes/edges into the graph → write graph/queryIndex/
 *   fingerprints/meta atomically.
 *
 * Public API: `runIndexBuild({ cwd, force, now, home? })`.
 */
import { existsSync } from "node:fs";
import { readFile, rm } from "node:fs/promises";
import { parseSource } from "../critic/rubric/tier2/ast-loader";
import { discoverAnchorMap } from "./anchor-discovery";
import { computeAstSignature } from "./ast-signature";
import { computeCoverage } from "./coverage";
import { type ExtractedFile, extractFile } from "./extractor";
import { computeContentSha, fingerprintMatches } from "./fingerprint";
import { resolveRepoGraphLocation } from "./proj-hash";
import { seedSeenWatermark, type WriteSeenFn } from "./seen-seed";
import {
  ensureStorageDir,
  readFingerprints,
  readGraph,
  readMeta,
  writeFingerprints,
  writeGraph,
  writeMeta,
  writeQueryIndex,
} from "./store";
import {
  emptyCounters,
  emptyFingerprints,
  emptyGraph,
  emptyQueryIndex,
  type FileFingerprint,
  type Fingerprints,
  type QueryIndex,
  type RepoGraph,
  type RepoGraphMeta,
  type RepoGraphMetaCounters,
  type SiltpokeGraphEdge,
  type SiltpokeGraphNode,
} from "./types";
import { type WalkedFile, walkProject } from "./walker";

export interface IndexBuildOptions {
  cwd: string;
  /** When true, ignore fingerprints and re-walk every file. */
  force?: boolean;
  /** When provided, override the siltpoke home dir (tests). */
  home?: string;
  now?: () => Date;
  /**
   * Test hook fired immediately AFTER the start-of-build meta.json
   * write (building=true) and BEFORE any walking/parsing/finalizing.
   * Production callers leave this undefined. Used by building-flag
   * lifecycle tests to assert the mid-build observable state.
   */
  __onBuildStart?: (storageDir: string) => void | Promise<void>;
  /**
   * Progress callback fired once per source file during the parse
   * loop, `(done, total)`. `total` is known after the (eager) walk; before that
   * the caller shows "scanning…". Production daemon uses this to stream SSE
   * progress; CLI emits NDJSON when `--progress` is set. Optional + side-effect
   * free — leaving it undefined keeps the old behavior exactly.
   */
  onProgress?: (done: number, total: number) => void;
  /**
   * Test-only override for the `seen.json` seed write (see `seen-seed.ts`).
   * Production callers leave this undefined. Lets a test inject a failing
   * write to prove a seed-write error can never propagate out of
   * `runIndexBuild` and trigger failure cleanup on an otherwise-successful
   * build.
   */
  __seedWriteSeenOverride?: WriteSeenFn;
}

export interface IndexBuildResult {
  project_root: string;
  proj_hash: string;
  storage_dir: string;
  duration_ms: number;
  counters: RepoGraphMetaCounters;
}

/**
 * Group existing graph nodes + edges by source file so per-file
 * recomputation can replace them cleanly.
 */
function groupByFile(graph: RepoGraph): {
  nodesByFile: Map<string, SiltpokeGraphNode[]>;
  edgesByFile: Map<string, SiltpokeGraphEdge[]>;
} {
  const nodesByFile = new Map<string, SiltpokeGraphNode[]>();
  const edgesByFile = new Map<string, SiltpokeGraphEdge[]>();
  for (const n of graph.nodes) {
    const arr = nodesByFile.get(n.path) ?? [];
    arr.push(n);
    nodesByFile.set(n.path, arr);
  }
  for (const e of graph.edges) {
    // Edges live with the file owning their SOURCE node. `imports`/`contains`
    // are file-sourced (`file:{relPath}:`); `calls` edges are
    // function/class-sourced (`function:{relPath}:{name}`). Extract the path
    // from any node-id-shaped source so call edges survive incremental reuse.
    const m = /^(?:file|function|class|module|symbol):([^:]+):/.exec(e.source);
    if (!m) continue;
    const path = m[1]!;
    const arr = edgesByFile.get(path) ?? [];
    arr.push(e);
    edgesByFile.set(path, arr);
  }
  return { nodesByFile, edgesByFile };
}

function bumpNodeCounters(counters: RepoGraphMetaCounters, nodes: SiltpokeGraphNode[]): void {
  for (const n of nodes) {
    counters.nodes[n.type] = (counters.nodes[n.type] ?? 0) + 1;
  }
}

function bumpEdgeCounters(counters: RepoGraphMetaCounters, edges: SiltpokeGraphEdge[]): void {
  for (const e of edges) {
    counters.edges[e.type] = (counters.edges[e.type] ?? 0) + 1;
  }
}

function buildQueryIndex(graph: RepoGraph): QueryIndex {
  // Use null-proto maps to avoid prototype pollution: a node named
  // "constructor" / "toString" / "__proto__" would otherwise collide
  // with Object.prototype properties and break `??=` (the existing
  // prototype value is not nullish, so `??=` skips assignment, then
  // `.push` is undefined).
  const name_to_node_ids = Object.create(null) as Record<string, string[]>;
  const path_to_node_ids = Object.create(null) as Record<string, string[]>;
  const hasOwn = Object.prototype.hasOwnProperty;
  for (const n of graph.nodes) {
    if (!hasOwn.call(name_to_node_ids, n.name)) name_to_node_ids[n.name] = [];
    name_to_node_ids[n.name]!.push(n.id);
    if (!hasOwn.call(path_to_node_ids, n.path)) path_to_node_ids[n.path] = [];
    path_to_node_ids[n.path]!.push(n.id);
  }
  return { schemaVersion: 1, name_to_node_ids, path_to_node_ids };
}

async function readAndFingerprintFile(
  file: WalkedFile,
): Promise<{
  content: string;
  fingerprint: FileFingerprint;
  extracted: ExtractedFile;
  degraded: boolean;
} | null> {
  let content: string;
  try {
    content = await readFile(file.absPath, "utf8");
  } catch {
    return null;
  }
  const tree = await parseSource(content, file.lang);
  if (!tree) return null;
  // tree-sitter recovers from unparseable input with ERROR / MISSING nodes
  // rather than failing, so `tree` being non-null does NOT mean the file
  // parsed cleanly. Extraction still runs — partial data is worth keeping —
  // but the degradation is reported so it stops being silent.
  const degraded = tree.rootNode.hasError;
  const fingerprint: FileFingerprint = {
    content_sha256: computeContentSha(content),
    ast_sig: computeAstSignature(tree),
    degraded,
  };
  const extracted = extractFile(tree, {
    relPath: file.relPath,
    lang: file.lang,
    lineCount: content.split("\n").length,
  });
  return { content, fingerprint, extracted, degraded };
}

/**
 * Write meta.json with `building: true` BEFORE any walking. If a
 * prior successful build's meta exists, preserve its fields (especially
 * `last_indexed_ts` — that field represents "last completed indexing"
 * and must not be bumped to "now" during an in-flight build, otherwise
 * the repo picker's "stale by N hours" calculation breaks). If no prior
 * meta exists (cold build), write a minimal stub.
 */
async function markBuildStart(
  storage_dir: string,
  project_root: string,
  proj_hash: string,
): Promise<void> {
  await ensureStorageDir(storage_dir);
  const prior = await readMeta(storage_dir);
  const stub: RepoGraphMeta = prior
    ? { ...prior, building: true }
    : {
        schemaVersion: 1,
        project_root,
        proj_hash,
        last_indexed_ts: "",
        build_duration_ms: 0,
        counters: emptyCounters(),
        building: true,
      };
  await writeMeta(storage_dir, stub);
}

export async function runIndexBuild(opts: IndexBuildOptions): Promise<IndexBuildResult> {
  const now = opts.now ?? (() => new Date());
  const start = performance.now();

  const location = resolveRepoGraphLocation(opts.cwd, { home: opts.home });
  const { project_root, proj_hash, storage_dir } = location;

  // Whether a (presumably good) index already existed BEFORE this
  // build. Drives failure cleanup — a cold build that throws is fully removed
  // (no `building:true` orphan, the stale-orphan root cause); a re-index that
  // throws keeps the prior data but reverts the `building` flag. Also doubles
  // as the "had a prior index before this build" signal `seedSeenWatermark`
  // needs (slice ③, C2) — captured here, BEFORE markBuildStart/buildInner run
  // any writes, so it's never contaminated by this build's own directory
  // creation.
  const preexisted = existsSync(storage_dir);

  await markBuildStart(storage_dir, project_root, proj_hash);
  try {
    const result = await buildInner(opts, location, now, start);
    // Runs AFTER fingerprints are durably written (buildInner has already
    // returned). See `seedSeenWatermark` (seen-seed.ts) for the seed rules —
    // it never throws (best-effort), so a seed-write failure can't land in
    // the `catch` below and wipe this successful build's output.
    await seedSeenWatermark(storage_dir, project_root, preexisted, opts.__seedWriteSeenOverride);
    return result;
  } catch (err) {
    await cleanupFailedBuild(storage_dir, preexisted);
    throw err;
  }
}

/** Failure cleanup for `runIndexBuild` — see `preexisted` rationale above. */
async function cleanupFailedBuild(storage_dir: string, preexisted: boolean): Promise<void> {
  if (!preexisted) {
    // Cold build: the dir holds only a `building:true` stub (+ maybe partial
    // artifacts). Remove it wholesale so it never shows as a stuck "indexing".
    await rm(storage_dir, { recursive: true, force: true }).catch(() => {});
    return;
  }
  // Re-index: a prior good index lives here. Don't delete it — just un-stick the
  // building flag so the picker stops showing "indexing" forever. Best-effort.
  try {
    const meta = await readMeta(storage_dir);
    if (meta) await writeMeta(storage_dir, { ...meta, building: false });
  } catch {
    /* best-effort; daemon-side cleanup is the authority */
  }
}

async function buildInner(
  opts: IndexBuildOptions,
  location: { project_root: string; proj_hash: string; storage_dir: string },
  now: () => Date,
  start: number,
): Promise<IndexBuildResult> {
  const { project_root, proj_hash, storage_dir } = location;
  if (opts.__onBuildStart) await opts.__onBuildStart(storage_dir);

  const previousGraph = opts.force ? emptyGraph() : await readGraph(storage_dir);
  const previousFingerprints = opts.force ? emptyFingerprints() : await readFingerprints(storage_dir);
  const { nodesByFile, edgesByFile } = groupByFile(previousGraph);

  const counters = emptyCounters();
  const newGraph: RepoGraph = emptyGraph();
  const newFingerprints: Fingerprints = emptyFingerprints();

  const walk = await walkProject(project_root);

  for (const skip of walk.skipped) {
    counters.skipped[skip.reason] += 1;
  }

  // Track which files are still in the project (so we drop nodes/edges
  // for deleted files in the final write).
  const survivingFiles = new Set<string>();

  // Total is known now (eager walk); emit progress per file. Fired
  // at the top of each iteration (before any `continue`), so `done` counts
  // files completed so far regardless of the cached/parsed/failed branch.
  const total = walk.files.length;
  let done = 0;
  for (const file of walk.files) {
    opts.onProgress?.(done, total);
    done += 1;
    survivingFiles.add(file.relPath);
    const cached = previousFingerprints.files[file.relPath];

    // Fast cached path: try to compute only content sha first; if it
    // matches AND we have the previous AST sig, we still need AST sig
    // confirmation (could be a same-bytes file post-history-edit). For
    // now, just re-parse on any content_sha miss; if content_sha
    // matches the cache, trust it (same bytes = same AST).
    if (cached !== undefined) {
      let content: string;
      try {
        content = await readFile(file.absPath, "utf8");
      } catch {
        // File vanished between walk + read; treat as deleted.
        survivingFiles.delete(file.relPath);
        continue;
      }
      const contentSha = computeContentSha(content);
      // `degraded === undefined` means this fingerprint predates the field.
      // Reusing it would trust "absent" as "clean" forever: the content sha
      // still matches on every future build, so the file would never be
      // re-parsed and an already-indexed repo would report 0 degraded files
      // permanently — the same silent under-extraction the counter exists to
      // end. Falling through to the parse path costs one re-parse per stale
      // file, once, and the index self-heals with no user action.
      if (contentSha === cached.content_sha256 && cached.degraded !== undefined) {
        // Reuse cached nodes + edges. No parse.
        const reusedNodes = nodesByFile.get(file.relPath) ?? [];
        const reusedEdges = edgesByFile.get(file.relPath) ?? [];
        newGraph.nodes.push(...reusedNodes);
        newGraph.edges.push(...reusedEdges);
        newFingerprints.files[file.relPath] = cached;
        counters.files_cached += 1;
        // The cache path never re-parses, so degradation must come from the
        // persisted fingerprint or the count silently resets on every
        // incremental build — which is nearly every build.
        if (cached.degraded) counters.parse_degraded += 1;
        bumpNodeCounters(counters, reusedNodes);
        bumpEdgeCounters(counters, reusedEdges);
        continue;
      }
    }

    // Cache miss → parse + extract.
    const parsed = await readAndFingerprintFile(file);
    if (parsed === null) {
      counters.skipped.tree_sitter_failed += 1;
      continue;
    }
    newGraph.nodes.push(...parsed.extracted.nodes);
    newGraph.edges.push(...parsed.extracted.edges);
    newFingerprints.files[file.relPath] = parsed.fingerprint;
    counters.files_walked += 1;
    if (parsed.degraded) counters.parse_degraded += 1;
    bumpNodeCounters(counters, parsed.extracted.nodes);
    bumpEdgeCounters(counters, parsed.extracted.edges);
  }
  opts.onProgress?.(total, total); // final tick — all files processed
  // `fingerprintMatches` is currently exported but unused in builder
  // (cache check is content-sha-only above for speed). Keep export for
  // future use cases that want strict sha+ast_sig match.
  void fingerprintMatches;

  const queryIndex = buildQueryIndex(newGraph);

  // Resolve call edges + compute the coverage gate at INDEX time so
  // it's a stored value the trace endpoints read without re-resolving.
  const coverage = computeCoverage(newGraph, queryIndex);

  await writeGraph(storage_dir, newGraph);
  await writeQueryIndex(storage_dir, queryIndex);
  await writeFingerprints(storage_dir, newFingerprints);

  // Tier-4 import anchors (alias-edge resolution): discovered at index time
  // (TS configs read from disk + Python source roots inferred structurally) and
  // baked into meta so the consume-time resolver stays a pure function.
  const anchorMap = discoverAnchorMap(project_root, newGraph);

  const duration_ms = performance.now() - start;
  const meta: RepoGraphMeta = {
    schemaVersion: 1,
    project_root,
    proj_hash,
    last_indexed_ts: now().toISOString(),
    build_duration_ms: Math.round(duration_ms),
    counters,
    coverage,
    building: false,
    anchorMap,
  };
  await writeMeta(storage_dir, meta);

  return {
    project_root,
    proj_hash,
    storage_dir,
    duration_ms: meta.build_duration_ms,
    counters,
  };
}
