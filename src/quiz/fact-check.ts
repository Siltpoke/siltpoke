// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
import type { ModuleGraph } from "../repo-graph/module-graph";
import type { ModuleResolve } from "../repo-graph/module-resolve";
import type { ExtractedAnswer } from "./extract";
import { enumerateRelations } from "./relations";
import type { StructuralVerdictObject } from "./types";

/** Exact-vs-fuzzy resolution confidence. resolveModuleName collapses both to `found`;
 *  we re-derive exactness cheaply so a fuzzy match carries less weight. */
function confidenceOf(resolve: ModuleResolve, name: string): number {
  if (resolve.kind !== "found") return 0;
  const seg = resolve.id.split("/").filter(Boolean).pop()?.toLowerCase() ?? "";
  return seg === name.trim().toLowerCase() || resolve.id.toLowerCase() === name.trim().toLowerCase() ? 1 : 0.7;
}

export function factCheck(
  extracted: ExtractedAnswer,
  mg: ModuleGraph,
  floor = 0.5,
): StructuralVerdictObject[] {
  const byName = new Map(extracted.entities.map((e) => [e.name, e]));
  const out: StructuralVerdictObject[] = [];

  for (const rel of extracted.relations) {
    const a = byName.get(rel.aName);
    const b = byName.get(rel.bName);
    const confA = a ? confidenceOf(a.resolve, rel.aName) : 0;
    const confB = b ? confidenceOf(b.resolve, rel.bName) : 0;

    // Rule 2 — either endpoint below the floor ⇒ abstain, no fabricated tuple.
    if (!a || !b || a.resolve.kind !== "found" || b.resolve.kind !== "found" || confA < floor || confB < floor) {
      out.push({ kind: "structural_verdict", claim: null, verdict: "abstain", evidence_ids: [], confidence: 0, abstain_reason: "unresolved_entity" });
      continue;
    }

    const aId = a.resolve.id;
    const bId = b.resolve.id;
    const claim = { entityA: aId, entityB: bId, relType: "depends_on" as const };
    const confidence = Math.min(confA, confB);
    const { forward, reverse } = enumerateRelations(mg, aId, bId);

    if (forward) {
      out.push({ kind: "structural_verdict", claim, verdict: "confirm", evidence_ids: [aId, bId], confidence });
    } else if (reverse) {
      out.push({ kind: "structural_verdict", claim, verdict: "contradict", evidence_ids: [bId, aId], confidence });
    } else {
      out.push({ kind: "structural_verdict", claim, verdict: "abstain", evidence_ids: [], confidence, abstain_reason: "out_of_class" });
    }
  }
  return out;
}
