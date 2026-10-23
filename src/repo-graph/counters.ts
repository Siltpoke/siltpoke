// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
// Copyright (c) 2026 Jiaqi Duan
/**
 * Node/edge counter bumpers used by the builder's per-file merge loop. Split
 * out of `builder.ts` (2026-09-26) to keep that file under its length pin —
 * self-contained (only needs the `types.ts` shapes), no dependency on
 * anything else in `builder.ts`.
 */
import type { RepoGraphMetaCounters, SiltpokeGraphEdge, SiltpokeGraphNode } from "./types";

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

/** Bump both node and edge counters for one file's worth of graph records. */
export function bumpGraphCounters(
  counters: RepoGraphMetaCounters,
  nodes: SiltpokeGraphNode[],
  edges: SiltpokeGraphEdge[],
): void {
  bumpNodeCounters(counters, nodes);
  bumpEdgeCounters(counters, edges);
}
