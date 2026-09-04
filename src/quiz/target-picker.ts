// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
import type { ModuleGraph } from "../repo-graph/module-graph";
import type { Overlay, QuizTarget, Scope } from "./types";

function inScope(moduleId: string, scope: Scope): boolean {
  if (scope.moduleId === null) return true;
  return moduleId === scope.moduleId || moduleId.startsWith(scope.moduleId);
}

export function pickTarget(mg: ModuleGraph, scope: Scope, overlay: Overlay): QuizTarget {
  for (const [a, b] of mg.edges) {
    if (!inScope(a, scope)) continue;
    const key = `${a}->${b}`;
    if (overlay.supported.has(key) || overlay.contradicted.has(key)) continue;
    return { kind: "dependency_edge", a, b };
  }
  // No uncovered in-scope edge. A bounded module scope falls back to its structural-summary.
  if (scope.moduleId !== null && mg.modules.includes(scope.moduleId)) {
    return { kind: "component_role", moduleId: scope.moduleId };
  }
  return { kind: "exhausted" };
}
