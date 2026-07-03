// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Copyright (c) 2026 Jiaqi Duan
/**
 * Fuzzy search index over the repo-graph queryIndex.
 *
 * Used by `/repo-graph` search box to jump directly to a symbol
 * level. Three responsibilities:
 *
 *   1. Build a Map-based index from the raw `queryIndex.name_to_node_ids`
 *      record so that lookups by user input cannot leak Object.prototype
 *      methods (read-time defense).
 *      The index builder already null-prototypes its in-memory index, but JSON
 *      round-trip recreates a plain Object, so we re-establish safety
 *      at the consumer.
 *
 *   2. Hydrate matches with `type` + `path` from the graph so the UI
 *      can render a rich dropdown without a follow-up node lookup.
 *
 *   3. Rank: exact match (100) > prefix (80) > substring (50). Ties
 *      preserve insertion order (stable sort). No Levenshtein at this
 *      layer — query.ts owns Levenshtein for the not-found CLI path.
 */
import type {
  QueryIndex,
  RepoGraph,
  SiltpokeNodeType,
} from "./types";

export interface SearchIndex {
  /** node_id → quick details lookup for hydrating match rows. */
  byNodeId: Map<string, { name: string; type: SiltpokeNodeType; path: string }>;
  /** symbol name → node_ids (F24-safe Map, not raw Record). */
  byName: Map<string, string[]>;
}

export interface SearchMatch {
  node_id: string;
  name: string;
  type: SiltpokeNodeType;
  path: string;
  /** Higher = better match. 100 exact / 80 prefix / 50 substring. */
  score: number;
}

const SCORE_EXACT = 100;
const SCORE_PREFIX = 80;
const SCORE_SUBSTRING = 50;
const DEFAULT_LIMIT = 10;

export function buildSearchIndex(
  graph: RepoGraph,
  queryIndex: QueryIndex,
): SearchIndex {
  const byNodeId = new Map<string, { name: string; type: SiltpokeNodeType; path: string }>();
  for (const node of graph.nodes) {
    byNodeId.set(node.id, { name: node.name, type: node.type, path: node.path });
  }
  // Build name → node_ids Map from the raw record. Using Object.keys()
  // restricts iteration to own enumerable properties (skips prototype
  // chain); the resulting Map.get() lookups are safe regardless of
  // user-supplied keys.
  const byName = new Map<string, string[]>();
  const raw = queryIndex.name_to_node_ids;
  for (const key of Object.keys(raw)) {
    if (Object.hasOwn(raw, key)) {
      byName.set(key, raw[key]!);
    }
  }
  return { byNodeId, byName };
}

export function fuzzyMatch(
  query: string,
  index: SearchIndex,
  limit: number = DEFAULT_LIMIT,
): SearchMatch[] {
  if (!query) return [];
  const q = query.toLowerCase();
  const matches: SearchMatch[] = [];
  for (const [name, nodeIds] of index.byName) {
    const lcName = name.toLowerCase();
    let score: number;
    if (lcName === q) score = SCORE_EXACT;
    else if (lcName.startsWith(q)) score = SCORE_PREFIX;
    else if (lcName.includes(q)) score = SCORE_SUBSTRING;
    else continue;
    for (const nodeId of nodeIds) {
      const detail = index.byNodeId.get(nodeId);
      if (!detail) continue;
      matches.push({
        node_id: nodeId,
        name,
        type: detail.type,
        path: detail.path,
        score,
      });
    }
  }
  // Sort by score desc, then name length asc within the same tier
  // (shorter = more specific match for the query). E.g., searching
  // "run" surfaces "runner" above "runtimeProvider".
  matches.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    return a.name.length - b.name.length;
  });
  return matches.slice(0, limit);
}
