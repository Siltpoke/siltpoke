// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
// Copyright (c) 2026 Jiaqi Duan
/**
 * `GET /api/repo-graph/arch/trust` (spec §5) — wires Tasks 1-5 (git-stamp,
 * trust-map, trust-imports, trust-citation, trust-inputs) into one daemon
 * route. Reads the active repo's graph/meta + the requested view's source
 * (generated model / authored file / subset projection), builds the raw
 * `TrustInput`, and returns `TrustMap` plus a rendered `stampLine` + a
 * `farBehind` flag (both derived in code from `data.stamp`, never from the
 * client — spec §4's "far behind" rule and the stamp wording table live in
 * `git-stamp.ts`, not duplicated here).
 *
 * Caching (spec §5): the import/coverage/stamp half (`BaseInput` below) is
 * memoised per `(projHash, source, graph fingerprint, arch fingerprint,
 * generatedTs [generated only], CLAUDE.md overlay mtime, meta.last_indexed_ts,
 * HEAD)` — expensive graph/model reads and git subprocess calls happen once
 * per unique combination. Every part of that key exists to invalidate a
 * SPECIFIC staleness a narrower key missed (fix round 1, controller ruling):
 * a forced regenerate at the same fingerprint only bumps `generatedTs`, not
 * the fingerprint itself; the CLAUDE.md `§Architecture` overlay feeds
 * `projectArchitecture` for every view, independent of the graph's own
 * fingerprint; and `meta.last_indexed_ts` is subset's own `mapDate`, which a
 * content-identical reindex can bump without moving the graph fingerprint.
 * The citation re-check (`trust-citation.ts`) is NEVER part of that cache:
 * `buildTrustMap` is always called with a fresh `citationExists` closure, so
 * an edit to the working tree between two requests is always seen even on a
 * cache hit for everything else.
 */
import { stat } from "node:fs/promises";
import { join } from "node:path";
import type { Hono } from "hono";
import { computeRepoFingerprint, readArchModel } from "../../explain/arch-cache";
import {
  authoredUncommittedText,
  headCommit,
  isFarBehind,
  isValidSha,
  lastCommitForFile,
  type Relation,
  relationTo,
  safeRelation,
  stampText,
} from "../../repo-graph/git-stamp";
import { projectArchitecture } from "../../repo-graph/project-architecture";
import { readFingerprints, readGraph, readMeta } from "../../repo-graph/store";
import { citationExists } from "../../repo-graph/trust-citation";
import { resolvedImportPairs } from "../../repo-graph/trust-imports";
import {
  authoredContainers,
  authoredEdges,
  generatedContainers,
  generatedEdges,
  notShownFolders,
  subsetContainers,
  subsetEdges,
} from "../../repo-graph/trust-inputs";
import { buildTrustMap, type TrustInput, type TrustSource } from "../../repo-graph/trust-map";
import type { RepoGraphMeta } from "../../repo-graph/types";
import { ARCH_C4_FILENAME, loadAuthoredC4 } from "../../web/arch-c4-file";
import type { RepoGraphRouteDeps } from "./repo-graph";
import { type ActiveRepo, loadOverlay, resolveActiveRepo } from "./repo-graph-active";

/** The cacheable half of a `TrustInput` — everything except the two fields
 * that MUST be computed fresh per request (spec §5). */
type BaseInput = Omit<TrustInput, "citationExists" | "withListedFiles">;

const BASE_CACHE_MAX = 8;
const baseCache = new Map<string, BaseInput>();

function cacheGet(key: string): BaseInput | undefined {
  return baseCache.get(key);
}

function cacheSet(key: string, value: BaseInput): void {
  if (!baseCache.has(key) && baseCache.size >= BASE_CACHE_MAX) {
    const oldest = baseCache.keys().next().value;
    if (oldest !== undefined) baseCache.delete(oldest);
  }
  baseCache.set(key, value);
}

/** File paths of every `file`-type graph node — the repo-wide file list the
 * per-view input builders (`trust-inputs.ts`) use for the "(repo root)"
 * bucket total, independent of which files a container's members sample. */
