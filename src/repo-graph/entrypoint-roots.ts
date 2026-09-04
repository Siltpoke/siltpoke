// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
// Copyright (c) 2026 Jiaqi Duan
/**
 * 3-tier entry root selector: picks the trace root for a resolved entry file.
 *
 * Tier 1: an exported function/class symbol — a convention-named export
 *         (default/main/handler/start-prefixed/createServer/createApp) wins,
 *         else ONLY when exactly one exported rootable symbol exists.
 * Tier 2: the file node, when no exported rootable symbol exists but a
 *         module-level `calls` edge from the file node resolves to an
 *         in-repo function/class.
 * Tier 3: the file node as a shallow leaf (framework-invoked file with an
 *         exported-but-uncalled component, or nothing rootable at all).
 * `null` when the entry file is not indexed.
 */
import type { QueryIndex, RepoGraph, SiltpokeGraphNode } from "./types";

export interface RootPick {
  nodeId: string;
  node: SiltpokeGraphNode;
  tier: 1 | 2 | 3;
}

const ROOTABLE = new Set(["function", "class"]);
// All-lowercase so comparison against a lowercased node name actually matches
// (a mixed-case "createServer" would never equal a lowercased name — qoder catch).
const CONVENTION = ["default", "main", "handler", "start", "createserver", "createapp"];

function scoreName(name: string): number {
  const lower = name.toLowerCase();
  const i = CONVENTION.findIndex((c) => lower === c || lower.startsWith(c));
  return i === -1 ? CONVENTION.length : i;
}

export function resolveEntryRoot(
  graph: RepoGraph,
  queryIndex: QueryIndex,
  entryFilePath: string,
): RootPick | null {
  const idsInFile = queryIndex.path_to_node_ids[entryFilePath] ?? [];
  if (idsInFile.length === 0) return null;
  const byId = new Map(graph.nodes.map((n) => [n.id, n]));
  const inFile = idsInFile.map((id) => byId.get(id)).filter((n): n is SiltpokeGraphNode => !!n);

  const fileNode = inFile.find((n) => n.type === "file");

  // Tier 1: an exported rootable symbol, chosen deterministically —
  //   (a) a convention-named export wins (lowest score < CONVENTION.length); else
  //   (b) ONLY when there is exactly ONE exported rootable symbol.
  // Multiple non-convention exports → NOT tier 1 (never root at an arbitrary helper);
  // fall through to the file-node tiers. (codex/qoder catch: the old sort-and-take-first
  // violated the "sole exported rootable symbol" rule.)
  const exportedRootable = inFile
    .filter((n) => ROOTABLE.has(n.type) && n.exported && n.name && n.name !== "<anonymous>")
    .sort((a, b) => scoreName(a.name) - scoreName(b.name));
  const best = exportedRootable[0];
  if (best && (scoreName(best.name) < CONVENTION.length || exportedRootable.length === 1)) {
    return { nodeId: best.id, node: best, tier: 1 };
  }

  if (!fileNode) return null; // no file node → cannot root; drop

  // Tier 2: a module-level call from the file node to an in-repo function/class.
  const hasInRepoModuleCall = graph.edges.some((e) => {
    if (e.type !== "calls" || e.source !== fileNode.id) return false;
    const targetIds = queryIndex.name_to_node_ids[e.target] ?? [];
    return targetIds.some((id) => ROOTABLE.has(byId.get(id)?.type ?? ""));
  });
  if (hasInRepoModuleCall) return { nodeId: fileNode.id, node: fileNode, tier: 2 };

  // Tier 3: shallow, honest file-node leaf.
  return { nodeId: fileNode.id, node: fileNode, tier: 3 };
}
