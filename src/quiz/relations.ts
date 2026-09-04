// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
import type { ModuleGraph } from "../repo-graph/module-graph";

/**
 * Pure graph-direction primitive. The fact-checker's `contradict` verdict stands
 * entirely on `reverse === true` — positive counter-evidence, never the mere
 * absence of `forward`.
 */
export function enumerateRelations(
  mg: ModuleGraph,
  aId: string,
  bId: string,
): { forward: boolean; reverse: boolean } {
  let forward = false;
  let reverse = false;
  for (const [x, y] of mg.edges) {
    if (x === aId && y === bId) forward = true;
    if (x === bId && y === aId) reverse = true;
  }
  return { forward, reverse };
}
