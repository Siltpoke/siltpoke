// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
// Copyright (c) 2026 Jiaqi Duan
/**
 * Aggregate the repo-graph into a C4
 * super-group + subdir-node view, with cross-subdir import counts.
 *
 * Two modes:
 *
 *   rich     — `ArchitectureOverlay` is non-null (parsed from
 *              CLAUDE.md §Architecture). Panels = overlay's super-groups.
 *              Subdirs declared in overlay are rendered with their
 *              purpose strings (even when fileCount is 0). Files map to the
 *              DEEPEST declared container that prefixes them (so an overlay
 *              declaring a depth-3 path counts its files correctly, not at a
 *              hardcoded depth-2). Subdirs present in the graph but missing
 *              from the overlay are gathered under a synthetic "Other" panel
 *              so the user never loses visibility on drift.
 *
 *   degraded — overlay is null. Containers are derived purely structurally by
 *              `deriveContainers` (branch-point descent +
 *              gap-descend) — ZERO hardcoded root/framework names. One panel per
 *              derived container; purpose strings empty. This replaces the old
 *              `WELL_KNOWN_ROOTS` single-root fallback that collapsed real
 *              monorepos (e.g. a backend+frontend split) to a single box.
 *
 * Cross-subdir import-count aggregation collapses the index's per-file
 * "imports" edges into subdir-pair counters. Relative target paths are
 * resolved against the source file's directory; same-subdir imports +
 * external bare specifiers (`hono`, `node:fs`, etc.) are skipped.
 */
import type { ArchitectureOverlay } from "./architecture-parser";
import { containerForPath, deriveContainers } from "./bucketing";
import { buildFileIndex, resolveImportTarget } from "./import-resolver";
import type { AnchorMap, RepoGraph } from "./types";

export type AggregationMode = "rich" | "degraded";

export interface Panel {
  name: string;
  subdirPaths: string[];
}

export interface SubdirNode {
  /** Repo-relative subdir path with trailing slash (e.g. "src/brain/"). */
  path: string;
  /** One-line purpose from CLAUDE.md overlay; empty in degraded mode. */
  purpose: string;
  /** Count of file nodes whose path begins with this subdir. */
  fileCount: number;
  /** Name of the super-group panel this subdir is rendered in. */
  superGroup: string;
}

export interface AggregatedEdge {
  /** Subdir path (trailing slash). */
  source: string;
  /** Subdir path (trailing slash). */
  target: string;
  /** Distinct import statements crossing this subdir pair, in this direction. */
  count: number;
}

export interface AggregatedGraph {
  mode: AggregationMode;
  panels: Panel[];
  subdirNodes: SubdirNode[];
  aggregatedEdges: AggregatedEdge[];
}

const OTHER_PANEL = "Other";

/**
 * Derive a subdir bucket key (with trailing slash) for a file path at the
 * fixed top-2 depth. For `src/brain/foo.ts` → `src/brain/`. Files NOT under a
 * recognized top-level segment fall through; returns null for empty /
 * dot-prefixed paths or a `rootHint` mismatch.
 *
 * KEPT for two consumers only: (1) rich-mode ORPHAN bucketing (a file under
 * the overlay root but not under any declared container → its depth-2 bucket
 * surfaces in the "Other" panel as drift); (2) the readout keyspace in
 * `src/explain/subdir-resolve.ts` (member→subdir resolution for ground/drill).
 * The degraded path no longer uses it — it derives containers structurally.
 */
export function fileToSubdir(path: string, rootHint?: string): string | null {
  if (!path || path.startsWith(".")) return null;
  const segments = path.split("/");
  if (segments.length < 2) return null;
  const root = segments[0]!;
  if (rootHint && root !== rootHint) {
    // Filter to a single root in rich mode so out-of-root top-level
    // directories (`scripts/`, `tests/`, etc.) don't surface as orphans.
    return null;
  }
  return `${root}/${segments[1]!}/`;
}

/**
 * Derive a "primary root" for rich-mode aggregation by inspecting the
 * overlay's declared subdir paths. If every overlay path shares the
 * same top-level segment (e.g. `src/`), that segment is the root —
 * files OUTSIDE this root (e.g. `tests/`, `scripts/`, `docs/`) are
 * excluded from aggregation so the C4 view stays focused on
 * production code. When overlay paths span multiple roots, returns
 * undefined and no filtering is applied.
 */
function deriveRichRoot(overlay: ArchitectureOverlay): string | undefined {
  const roots = new Set<string>();
  for (const group of overlay.superGroups) {
    for (const entry of group.subdirs) {
      const first = entry.path.split("/")[0];
      if (first) roots.add(first);
    }
  }
  return roots.size === 1 ? [...roots][0] : undefined;
}

/** Repo-relative paths of every `file` node in the graph. */
function graphFilePaths(graph: RepoGraph): string[] {
  const out: string[] = [];
  for (const node of graph.nodes) {
    if (node.type === "file") out.push(node.path);
  }
  return out;
}

/**
 * Build the active mode's file→container resolver.
 *
 *   degraded — map each file to its deepest derived container (or null);
 *              no root concept (`root` undefined).
 *   rich     — map each file to the deepest DECLARED overlay container, else
 *              its depth-2 bucket (so an in-root orphan still surfaces in
 *              "Other"). The `root` filter is NOT applied inside `resolve` —
 *              it is applied by the caller at the file-count + source sites
 *              ONLY (out-of-root files are excluded from panels/counts), while
 *              edge TARGETS stay unfiltered. This mirrors the earlier
 *              behavior exactly: counts/source root-filtered, targets not.
 *
 * `degradedContainers` is the sorted derived container list (degraded only),
 * used to seed the panel grid; null in rich mode.
 */
