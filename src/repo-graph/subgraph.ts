// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Copyright (c) 2026 Jiaqi Duan
/**
 * N-hop subgraph builder.
 *
 * Default depth=1, --depth 2 opt-in. Cross-file `calls` resolution is
 * deferred to prompt-assembly (which has source loaded for snippet
 * inclusion anyway).
 *
 * The index populates `contains` and `imports` edges; `calls` edges are
 * resolved separately. Subgraph layer works purely on existing edges; orchestrator
 * augments via source-time call resolution before Brain prompt assembly.
 *
 * Traversal direction is undirected — for any visited node we follow every
 * incident edge regardless of source/target orientation. This catches
 * incoming callers, outgoing callees, parent files (via `contains`), and
 * imported/import-by relationships in one pass.
 *
 * Per-node neighbor cap (`NEIGHBOR_CAP`) prevents hub nodes (100+ callers)
 * from blowing up subgraph size and downstream prompt budget. Truncation
 * surfaces via `subgraph.truncated` so the orchestrator can flag the
 * explanation as "partial".
 */

import type {
  RepoGraph,
  SiltpokeGraphEdge,
  SiltpokeGraphNode,
} from "./types";
import type { NodeCandidate } from "./symbol-table";

export const NEIGHBOR_CAP = 50;

export interface Subgraph {
  target: SiltpokeGraphNode;
  nodes: SiltpokeGraphNode[];
  edges: SiltpokeGraphEdge[];
  depth: 1 | 2;
  /** True when any visited node hit `NEIGHBOR_CAP` and excluded neighbors. */
  truncated: boolean;
}

function nodeIndex(graph: RepoGraph): Map<string, SiltpokeGraphNode> {
  const m = new Map<string, SiltpokeGraphNode>();
  for (const n of graph.nodes) m.set(n.id, n);
  return m;
}

function adjacency(
  graph: RepoGraph,
): Map<string, SiltpokeGraphEdge[]> {
  const m = new Map<string, SiltpokeGraphEdge[]>();
  for (const e of graph.edges) {
    const sList = m.get(e.source) ?? [];
    sList.push(e);
    m.set(e.source, sList);
    if (e.target !== e.source) {
      const tList = m.get(e.target) ?? [];
      tList.push(e);
      m.set(e.target, tList);
    }
  }
  return m;
}

export function buildSubgraph(
  targetId: string,
  graph: RepoGraph,
  depth: 1 | 2,
): Subgraph {
  const byId = nodeIndex(graph);
  const target = byId.get(targetId);
  if (!target) {
    throw new Error(`target node not found in graph: ${targetId}`);
  }

  const adj = adjacency(graph);
  const visitedNodes = new Set<string>([targetId]);
  const includedEdges = new Map<string, SiltpokeGraphEdge>();
  let truncated = false;

  let frontier: string[] = [targetId];
  for (let hop = 0; hop < depth; hop++) {
    const nextFrontier: string[] = [];
    for (const nodeId of frontier) {
      const edges = adj.get(nodeId) ?? [];
      let kept = 0;
      for (const edge of edges) {
        if (kept >= NEIGHBOR_CAP) {
          truncated = true;
          break;
        }
        kept++;
        includedEdges.set(edge.id, edge);
        const neighborId = edge.source === nodeId ? edge.target : edge.source;
        if (!visitedNodes.has(neighborId) && byId.has(neighborId)) {
          visitedNodes.add(neighborId);
          nextFrontier.push(neighborId);
        } else if (!byId.has(neighborId)) {
          // raw string import target — keep edge but no node to expand into
        }
      }
    }
    frontier = nextFrontier;
  }

  // Post-pass: when a file node is in the subgraph, pull in its outgoing
  // imports edges as free context (raw string targets are not expanded into
  // nodes). Imports of the containing file are treated as belonging to
  // the target's surroundings regardless of hop distance.
  for (const id of visitedNodes) {
    const n = byId.get(id);
    if (!n || n.type !== "file") continue;
    const edges = adj.get(id) ?? [];
    for (const e of edges) {
      if (e.type === "imports" && e.source === id) {
        includedEdges.set(e.id, e);
      }
    }
  }

  const nodes: SiltpokeGraphNode[] = [];
  for (const id of visitedNodes) {
    const n = byId.get(id);
    if (n) nodes.push(n);
  }

  return {
    target,
    nodes,
    edges: [...includedEdges.values()],
    depth,
    truncated,
  };
}

/**
 * Helper for orchestrator/prompt-assembly — groups subgraph nodes around
 * the target into prompt-meaningful buckets.
 */
export interface SubgraphView {
  containingFile: SiltpokeGraphNode | null;
  incomingCalls: NodeCandidate[];
  outgoingCalls: NodeCandidate[];
  containsChildren: NodeCandidate[];
  importsFrom: string[];
}

function toCandidate(n: SiltpokeGraphNode): NodeCandidate {
  return {
    nodeId: n.id,
    type: n.type,
    name: n.name,
    path: n.path,
    lineRange: n.lineRange,
  };
}

export function viewSubgraph(sub: Subgraph): SubgraphView {
  const byId = new Map<string, SiltpokeGraphNode>();
  for (const n of sub.nodes) byId.set(n.id, n);
  const targetId = sub.target.id;

  let containingFile: SiltpokeGraphNode | null = null;
  const incomingCalls: NodeCandidate[] = [];
  const outgoingCalls: NodeCandidate[] = [];
  const containsChildren: NodeCandidate[] = [];
  const importsFrom: string[] = [];

  for (const e of sub.edges) {
    if (e.type === "contains") {
      if (e.target === targetId) {
        const parent = byId.get(e.source);
        if (parent?.type === "file") containingFile = parent;
      } else if (e.source === targetId) {
        const child = byId.get(e.target);
        if (child) containsChildren.push(toCandidate(child));
      }
      continue;
    }
    if (e.type === "calls") {
      if (e.target === targetId) {
        const src = byId.get(e.source);
        if (src) incomingCalls.push(toCandidate(src));
      } else if (e.source === targetId) {
        const tgt = byId.get(e.target);
        if (tgt) outgoingCalls.push(toCandidate(tgt));
      }
      continue;
    }
    if (e.type === "imports" && e.source === targetId) {
      importsFrom.push(e.target);
      continue;
    }
    if (e.type === "imports" && containingFile && e.source === containingFile.id) {
      importsFrom.push(e.target);
    }
  }

  return {
    containingFile,
    incomingCalls,
    outgoingCalls,
    containsChildren,
    importsFrom,
  };
}
