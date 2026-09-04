// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
// Copyright (c) 2026 Jiaqi Duan
/**
 * Projection layer (data-contract `ArchitectureProjection`).
 *
 * Reshapes the raw symbol-level `RepoGraph` (already collapsed to a
 * super-group + subdir-node view by `aggregateBySuperGroup`) into the exact
 * wire shape the `/repo-graph` dashboard consumes:
 *
 *   { repo, groups[{id,title,short,accent}],
 *     subdirs[{id,group,files,purpose,inbound,outbound}],
 *     edges[{source,target,weight}] }
 *
 * Group ids/accents are DERIVED, not hardcoded, so other repos render
 * (group-agnostic). Accents cycle a fixed warm palette in panel
 * order; the prototype's 4 colors lead it (Core=terra, State=moss,
 * Surfaces=sky, Infra=amber).
 */
import { homedir } from "node:os";
import { aggregateBySuperGroup } from "./aggregator";
import { computeContainerStats } from "./container-stats";
import type { ArchitectureOverlay } from "./architecture-parser";
import { emptyCounters, type RepoGraph, type RepoGraphMeta } from "./types";
import { tokens } from "../web/tokens/tokens";

/**
 * Warm-palette accents, cycled by panel order. Leads with the prototype 4.
 *
 * The first 4 are `tokens.color.*` (final dark-mode branch review,
 * Important 3) — until 2026-08-03 these were hardcoded hex literals
 * byte-identical to the LIGHT-mode value of those same 4 tokens, so a group's
 * accent stayed pinned to light-mode terra/moss/sky/amber even when the
 * dashboard itself was in dark mode (this value reaches the page as `accent`
 * inside the `data-initial` JSON — see RepoGraph.tsx — and is painted
 * directly by the client island's `cssAlpha`/`style="background:${accent}"`
 * sites, both of which resolve a `var(--color-x)` string exactly like a hex
 * one; this is a plain-data module with no JSX, but that's a resolution
 * detail of the CONSUMER, not a reason the color has to be a literal here).
 * `cssAlpha`'s own docstring (src/web/client/islands/repo-graph.ts) already
 * treats its `color` parameter as "any valid CSS <color> the caller has in
 * hand", so swapping a hex literal for a token string here needs no change
 * on that side.
 *
 * The last 2 (violet/teal, "overflow" — only hit when a repo has 5+
 * super-groups) stay literal: their hex does NOT match either brand
 * `tokens.color.violet` (#9d86c2) or `tokens.color.teal` (#5e9ca3) — they
 * were chosen as a visually-distinct 5th/6th hue, not derived from the brand
 * accents — so there is no token to swap in without silently changing the
 * rendered color. Allowlisted in .lint-colors-allowlist.json; they remain a
 * real, open theme-blindness gap for the rare 5-6-group case, not something
 * this fix closes.
 */
const GROUP_ACCENTS = [
  tokens.color.terra, // terra  (Core)
  tokens.color.moss,  // moss   (State)
  tokens.color.sky,   // sky    (Surfaces)
  tokens.color.amber, // amber  (Infra)
  "#b88ad9",          // violet (overflow) — no token match, see docstring above
  "#5ec8c0",          // teal   (overflow) — no token match, see docstring above
] as const;

export interface ProjectionGroup {
  /** Slug derived from the panel name's first token, e.g. "core". */
  id: string;
  /** Full panel name, e.g. "Core LLM + orchestration". */
  title: string;
  /** First token, e.g. "Core". */
  short: string;
  /** Hex accent. */
  accent: string;
}

export interface ProjectionSubdir {
  /** Path segment under the root, e.g. "explain" (from "src/explain/"). */
  id: string;
  /** Owning group id. */
  group: string;
  /** Full container path, e.g. "src/explain/" or "backend/apps/ledger/". Drives
   * the honest-subset degraded first-segment band grouping (path.split("/")[0]).
   * Additive — the projection's own grouping does not use it. */
  path: string;
  /** File-node count in this subdir. */
  files: number;
  /** Function-node count in this subdir (literal; no interpretation). */
  funcCount: number;
  /** Filenames appearing >1× in this subdir, count desc. Names are data. */
  recurringBasenames: Array<{ name: string; count: number }>;
  /** Authored one-liner from CLAUDE.md; "" if none. */
  purpose: string;
  /** Total import weight INTO this subdir (↓in badge). */
  inbound: number;
  /** Total import weight OUT of this subdir (↑out badge). */
  outbound: number;
}

export interface ProjectionEdge {
  /** Importer subdir id. */
  source: string;
  /** Imported subdir id. */
  target: string;
  /** Count of import statements crossing source→target (>0). */
  weight: number;
}

export interface ArchitectureProjection {
  repo: {
    id: string;
    name: string;
    path: string;
    files: number;
    symbols: number;
    edges: number;
    lastIndexedTs: string;
    building: boolean;
    /**
     * How the super-group bands were derived:
     * "semantic" = a real `CLAUDE.md §Architecture` overlay drove the grouping;
     * "fallback" = degraded mode, one band per immediate top-level dir.
     * The honest-subset reads this only to label band intent — it does NOT
     * gate the arch source (ungenerated repos always render the subset).
     */
    groupingMode: "semantic" | "fallback";
  };
  groups: ProjectionGroup[];
  subdirs: ProjectionSubdir[];
  edges: ProjectionEdge[];
}

/** "src/explain/" → "explain"; "lib/foo/" → "foo". Last non-empty segment. */
export function subdirId(path: string): string {
  const segments = path.replace(/\/+$/, "").split("/").filter(Boolean);
  return segments.length ? segments[segments.length - 1]! : path;
}

