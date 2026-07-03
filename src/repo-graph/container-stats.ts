// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Copyright (c) 2026 Jiaqi Duan
/**
 * Per-container LITERAL structural counts for the honest-subset view.
 *
 * Reports only what the index literally holds — file count, function count, and
 * recurring filenames (a name appearing >1× within the container). It assigns
 * NO meaning: a basename like a route-leaf filename reaches the result only as a
 * value read from `node.name`, never as a string written here. Whatever a repo
 * nests surfaces; the tool recognizes none of it. Semantic naming is the
 * generated model's job, not this module's (two-layer discipline).
 *
 * Reuses `containerForPath` so `fileCount` matches the aggregator's counts.
 */
import { containerForPath } from "./bucketing";
import type { RepoGraph } from "./types";

export interface ContainerStats {
  fileCount: number;
  funcCount: number;
  /** Filenames appearing >1× in the container, count desc, capped at `topN`. */
  recurringBasenames: Array<{ name: string; count: number }>;
}

const DEFAULT_TOP_N = 4;

interface Tally {
  files: Map<string, number>;
  funcs: Map<string, number>;
  names: Map<string, Map<string, number>>; // container → basename → count
}

/**
 * Sum literal stats across the subdirs an aggregate container spans. A semantic
 * view (generated/authored) may fold several subdirs into one box; its honest
 * count is the SUM of the parts, never the primary subdir alone (which would
 * undercount). fileCount/funcCount add; recurring basenames merge by name with
 * counts added, re-sorted count-desc / name-asc and capped at `topN`. Pure;
 * zero semantic words (basenames stay runtime data).
 */
export function sumContainerStats(
  parts: readonly ContainerStats[],
  opts: { topN?: number } = {},
): ContainerStats {
  const topN = opts.topN ?? DEFAULT_TOP_N;
  let fileCount = 0;
  let funcCount = 0;
  const byName = new Map<string, number>();
  for (const p of parts) {
    fileCount += p.fileCount;
    funcCount += p.funcCount;
    for (const b of p.recurringBasenames) {
      byName.set(b.name, (byName.get(b.name) ?? 0) + b.count);
    }
  }
  const recurringBasenames = [...byName.entries()]
    .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))
    .slice(0, topN)
    .map(([name, count]) => ({ name, count }));
  return { fileCount, funcCount, recurringBasenames };
}

/** Bucket every file/function node into its deepest container + tally. */
function tally(graph: RepoGraph, containers: readonly string[]): Tally {
  const files = new Map<string, number>();
  const funcs = new Map<string, number>();
  const names = new Map<string, Map<string, number>>();
  for (const node of graph.nodes) {
    if (node.type !== "file" && node.type !== "function") continue;
    const c = containerForPath(node.path, containers);
    if (c === null) continue;
    if (node.type === "function") {
      funcs.set(c, (funcs.get(c) ?? 0) + 1);
      continue;
    }
    files.set(c, (files.get(c) ?? 0) + 1);
    const byName = names.get(c) ?? new Map<string, number>();
    byName.set(node.name, (byName.get(node.name) ?? 0) + 1);
    names.set(c, byName);
  }
  return { files, funcs, names };
}

export function computeContainerStats(
  graph: RepoGraph,
  containers: readonly string[],
  opts: { topN?: number } = {},
): Map<string, ContainerStats> {
  const topN = opts.topN ?? DEFAULT_TOP_N;
  const { files, funcs, names } = tally(graph, containers);

  const out = new Map<string, ContainerStats>();
  for (const c of containers) {
    const byName = names.get(c) ?? new Map<string, number>();
    const recurringBasenames = [...byName.entries()]
      .filter(([, count]) => count >= 2) // "recurring" = appears >1× (literal, not tuned)
      .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))
      .slice(0, topN)
      .map(([name, count]) => ({ name, count }));
    out.set(c, {
      fileCount: files.get(c) ?? 0,
      funcCount: funcs.get(c) ?? 0,
      recurringBasenames,
    });
  }
  return out;
}
