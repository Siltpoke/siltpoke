// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Copyright (c) 2026 Jiaqi Duan
/**
 * Target resolution + Levenshtein fallback.
 *
 * Disambiguation is a hybrid ranked-list + TTY prompt (orchestrator side);
 * not-found falls back to Levenshtein top-3 suggestions.
 *
 * Caller responsibility (orchestrator src/explain/explain.ts):
 *   - kind === "ambiguous" → emit ranked menu, prompt if TTY
 *   - kind === "not_found" → emit suggestions, exit 2
 *   - kind === "found"     → continue to subgraph
 */

import type { RepoGraph } from "./types";
import type { NodeCandidate, SymbolTable } from "./symbol-table";

export type ResolveResult =
  | { kind: "found"; node: NodeCandidate }
  | { kind: "ambiguous"; candidates: NodeCandidate[] }
  | { kind: "not_found"; suggestions: string[] };

const QUALIFIED_SEPARATOR = ":";
const PATH_HINT_CHARS = ["/", "\\"];

function looksLikeFilePath(target: string): boolean {
  if (target.includes(QUALIFIED_SEPARATOR)) return false;
  return PATH_HINT_CHARS.some((c) => target.includes(c));
}

function parseQualified(
  target: string,
): { path: string; symbol: string } | null {
  const lastColon = target.lastIndexOf(QUALIFIED_SEPARATOR);
  if (lastColon < 0) return null;
  // A path WITHOUT slash before the colon could be a Windows drive letter or
  // just a malformed input; require a slash to treat as path:symbol.
  const path = target.slice(0, lastColon);
  const symbol = target.slice(lastColon + 1);
  if (!PATH_HINT_CHARS.some((c) => path.includes(c))) return null;
  if (path.length === 0 || symbol.length === 0) return null;
  return { path, symbol };
}

function resolveFilePath(
  path: string,
  graph: RepoGraph,
  table: SymbolTable,
): ResolveResult {
  const nodeIds = table.path_to_node_ids.get(path);
  if (!nodeIds || nodeIds.length === 0) {
    return { kind: "not_found", suggestions: [] };
  }
  const fileNodeId = nodeIds.find((id) => id.startsWith("file:")) ?? null;
  if (!fileNodeId) {
    return { kind: "not_found", suggestions: [] };
  }
  const fileNode = graph.nodes.find((n) => n.id === fileNodeId);
  if (!fileNode) {
    return { kind: "not_found", suggestions: [] };
  }
  return {
    kind: "found",
    node: {
      nodeId: fileNode.id,
      type: fileNode.type,
      name: fileNode.name,
      path: fileNode.path,
      lineRange: fileNode.lineRange,
    },
  };
}

function resolveBareSymbol(
  name: string,
  table: SymbolTable,
): ResolveResult {
  const candidates = table.name_to_candidates.get(name);
  if (!candidates || candidates.length === 0) {
    return {
      kind: "not_found",
      suggestions: levenshteinSuggest(name, table.listAllNames(), 3),
    };
  }
  if (candidates.length === 1) {
    return { kind: "found", node: candidates[0] };
  }
  return { kind: "ambiguous", candidates };
}

function resolveQualified(
  path: string,
  symbol: string,
  table: SymbolTable,
): ResolveResult {
  const candidates = table.name_to_candidates.get(symbol);
  if (!candidates || candidates.length === 0) {
    return {
      kind: "not_found",
      suggestions: levenshteinSuggest(symbol, table.listAllNames(), 3),
    };
  }
  const matched = candidates.filter((c) => c.path === path);
  if (matched.length === 0) {
    return { kind: "not_found", suggestions: [] };
  }
  if (matched.length === 1) {
    return { kind: "found", node: matched[0] };
  }
  return { kind: "ambiguous", candidates: matched };
}

export function resolveTarget(
  target: string,
  graph: RepoGraph,
  table: SymbolTable,
): ResolveResult {
  if (target.length === 0) {
    return { kind: "not_found", suggestions: [] };
  }

  const qualified = parseQualified(target);
  if (qualified) {
    return resolveQualified(qualified.path, qualified.symbol, table);
  }

  if (looksLikeFilePath(target)) {
    return resolveFilePath(target, graph, table);
  }

  return resolveBareSymbol(target, table);
}

/**
 * Standard Levenshtein distance (iterative, O(m·n) space O(n)).
 */
function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;
  let prev = new Array<number>(b.length + 1);
  let curr = new Array<number>(b.length + 1);
  for (let j = 0; j <= b.length; j++) prev[j] = j;
  for (let i = 1; i <= a.length; i++) {
    curr[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(
        curr[j - 1] + 1,
        prev[j] + 1,
        prev[j - 1] + cost,
      );
    }
    [prev, curr] = [curr, prev];
  }
  return prev[b.length];
}

export function levenshteinSuggest(
  needle: string,
  pool: string[],
  n: number,
): string[] {
  if (pool.length === 0 || n <= 0) return [];
  const scored = pool.map((name, idx) => ({
    name,
    distance: levenshtein(needle, name),
    idx,
  }));
  scored.sort((a, b) => {
    if (a.distance !== b.distance) return a.distance - b.distance;
    return a.idx - b.idx;
  });
  return scored.slice(0, n).map((s) => s.name);
}
