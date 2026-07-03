// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Copyright (c) 2026 Jiaqi Duan
/**
 * Symbol table.
 *
 * Enriched view over the repo-graph QueryIndex: maps a symbol name to a list of
 * candidate nodes carrying display info (type / path / lineRange) needed for
 * disambiguation menus + Brain prompt assembly.
 *
 * Anonymous arrow_functions are skipped entirely by `extractor.ts`, so this
 * table only indexes nodes that already exist in the graph; a proper
 * arrow-naming fix belongs in the extractor.
 *
 * Process-lifetime cache: callers can hold a built table across explain
 * invocations within the same process. Rebuilt when the underlying graph is
 * re-indexed (detected externally via `meta.json.last_indexed_ts`).
 */

import type {
  QueryIndex,
  RepoGraph,
  SiltpokeGraphNode,
  SiltpokeNodeType,
} from "./types";

export interface NodeCandidate {
  nodeId: string;
  type: SiltpokeNodeType;
  name: string;
  path: string;
  lineRange: [number, number];
}

export interface SymbolTable {
  /** Symbol name → ranked candidates (order preserved from QueryIndex). */
  name_to_candidates: Map<string, NodeCandidate[]>;
  /** Repo-relative path → all node ids in that file. */
  path_to_node_ids: Map<string, string[]>;
  /** Sorted unique symbol names — used by Levenshtein fallback in query.ts. */
  listAllNames(): string[];
}

function nodeToCandidate(node: SiltpokeGraphNode): NodeCandidate {
  return {
    nodeId: node.id,
    type: node.type,
    name: node.name,
    path: node.path,
    lineRange: node.lineRange,
  };
}

export function buildSymbolTable(
  graph: RepoGraph,
  queryIndex: QueryIndex,
): SymbolTable {
  const nodeById = new Map<string, SiltpokeGraphNode>();
  for (const node of graph.nodes) {
    nodeById.set(node.id, node);
  }

  const name_to_candidates = new Map<string, NodeCandidate[]>();
  for (const name of Object.keys(queryIndex.name_to_node_ids)) {
    const ids = queryIndex.name_to_node_ids[name] ?? [];
    const candidates: NodeCandidate[] = [];
    for (const id of ids) {
      const node = nodeById.get(id);
      if (node) candidates.push(nodeToCandidate(node));
    }
    if (candidates.length > 0) {
      name_to_candidates.set(name, candidates);
    }
  }

  const path_to_node_ids = new Map<string, string[]>();
  for (const path of Object.keys(queryIndex.path_to_node_ids)) {
    path_to_node_ids.set(path, [...(queryIndex.path_to_node_ids[path] ?? [])]);
  }

  const sortedNames = [...name_to_candidates.keys()].sort();

  return {
    name_to_candidates,
    path_to_node_ids,
    listAllNames(): string[] {
      return [...sortedNames];
    },
  };
}
