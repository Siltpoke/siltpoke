// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1

import type { IndexStaleness } from "../repo-graph/index-health";
import type { ModuleGraph } from "../repo-graph/module-graph";
import { stalenessVerdict } from "../repo-graph/staleness-verdict";
import type { Scope } from "./types";

export type GateResult =
  | { ok: true }
  | { ok: false; reason: "stale" | "scope_gone" | "dirty"; message: string };

export function gateScope(input: {
  staleness: IndexStaleness | null;
  warnPct: number;
  mg: ModuleGraph;
  scope: Scope;
  dirty: boolean;
}): GateResult {
  const { staleness, warnPct, mg, scope, dirty } = input;

  // Most specific first: the thing the user picked is gone from the current graph.
  if (scope.moduleId !== null && !mg.modules.includes(scope.moduleId)) {
    return { ok: false, reason: "scope_gone", message: "That part of the map isn't in the current index — re-index and pick again." };
  }
  if (stalenessVerdict(staleness, warnPct).level === "stale") {
    return { ok: false, reason: "stale", message: "The index is out of date — re-index before quizzing so we don't quiz against stale structure." };
  }
  if (dirty) {
    return { ok: false, reason: "dirty", message: "You have uncommitted changes — the graph may not match your working tree yet." };
  }
  return { ok: true };
}