function fileNodesOf(graph: Awaited<ReturnType<typeof readGraph>>): string[] {
  return graph.nodes.filter((n) => n.type === "file").map((n) => n.path);
}

/** `CLAUDE.md`'s mtime, or `"absent"` — part of the cache key (fix round 1):
 * every view's containers/folders come from `projectArchitecture(graph,
 * overlay, meta)`, so an edit to the `§Architecture` overlay must invalidate
 * the cache even when the graph fingerprint hasn't moved. */
async function overlayCacheKeyPart(projectRoot: string): Promise<string> {
  try {
    return String((await stat(join(projectRoot, "CLAUDE.md"))).mtimeMs);
  } catch {
    return "absent";
  }
}

/** The per-source part of a `BaseInput`: what differs between the three views. */
interface SourceShape {
  containers: BaseInput["containers"];
  edges: BaseInput["edges"];
  commit: string | null;
  mapDate: string;
}
type Proj = ReturnType<typeof projectArchitecture>;

function subsetShape(proj: Proj, meta: RepoGraphMeta): SourceShape {
  const commit = isValidSha(meta.head_commit) ? meta.head_commit : null;
  return { containers: subsetContainers(proj), edges: subsetEdges(proj), commit, mapDate: meta.last_indexed_ts };
}

async function generatedShape(
  active: ActiveRepo,
  meta: RepoGraphMeta,
  proj: Proj,
  graphFiles: string[],
): Promise<SourceShape | null> {
  const fingerprints = await readFingerprints(active.storage_dir);
  const fp = computeRepoFingerprint(fingerprints);
  const cached = await readArchModel(active.storage_dir, fp, meta.last_indexed_ts, active.project_root);
  if (!cached) return null;
  const commit = isValidSha(cached.meta.headCommit) ? cached.meta.headCommit : null;
  return {
    containers: generatedContainers(cached.model, proj, graphFiles),
    edges: generatedEdges(cached.model),
    commit,
    mapDate: cached.meta.generatedTs,
  };
}

async function authoredShape(active: ActiveRepo, proj: Proj, graphFiles: string[]): Promise<SourceShape | null> {
  const authored = await loadAuthoredC4(active.project_root);
  if (!authored.model) return null; // absent OR invalid — both read as "no map"
  const last = lastCommitForFile(active.project_root, ARCH_C4_FILENAME);
  const commit = last && isValidSha(last.commit) ? last.commit : null;
  const mapDate = last?.date ?? (await stat(join(active.project_root, ARCH_C4_FILENAME))).mtime.toISOString();
  return {
    containers: authoredContainers(authored.model, proj, graphFiles),
    edges: authoredEdges(authored.model),
    commit,
    mapDate,
  };
}

/** Build the per-view `BaseInput` (spec §3.1 + §4) — every I/O + git call
 * this route needs, none of it the live citation check. Returns null on the
 * two "no map for this view" cases (no generated cache; no authored file). */
async function computeBase(active: ActiveRepo, meta: RepoGraphMeta, source: TrustSource): Promise<BaseInput | null> {
  const graph = await readGraph(active.storage_dir);
  const overlay = await loadOverlay(active.project_root);
  const proj = projectArchitecture(graph, overlay, meta);
  const graphFiles = fileNodesOf(graph);
  const importPairs = resolvedImportPairs(graph, meta.anchorMap);
  const shape =
    source === "subset"
      ? subsetShape(proj, meta)
      : source === "generated"
        ? await generatedShape(active, meta, proj, graphFiles)
        : await authoredShape(active, proj, graphFiles);
  if (!shape) return null;
  const { containers, edges, commit, mapDate } = shape;
  const notShown = notShownFolders(proj, containers);
  const rel = safeRelation(relationTo(active.project_root, commit));
  return {
    source,
    containers,
    edges,
    importPairs,
    notShown,
    stamp: { mapDate, commit, commitsAhead: rel.count, headRelation: rel.relation },
  };
}

/** `computeBase` behind the memo (spec §5's cache key). A cache MISS still
 * reads the arch-model / authored-file cache twice (once here for the key,
 * once inside `computeBase`) — both reads are small local-disk/`git` calls on
 * a localhost daemon; the duplication buys a key that changes whenever the
 * underlying model or authored file actually changes, not just when the
 * indexed graph does. */
