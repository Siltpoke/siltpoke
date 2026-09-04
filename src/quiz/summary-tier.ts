// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
import type { ModuleGraph } from "../repo-graph/module-graph";

export interface StructuralSummary {
  moduleId: string;
  importsInto: string[]; // modules X depends on
  usedBy: string[];      // modules that depend on X
  confidence: "low";
  verdict: null;
  note: string;
}

export function structuralSummary(mg: ModuleGraph, moduleId: string): StructuralSummary {
  const importsInto = mg.edges.filter(([a]) => a === moduleId).map(([, b]) => b);
  const usedBy = mg.edges.filter(([, b]) => b === moduleId).map(([a]) => a);
  return {
    moduleId,
    importsInto: [...new Set(importsInto)],
    usedBy: [...new Set(usedBy)],
    confidence: "low",
    verdict: null,
    note: "from the wiring, not from intent",
  };
}
