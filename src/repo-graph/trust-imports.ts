// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
// Copyright (c) 2026 Jiaqi Duan
/**
 * Resolve the graph's raw `imports` edges into concrete repo-relative
 * `[source, target]` file pairs — the input `trust-map.ts`'s `buildTrustMap`
 * uses to decide whether an architecture edge has a real import behind it
 * (spec §3, AC6).
 *
 * Mirrors `aggregator.ts`'s target resolution (`buildFileIndex` once,
 * `resolveImportTarget(srcPath, rawTarget, idx, anchorMap)`) with ONE
 * deliberate difference: the source-id regex here is greedy
 * (`/^file:(.+):$/`) rather than aggregator's `/^file:([^:]+):$/`. The
 * aggregator's regex drops any file path containing a colon (e.g. Windows
 * drive-letter-shaped or otherwise colon-bearing repo paths) because `[^:]+`
 * cannot match past the first `:`; that is a pre-existing gap in the
 * aggregator, not something to replicate here, since a real import for such
 * a file must still show up as evidence.
 */
import { buildFileIndex, resolveImportTarget } from "./import-resolver";
import type { AnchorMap, RepoGraph } from "./types";

const IMPORT_EDGE_SOURCE = /^file:(.+):$/;

export function resolvedImportPairs(graph: RepoGraph, anchorMap?: AnchorMap): Array<[string, string]> {
  const idx = buildFileIndex(graph);
  const seen = new Set<string>();
  const pairs: Array<[string, string]> = [];
  for (const edge of graph.edges) {
    if (edge.type !== "imports") continue;
    const sourceMatch = IMPORT_EDGE_SOURCE.exec(edge.source);
    if (!sourceMatch) continue;
    const sourcePath = sourceMatch[1]!;
    const targetPath = resolveImportTarget(sourcePath, edge.target, idx, anchorMap);
    if (!targetPath) continue;
    const key = `${sourcePath}\u0000${targetPath}`;
    if (seen.has(key)) continue;
    seen.add(key);
    pairs.push([sourcePath, targetPath]);
  }
  return pairs;
}