/**
 * Resolve a FILE PATH to its projection bucket id by the keyspace's OWN
 * definition: a bucket claims a file iff the file path starts with the
 * bucket's path; longest prefix wins (nested buckets). `null` when no bucket
 * claims the path — an honest-zero, NEVER a path-shape guess (the daemon's
 * old "segment after the root" heuristic returned filenames for top-level
 * repos like plc's `scripts/x.py` → 0-file drill targets).
 */
export function bucketIdOfPath(
  subdirs: ReadonlyArray<Pick<ProjectionSubdir, "id" | "path">>,
  filePath: string,
): string | null {
  let best: { id: string; len: number } | null = null;
  for (const s of subdirs) {
    if (!s.path) continue;
    const prefix = s.path.endsWith("/") ? s.path : `${s.path}/`;
    if (filePath.startsWith(prefix) && (!best || prefix.length > best.len)) {
      best = { id: s.id, len: prefix.length };
    }
  }
  return best?.id ?? null;
}

/**
 * Panel name → group slug. Rich-mode names are human strings
 * ("Core LLM + orchestration" → id "core"). Degraded-mode names are subdir
 * paths ("src/foo/" → id "foo") — use the last segment so each child gets a
 * distinct group rather than all collapsing onto "src".
 */
function groupSlug(panelName: string): { id: string; short: string } {
  // Degraded-mode panels are bare paths ("src/foo/"): no whitespace, slashed.
  // Rich-mode human names may contain slashes too ("State / persistence") but
  // always carry whitespace — so a path is "slashed AND space-free".
  const pathLike = !/\s/.test(panelName) && panelName.includes("/");
  if (pathLike) {
    const id = subdirId(panelName);
    return { id, short: id };
  }
  const firstToken = panelName.split(/\s+/).filter(Boolean)[0] ?? panelName;
  return { id: firstToken.toLowerCase(), short: firstToken };
}

function collapseTilde(absPath: string): string {
  const home = homedir();
  return absPath.startsWith(home) ? `~${absPath.slice(home.length)}` : absPath;
}

function basename(absPath: string): string {
  const segments = absPath.replace(/\/+$/, "").split("/").filter(Boolean);
  return segments.length ? segments[segments.length - 1]! : absPath;
}

/**
 * Build the architecture-level projection for one repo.
 *
 * @param graph   raw repo graph (`readGraph(storage_dir)`)
 * @param overlay parsed CLAUDE.md §Architecture (null → degraded mode)
 * @param meta    repo meta (`readMeta(storage_dir)`) — drives the `repo` block
 */
export function projectArchitecture(
  graph: RepoGraph,
  overlay: ArchitectureOverlay | null,
  meta: RepoGraphMeta,
): ArchitectureProjection {
  const aggregated = aggregateBySuperGroup(graph, overlay, meta.anchorMap);

  // Groups: one per panel, accent cycled by order, deduped by derived id so
  // collisions (two panels whose first token slugs identically) keep the
  // first-seen accent rather than spawning duplicate group rows.
  const groups: ProjectionGroup[] = [];
  const groupIdByPanel = new Map<string, string>();
  const seenGroupIds = new Set<string>();
  aggregated.panels.forEach((panel, i) => {
    const { id, short } = groupSlug(panel.name);
    groupIdByPanel.set(panel.name, id);
    if (seenGroupIds.has(id)) return;
    seenGroupIds.add(id);
    groups.push({
      id,
      title: panel.name,
      short,
      accent: GROUP_ACCENTS[i % GROUP_ACCENTS.length]!,
    });
  });

  // Edges: subdir-path endpoints → subdir ids, weight = aggregated count.
  const edges: ProjectionEdge[] = aggregated.aggregatedEdges.map((e) => ({
    source: subdirId(e.source),
    target: subdirId(e.target),
    weight: e.count,
  }));

  // Inbound/outbound weight sums per subdir id.
  const inbound = new Map<string, number>();
  const outbound = new Map<string, number>();
  for (const e of edges) {
    outbound.set(e.source, (outbound.get(e.source) ?? 0) + e.weight);
    inbound.set(e.target, (inbound.get(e.target) ?? 0) + e.weight);
  }

  const containerStats = computeContainerStats(
    graph,
    aggregated.subdirNodes.map((s) => s.path),
  );

  const subdirs: ProjectionSubdir[] = aggregated.subdirNodes.map((s) => {
    const id = subdirId(s.path);
    const st = containerStats.get(s.path);
    return {
      id,
      group: groupIdByPanel.get(s.superGroup) ?? groupSlug(s.superGroup).id,
      path: s.path,
      files: s.fileCount,
      funcCount: st?.funcCount ?? 0,
      recurringBasenames: st?.recurringBasenames ?? [],
      purpose: s.purpose,
      inbound: inbound.get(id) ?? 0,
      outbound: outbound.get(id) ?? 0,
    };
  });

  // Defensive: a hand-edited or pre-schema meta may lack counters;
  // fall back to zeros instead of throwing (which 500s the whole SSR page).
  const counters = meta.counters ?? emptyCounters();
  const c = counters.nodes;
  const projectRoot = meta.project_root;
  return {
    repo: {
      id: meta.proj_hash,
      name: basename(projectRoot),
      path: collapseTilde(projectRoot),
      files: c.file,
      symbols: c.function + c.class + c.module + c.symbol,
      edges: counters.edges.imports,
      lastIndexedTs: meta.last_indexed_ts,
      building: meta.building ?? false,
      groupingMode:
        overlay != null && overlay.superGroups.length > 0 ? "semantic" : "fallback",
    },
    groups,
    subdirs,
    edges,
  };
}