function makeResolveContainer(
  graph: RepoGraph,
  overlay: ArchitectureOverlay | null,
): {
  resolve: (path: string) => string | null;
  root: string | undefined;
  degradedContainers: string[] | null;
} {
  if (!overlay) {
    const { containers } = deriveContainers(graphFilePaths(graph));
    return {
      resolve: (path) => containerForPath(path, containers),
      root: undefined,
      degradedContainers: containers,
    };
  }
  const root = deriveRichRoot(overlay);
  const declared: string[] = [];
  for (const group of overlay.superGroups) {
    for (const entry of group.subdirs) declared.push(entry.path);
  }
  return {
    resolve: (path) => containerForPath(path, declared) ?? fileToSubdir(path),
    root,
    degradedContainers: null,
  };
}

export function aggregateBySuperGroup(
  graph: RepoGraph,
  overlay: ArchitectureOverlay | null,
  anchorMap?: AnchorMap,
): AggregatedGraph {
  const mode: AggregationMode = overlay ? "rich" : "degraded";
  const { resolve, root, degradedContainers } = makeResolveContainer(graph, overlay);
  // Rich mode excludes out-of-root files from panels + counts (and from edge
  // SOURCES); degraded has no root → no exclusion.
  const inScope = (path: string): boolean => !root || path.startsWith(`${root}/`);

  // File count per container.
  const fileCountBySubdir = new Map<string, number>();
  for (const node of graph.nodes) {
    if (node.type !== "file") continue;
    if (!inScope(node.path)) continue;
    const subdir = resolve(node.path);
    if (subdir === null) continue;
    fileCountBySubdir.set(subdir, (fileCountBySubdir.get(subdir) ?? 0) + 1);
  }

  // Assemble panels + subdir nodes.
  const panels: Panel[] = [];
  const subdirNodes: SubdirNode[] = [];
  const subdirToGroup = new Map<string, string>();

  if (overlay) {
    // Rich mode: walk overlay's super-groups in declared order.
    for (const group of overlay.superGroups) {
      const panel: Panel = { name: group.name, subdirPaths: [] };
      for (const entry of group.subdirs) {
        const fileCount = fileCountBySubdir.get(entry.path) ?? 0;
        subdirNodes.push({
          path: entry.path,
          purpose: entry.purpose,
          fileCount,
          superGroup: group.name,
        });
        panel.subdirPaths.push(entry.path);
        subdirToGroup.set(entry.path, group.name);
      }
      panels.push(panel);
    }
    // Any container in the graph not declared in the overlay → "Other" panel.
    const orphanSubdirs = [...fileCountBySubdir.keys()]
      .filter((s) => !subdirToGroup.has(s))
      .sort();
    if (orphanSubdirs.length > 0) {
      const otherPanel: Panel = { name: OTHER_PANEL, subdirPaths: [...orphanSubdirs] };
      for (const subdir of orphanSubdirs) {
        subdirNodes.push({
          path: subdir,
          purpose: "",
          fileCount: fileCountBySubdir.get(subdir) ?? 0,
          superGroup: OTHER_PANEL,
        });
        subdirToGroup.set(subdir, OTHER_PANEL);
      }
      panels.push(otherPanel);
    }
  } else {
    // Degraded mode: one panel per derived container (sorted, structural).
    for (const subdir of degradedContainers ?? []) {
      panels.push({ name: subdir, subdirPaths: [subdir] });
      subdirNodes.push({
        path: subdir,
        purpose: "",
        fileCount: fileCountBySubdir.get(subdir) ?? 0,
        superGroup: subdir,
      });
      subdirToGroup.set(subdir, subdir);
    }
  }

  // Build path → container map for edge resolution, + the file index the
  // import resolver matches raw targets against.
  const pathToSubdir = new Map<string, string>();
  const fileIndex = buildFileIndex(graph);
  for (const node of graph.nodes) {
    if (node.type !== "file") continue;
    if (!inScope(node.path)) continue; // edge SOURCES are root-filtered
    const subdir = resolve(node.path);
    if (subdir !== null) pathToSubdir.set(node.path, subdir);
  }

  // Aggregate cross-subdir import counts.
  const edgeCounts = new Map<string, AggregatedEdge>();
  for (const edge of graph.edges) {
    if (edge.type !== "imports") continue;
    const sourceFileMatch = /^file:([^:]+):$/.exec(edge.source);
    if (!sourceFileMatch) continue;
    const sourceFilePath = sourceFileMatch[1]!;
    const sourceSubdir = pathToSubdir.get(sourceFilePath);
    if (!sourceSubdir) continue;
    const targetFile = resolveImportTarget(sourceFilePath, edge.target, fileIndex, anchorMap);
    const targetSubdir = targetFile ? resolve(targetFile) : null;
    if (!targetSubdir) continue;
    if (sourceSubdir === targetSubdir) continue; // intra-subdir
    const key = `${sourceSubdir}->${targetSubdir}`;
    const existing = edgeCounts.get(key);
    if (existing) {
      existing.count += 1;
    } else {
      edgeCounts.set(key, { source: sourceSubdir, target: targetSubdir, count: 1 });
    }
  }

  return {
    mode,
    panels,
    subdirNodes,
    aggregatedEdges: [...edgeCounts.values()],
  };
}
