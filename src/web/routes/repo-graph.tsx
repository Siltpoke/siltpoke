// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
// Copyright (c) 2026 Jiaqi Duan
/** @jsxImportSource hono/jsx */
/**
 * SSR route for `/repo-graph`.
 *
 * Server-side concerns:
 *   1. Resolve the active repo (?repo= query param > current cwd's proj_hash).
 *   2. Enumerate all indexed repos for the picker.
 *   3. Load the active repo's graph.json + parse CLAUDE.md §Architecture.
 *   4. Aggregate into rich/degraded panels + cross-subdir edges.
 *   5. Render the SSR shell with the initial payload baked in; the
 *      Alpine island (`repoGraph` registered in islands/repo-graph.ts)
 *      hydrates from `data-initial`.
 *
 * Route does NOT shell out to the daemon's `/api/repo-graph/*` JSON
 * endpoints — it computes everything in-process for the initial render.
 * The island uses those endpoints for drill-down + search after hydration.
 */
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { Context, Hono } from "hono";
import { Layout } from "../_shared/layout";
import { loadAuthoredC4 } from "../arch-c4-file";
import { RepoGraph } from "../screens/RepoGraph";
import {
  aggregateBySuperGroup,
  type AggregatedGraph,
} from "../../repo-graph/aggregator";
import { parseArchitectureSection } from "../../repo-graph/architecture-parser";
import {
  type ArchitectureProjection,
  projectArchitecture,
} from "../../repo-graph/project-architecture";
import {
  enumerateRepos,
  resolveRepoByHash,
  type RepoEntry,
} from "../../repo-graph/repo-registry";
import { resolveRepoGraphLocation } from "../../repo-graph/proj-hash";
import { readFingerprints, readGraph, readMeta } from "../../repo-graph/store";
import { computeFileFunctions, computeRepoFingerprint, readArchModel } from "../../explain/arch-cache";
import { emptyGraph } from "../../repo-graph/types";
import {
  type BootBuild,
  computeStaleness,
  type GitProbe,
  makeGitProbe,
  readBootBuild,
  stalenessBannerSignal,
} from "../../daemon/build-state";

export interface RepoGraphWebRouteDeps {
  cwd: string;
  home?: string;
  /**
   * Daemon-staleness seam. The SSR strip mirrors /api/daemon-health:
   * computed in-process at page render (same convention as the rest of this route).
   * Injectable so the SSR test can drive all three states deterministically;
   * production defaults to the cached boot value + a real git probe.
   */
  readBootBuild?: () => BootBuild;
  gitProbe?: GitProbe;
  /**
   * Daemon secret, embedded into the same-origin page so the island can send it
   * on the mutating `POST /index` + `/cancel`. Same-origin only: a
   * cross-origin drive-by page cannot read this page's DOM (SOP), so it acts as
   * the CSRF token that the read-only GETs don't need.
   */
  secret?: string;
}

async function readClaudeMd(projectRoot: string | null): Promise<string | null> {
  if (!projectRoot) return null;
  const path = join(projectRoot, "CLAUDE.md");
  if (!existsSync(path)) return null;
  try {
    return await readFile(path, "utf8");
  } catch {
    return null;
  }
}

/** Where the active repo's artifacts live + its project root (null = unindexed). */
interface ActiveRepoLocation {
  storageDir: string | null;
  projectRoot: string | null;
}

/**
 * Resolve the active repo's storage dir + project root. `?repo=` wins; else the
 * current cwd's proj_hash. resolveRepoByHash honors SILTPOKE_HOME (same path the
 * JSON API uses) — a ~/.siltpoke fallback would read the wrong home for ?repo=.
 */
async function resolveActiveRepo(
  activeProjHash: string,
  repos: RepoEntry[],
  cwd: string,
  home?: string,
): Promise<ActiveRepoLocation> {
  const currentLocation = resolveRepoGraphLocation(cwd, { home });
  const matchingRepo = repos.find((r) => r.proj_hash === activeProjHash);
  if (matchingRepo) {
    const loc = await resolveRepoByHash(activeProjHash, { home });
    if (loc) {
      return { storageDir: loc.storage_dir, projectRoot: loc.project_root ?? matchingRepo.project_root };
    }
  } else if (activeProjHash === currentLocation.proj_hash) {
    return { storageDir: currentLocation.storage_dir, projectRoot: currentLocation.project_root };
  }
  return { storageDir: null, projectRoot: null };
}

/**
 * Build the id-keyed ArchitectureProjection baked into the SSR payload (no
 * second client request for the initial render). When the repo has no persisted
 * meta (not indexed) returns an empty projection → "No graph indexed" state.
 */
interface BuildProjectionInput {
  graph: ReturnType<typeof emptyGraph>;
  overlay: ReturnType<typeof parseArchitectureSection> | null;
  meta: Awaited<ReturnType<typeof readMeta>>;
  activeProjHash: string;
  projectRoot: string | null;
}

function buildProjection({ graph, overlay, meta, activeProjHash, projectRoot }: BuildProjectionInput): ArchitectureProjection {
  if (meta) return projectArchitecture(graph, overlay, meta);
  return {
    repo: {
      id: activeProjHash,
      name: projectRoot ? (projectRoot.split("/").filter(Boolean).pop() ?? "") : "",
      path: projectRoot ?? "",
      files: 0,
      symbols: 0,
      edges: 0,
      lastIndexedTs: "",
      building: false,
      groupingMode: "fallback",
    },
    groups: [],
    subdirs: [],
    edges: [],
  };
}

