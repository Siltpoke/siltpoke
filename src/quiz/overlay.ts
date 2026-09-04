// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
import type { Overlay, StructuralVerdictObject } from "./types";

export function emptyOverlay(): Overlay {
  return {
    supported: new Set(), contradicted: new Set(), unverified: new Set(),
    userEntities: new Set(), hintEntities: new Set(),
  };
}

function clone(o: Overlay): Overlay {
  return {
    supported: new Set(o.supported), contradicted: new Set(o.contradicted), unverified: new Set(o.unverified),
    userEntities: new Set(o.userEntities), hintEntities: new Set(o.hintEntities),
  };
}

export function applyVerdict(overlay: Overlay, v: StructuralVerdictObject, source: "user" | "hint"): Overlay {
  const next = clone(overlay);
  if (!v.claim) return next; // no tuple ⇒ no coverage change
  const { entityA, entityB } = v.claim;
  const key = `${entityA}->${entityB}`;

  if (source === "hint") {
    next.hintEntities.add(entityA);
    next.hintEntities.add(entityB);
    return next; // a parroted hint never marks user coverage (R5)
  }
  next.userEntities.add(entityA);
  next.userEntities.add(entityB);
  if (v.verdict === "confirm") next.supported.add(key);
  else if (v.verdict === "contradict") next.contradicted.add(key);
  else next.unverified.add(key);
  return next;
}
