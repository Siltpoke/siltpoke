// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Copyright (c) 2026 Jiaqi Duan
/**
 * Entrypoint detection.
 *
 * The trace layer roots each path at a REAL resolved symbol. v1 uses an
 * authored allow-list of the three siltpoke roots, but every emitted entry
 * must point at a symbol that actually exists in the graph — we never invent
 * a root. Each role carries an ordered list of candidate names (so a rename
 * like startServer→startDaemon is tolerated) plus a module hint used to
 * disambiguate when a name occurs in more than one place.
 */
import type { QueryIndex, RepoGraph, SiltpokeGraphNode } from "./types";

export interface Entrypoint {
  /** Role key, also the `?entry=` query value: "cli" | "daemon" | "dash". */
  id: string;
  label: string;
  fn: string;
  /** Path segment after `src/` (e.g. "hooks"), or the first segment. */
  module: string;
  /** Basename of the defining file. */
  file: string;
  line: number;
  /** Repo-relative path of the defining file. */
  path: string;
  /** Graph node id of the root — the start node for `tracePath`. */
  nodeId: string;
}

interface RoleSpec {
  id: string;
  label: string;
  names: string[];
  moduleHint: string;
}

const ROLES: RoleSpec[] = [
  { id: "cli", label: "CLI · Stop hook", names: ["handleStopHook"], moduleHint: "hooks" },
  { id: "daemon", label: "Daemon · server", names: ["startDaemon", "startServer"], moduleHint: "daemon" },
  // Prefer the SSR shell (Dashboard) over a single screen (Home): the shell is
  // the semantic render root and less of a leaf. NOTE: siltpoke's dashboard is
  // JSX-shallow, so no preset root traces deep — reordering picks the less-leafy
  // / righter root, it does not manufacture depth. Shallow-entrypoint repos are
  // served by "trace from any function", not by deep presets.
  { id: "dash", label: "Dashboard render", names: ["Dashboard", "Home", "renderDashboard"], moduleHint: "web" },
];

const ROOTABLE_TYPES = new Set(["function", "class"]);

function moduleOf(path: string): string {
  const segs = path.split("/").filter(Boolean);
  if (segs[0] === "src" && segs.length >= 2) return segs[1]!;
  return segs[0] ?? "";
}

function basenameOf(path: string): string {
  const segs = path.split("/").filter(Boolean);
  return segs.length ? segs[segs.length - 1]! : path;
}

export function detectEntrypoints(graph: RepoGraph, queryIndex: QueryIndex): Entrypoint[] {
  const nodeById = new Map<string, SiltpokeGraphNode>();
  for (const node of graph.nodes) nodeById.set(node.id, node);

  const out: Entrypoint[] = [];
  for (const role of ROLES) {
    let chosen: SiltpokeGraphNode | null = null;
    for (const name of role.names) {
      const ids = queryIndex.name_to_node_ids[name] ?? [];
      const candidates = ids
        .map((id) => nodeById.get(id))
        .filter((n): n is SiltpokeGraphNode => !!n && ROOTABLE_TYPES.has(n.type));
      if (candidates.length === 0) continue;
      chosen =
        candidates.find((n) => moduleOf(n.path) === role.moduleHint) ?? candidates[0]!;
      break;
    }
    if (!chosen) continue;
    out.push({
      id: role.id,
      label: role.label,
      fn: chosen.name,
      module: moduleOf(chosen.path),
      file: basenameOf(chosen.path),
      line: chosen.lineRange[0],
      path: chosen.path,
      nodeId: chosen.id,
    });
  }
  return out;
}