/** SSR handler for GET /repo-graph — resolve repo, load graph, render shell. */
async function renderRepoGraphPage(c: Context, deps: RepoGraphWebRouteDeps) {
  const { cwd, home, secret } = deps;
  const repos: RepoEntry[] = await enumerateRepos({ home });
  // Default/dead-hash resolution against the SAME ordered list the picker
  // shows (enumerateRepos carries the single shared comparator — recency
  // first). Three cases when the requested hash is not in the indexed list:
  //   ?repo=<dead>  + repos exist → 302 to clean /repo-graph (URL must not
  //                                 keep a dead hash — share/refresh honesty);
  //   no param, dead cwd + repos  → fall back to repos[0] (the list top the
  //                                 user actually sees in the dropdown);
  //   repos empty                 → keep the requested hash; the existing
  //                                 "No graph indexed → /siltpoke-index" empty
  //                                 state renders (unchanged behavior).
  const queryRepo = c.req.query("repo");
  const requestedHash = queryRepo ?? resolveRepoGraphLocation(cwd, { home }).proj_hash;
  const requestedIsIndexed = repos.some((r) => r.proj_hash === requestedHash);
  if (queryRepo !== undefined && !requestedIsIndexed && repos.length > 0) {
    return c.redirect("/repo-graph", 302);
  }
  const activeProjHash =
    // `!` safe: this branch requires !requestedIsIndexed AND repos.length > 0.
    requestedIsIndexed || repos.length === 0 ? requestedHash : repos[0]!.proj_hash;
  const { storageDir, projectRoot } = await resolveActiveRepo(activeProjHash, repos, cwd, home);

  const graph = storageDir ? await readGraph(storageDir) : emptyGraph();
  const meta = storageDir ? await readMeta(storageDir) : null;
  const claudeMd = await readClaudeMd(projectRoot);
  const overlay = claudeMd ? parseArchitectureSection(claudeMd) : null;
  const aggregated: AggregatedGraph = aggregateBySuperGroup(graph, overlay, meta?.anchorMap);

  const projection = buildProjection({ graph, overlay, meta, activeProjHash, projectRoot });
  const stats = { files: projection.repo.files, symbols: projection.repo.symbols, edges: projection.repo.edges };

  // Load any cached LLM-derived model so a generated repo opens
  // straight to its C4 (the island adapts the doc → C4Model). Stale (source
  // changed) is surfaced so the UI offers re-generate instead of serving it fresh.
  let generatedModel: Awaited<ReturnType<typeof readArchModel>> = null;
  // Per-member-file function counts, computed from the
  // already-read graph for the union of the doc's member paths. Measured ≤3.6KB
  // worst case (bounded by member entries, not repo size) — first-paint-correct
  // badges, no lazy fetch.
  let fileFunctions: Record<string, number> | null = null;
  if (storageDir && meta) {
    const fingerprints = await readFingerprints(storageDir);
    generatedModel = await readArchModel(storageDir, computeRepoFingerprint(fingerprints), meta.last_indexed_ts);
    if (generatedModel) fileFunctions = computeFileFunctions(graph, generatedModel.model.nodes);
  }

  // Authored model loads from the TARGET repo's
  // `.siltpoke/arch-c4.json` (Zod-validated; detection = file present, never a
  // repo-name check). Invalid file → null model + a visible fail-soft banner.
  const authored = await loadAuthoredC4(projectRoot);

  // Daemon-staleness strip — mirrors /api/daemon-health
  // in-process. bootSha is the cached boot value; commitsBehind is derived per
  // render via a cheap local git op. Any git error degrades to "unknown" (no
  // strip), never breaks the page. Only state "behind"
  // produces a banner; "current"/"unknown" → null → no strip.
  const stalenessBanner = ((): string | null => {
    const getBoot = deps.readBootBuild ?? readBootBuild;
    const probe = deps.gitProbe ?? makeGitProbe();
    try {
      const { bootSha } = getBoot();
      const { commitsBehind, state } = computeStaleness(bootSha, probe.headSha(), probe);
      const signal = stalenessBannerSignal(state, commitsBehind);
      return signal.show ? signal.line : null;
    } catch {
      // Request-time git error → degrade to no strip, never crash the render.
      return null;
    }
  })();

  // The repoGraph island is plain vanilla (cytoscape dropped) and
  // ships in the main client bundle (index.ts) — no lazy chunk, no preload.
  return c.html(
    <Layout title="code map · siltpoke">
      <RepoGraph
        projection={projection}
        repoEntries={repos}
        currentProjHash={activeProjHash}
        stalenessBanner={stalenessBanner}
        stats={stats}
        secret={secret}
        generatedModel={generatedModel ? {
          doc: generatedModel.model,
          groundedPct: generatedModel.meta.groundedPct,
          stale: generatedModel.stale,
          fileFunctions,
          // Include generatedTs + durationMs for the modal metadata line.
          generatedTs: generatedModel.meta.generatedTs,
          durationMs: generatedModel.meta.durationMs,
          costUsd: generatedModel.meta.costUsd,
          // Grounding counts — optional; absent on legacy caches (no fabrication).
          citedClaims: generatedModel.meta.citedClaims,
          totalClaims: generatedModel.meta.totalClaims,
          topologyBlindClaims: generatedModel.meta.topologyBlindClaims,
        } : null}
        authoredModel={authored.model}
        authoredInvalid={authored.invalid}
      />
    </Layout>,
  );
}

export function mountRepoGraphWebRoutes(app: Hono, deps: RepoGraphWebRouteDeps): void {
  app.get("/repo-graph", (c) => renderRepoGraphPage(c, deps));
}
