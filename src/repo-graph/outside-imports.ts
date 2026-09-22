// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
// Copyright (c) 2026 Jiaqi Duan
/**
 * Imports that point outside the indexed root. The Code Map does not draw
 * them; it says how many there are (spec 2026-09-14 §5). Only what is
 * CERTAINLY outside counts — see `isOutsideImport`. Computed once at index end
 * and stored in meta, so a page render never pays for it.
 */
import { posix } from "node:path";
import { buildFileIndex, matchingAliasRules, resolveImportTarget } from "./import-resolver";
import type { AnchorMap, RepoGraph } from "./types";

export interface OutsideImports {
  count: number;
  /** Up to OUTSIDE_EXAMPLES_MAX `source → raw target` strings, in edge order. */
  examples: string[];
}

export const OUTSIDE_EXAMPLES_MAX = 5;

const climbsAboveRoot = (rootRelative: string): boolean => rootRelative === ".." || rootRelative.startsWith("../");

/**
 * True only when the import certainly leaves the root:
 *   - TS relative (`./`, `../`) whose joined path climbs above the root;
 *   - Python relative whose N dots go up N−1 levels, more than the file is deep;
 *   - a TS alias (non-empty prefix) whose most specific matching rule has every
 *     target above the root.
 * Everything else — a missing file inside the root, a Python absolute import,
 * a bare package — is false.
 */
export function isOutsideImport(sourcePath: string, rawTarget: string, anchorMap?: AnchorMap): boolean {
  if (!rawTarget) return false;
  const sourceDir = posix.dirname(sourcePath);
  if (sourcePath.endsWith(".py")) {
    if (!rawTarget.startsWith(".")) return false;
    const dots = rawTarget.length - rawTarget.replace(/^\.+/, "").length;
    const depth = sourceDir === "." ? 0 : sourceDir.split("/").length;
    return dots - 1 > depth;
  }
  if (rawTarget.startsWith("./") || rawTarget.startsWith("../")) {
    return climbsAboveRoot(posix.join(sourceDir, rawTarget));
  }
  if (!anchorMap) return false;
  const [rule] = matchingAliasRules(sourcePath, rawTarget, anchorMap.tsAliases).filter((r) => r.prefix !== "");
  return rule !== undefined && rule.targets.length > 0 && rule.targets.every(climbsAboveRoot);
}

/** Count unresolved imports that certainly leave the root, with a few examples. */
export function computeOutsideImports(graph: RepoGraph, anchorMap?: AnchorMap): OutsideImports {
  const idx = buildFileIndex(graph);
  const pathById = new Map(graph.nodes.filter((n) => n.type === "file").map((n) => [n.id, n.path]));
  let count = 0;
  const examples: string[] = [];
  for (const edge of graph.edges) {
    if (edge.type !== "imports") continue;
    const source = pathById.get(edge.source);
    if (source === undefined) continue;
    if (resolveImportTarget(source, edge.target, idx, anchorMap) !== null) continue;
    if (!isOutsideImport(source, edge.target, anchorMap)) continue;
    count += 1;
    if (examples.length < OUTSIDE_EXAMPLES_MAX) examples.push(`${source} → ${edge.target}`);
  }
  return { count, examples };
}
