// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
import { containerForPath, deriveContainers } from "./bucketing";
import { buildFileIndex, resolveImportTarget } from "./import-resolver";
import type { AnchorMap, RepoGraph } from "./types";

export interface ModuleGraph {
  modules: string[];
  edges: Array<[string, string]>;
  resolvedInternal: number;
  unresolvedInternal: number;
}

/** A file's module id: its deepest derived container, else the file path itself (loose file = its own module). */
function moduleOf(path: string, containers: string[]): string {
  return containerForPath(path, containers) ?? path;
}

/** Internal-intent = a specifier that SHOULD resolve to a repo file (relative or alias-shaped), not a bare/external pkg. */
function isInternalIntent(sourcePath: string, rawTarget: string, anchorMap?: AnchorMap): boolean {
  const isPy = sourcePath.endsWith(".py");
  if (isPy) return rawTarget.startsWith("."); // python relative
  if (rawTarget.startsWith("./") || rawTarget.startsWith("../")) return true;
  if (anchorMap?.tsAliases.some((a) => a.prefix !== "" && rawTarget.startsWith(a.prefix))) return true;
  // Detect common alias-shaped patterns even without anchorMap (e.g., @/, #/, ~/)
  if (/^[@#~][/]/.test(rawTarget)) return true;
  return false; // bare specifier → external
}

export function deriveModuleGraph(graph: RepoGraph, anchorMap?: AnchorMap): ModuleGraph {
  const filePaths = graph.nodes.filter((n) => n.type === "file").map((n) => n.path);
  const { containers } = deriveContainers(filePaths);
  const idx = buildFileIndex(graph);
  const pathById = new Map(graph.nodes.filter((n) => n.type === "file").map((n) => [n.id, n.path]));

  const edgeSet = new Set<string>();
  const edges: Array<[string, string]> = [];
  let resolvedInternal = 0;
  let unresolvedInternal = 0;

  for (const e of graph.edges) {
    if (e.type !== "imports") continue;
    const srcPath = pathById.get(e.source);
    if (!srcPath) continue;
    const resolved = resolveImportTarget(srcPath, e.target, idx, anchorMap);
    if (resolved) {
      resolvedInternal++;
      const from = moduleOf(srcPath, containers);
      const to = moduleOf(resolved, containers);
      if (from === to) continue; // self-edge dropped
      const key = `${from}|${to}`;
      if (!edgeSet.has(key)) {
        edgeSet.add(key);
        edges.push([from, to]);
      }
    } else if (isInternalIntent(srcPath, e.target, anchorMap)) {
      unresolvedInternal++; // relative/alias-shaped but didn't resolve → collapse signal
    }
  }

  const modules = [...new Set(filePaths.map((p) => moduleOf(p, containers)))].sort();
  return { modules, edges, resolvedInternal, unresolvedInternal };
}

export function unresolvedRatio(mg: ModuleGraph): number {
  const denom = mg.resolvedInternal + mg.unresolvedInternal;
  return denom === 0 ? 0 : mg.unresolvedInternal / denom;
}
