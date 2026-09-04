// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
import { resolveModuleName } from "../repo-graph/module-resolve";

export type LadderStep = "alias" | "locate" | "move_on";

/** The resolution floor: an exact name or obvious alias MUST map. Lazy-abstain on
 *  a claim that passes this is a test failure (R6). */
export function mustResolve(name: string, moduleIds: string[]): boolean {
  return resolveModuleName(name, moduleIds).kind === "found";
}

/** Deterministic, loop-free abstain ladder: alias candidates → one locating question → move on. */
export function nextLadderStep(current: LadderStep | null): LadderStep {
  if (current === null) return "alias";
  if (current === "alias") return "locate";
  return "move_on";
}