async function cachedBase(active: ActiveRepo, meta: RepoGraphMeta, source: TrustSource): Promise<BaseInput | null> {
  const fingerprints = await readFingerprints(active.storage_dir);
  const graphFp = computeRepoFingerprint(fingerprints);
  const head = headCommit(active.project_root) ?? "no-git";
  const overlayFp = await overlayCacheKeyPart(active.project_root);

  // `archFp` (fix round 1): the fingerprint ALONE under-discriminates for
  // `generated` — `arch-generate.ts` writes `computeRepoFingerprint(fingerprints)`
  // as `meta.fingerprint`, i.e. it equals `graphFp` above, so a forced
  // regenerate at the same HEAD (same fingerprint, new `generatedTs` +
  // possibly new containers/edges) would otherwise be invisible to the key.
  // `generatedTs` is appended so a regenerate always gets a fresh cache slot.
  let archFp = "";
  if (source === "generated") {
    const cached = await readArchModel(active.storage_dir, graphFp, meta.last_indexed_ts, active.project_root);
    archFp = cached ? `${cached.meta.fingerprint}\u0001${cached.meta.generatedTs}` : "none";
  } else if (source === "authored") {
    // mtime, not the last commit SHA: an uncommitted edit to the authored
    // file must invalidate the cache too (the file is read live, unlike the
    // generated model — spec §5's "always seen" promise isn't only about the
    // citation re-check for this view).
    try {
      archFp = String((await stat(join(active.project_root, ARCH_C4_FILENAME))).mtimeMs);
    } catch {
      archFp = "absent";
    }
  }

  const key = [meta.proj_hash, source, graphFp, archFp, head, overlayFp, meta.last_indexed_ts].join("\u0000");
  const hit = cacheGet(key);
  if (hit) return hit;
  const base = await computeBase(active, meta, source);
  if (base) cacheSet(key, base);
  return base;
}

/** Mount `GET /api/repo-graph/arch/trust` on `app`. `resolveActiveRepo` +
 * `loadOverlay` are imported directly from the sibling `./repo-graph-active`
 * module (not `./repo-graph`, and not injected) — `repo-graph.tsx` imports
 * `mountRepoGraphTrustRoute` FROM this file to mount it, so this file
 * importing anything back from `./repo-graph` as a VALUE would be an import
 * cycle (`audit:cycles`); `./repo-graph-active` has no dependency on either
 * this file or `repo-graph.tsx`, so there is nothing left to inject. */
export function mountRepoGraphTrustRoute(app: Hono, deps: RepoGraphRouteDeps): void {
  app.get("/api/repo-graph/arch/trust", async (c) => {
    const source = c.req.query("source");
    if (source !== "generated" && source !== "authored" && source !== "subset") {
      return c.json({ success: false, error: "bad source" }, 400);
    }
    const active = await resolveActiveRepo(c.req.query("repo"), deps);
    if (!active) return c.json({ success: false, error: "repo not indexed" }, 404);
    const meta = await readMeta(active.storage_dir);
    if (!meta) return c.json({ success: false, error: "graph not found" }, 404);
    const base = await cachedBase(active, meta, source);
    if (!base) return c.json({ success: false, error: "no_map" }, 404);

    const root = active.project_root;
    const data = buildTrustMap({
      ...base,
      citationExists: (f, l) => citationExists(root, f, l),
      withListedFiles: c.req.query("appendix") === "1",
    });
    const rel: Relation = { relation: data.stamp.headRelation, count: data.stamp.commitsAhead };
    // Authored + never-committed reads as `not-recorded` too (spec §4), but the
    // generic wording says "regenerate" — meaningless for a hand-authored file
    // (controller ruling: commit it instead). Generated/subset keep the spec text.
    const stampLine =
      source === "authored" && data.stamp.headRelation === "not-recorded"
        ? authoredUncommittedText(data.stamp.mapDate)
        : stampText(data.stamp.mapDate, data.stamp.commit, rel);
    return c.json({ success: true, data: { ...data, stampLine, farBehind: isFarBehind(rel) }, error: null });
  });
}
