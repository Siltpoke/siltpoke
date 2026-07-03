// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Copyright (c) 2026 Jiaqi Duan
import type { PlantedBug } from "./manifest";

/**
 * One location an arm's critic run surfaced as a concern. `function` and
 * `line` are optional — a finding may name only a file.
 */
export interface EvalFinding {
  file: string;
  function?: string;
  line?: number;
}

/**
 * PRIMARY oracle — deterministic, no LLM. A planted bug is "caught" if any
 * finding matches the planted file AND (function-name match OR line within
 * ±lineWindow). File match is required to avoid crediting unrelated noise.
 */
export function deterministicCatch(
  planted: PlantedBug,
  findings: EvalFinding[],
  lineWindow = 5,
): boolean {
  for (const f of findings) {
    if (f.file !== planted.file) continue;
    const functionMatch =
      f.function !== undefined && f.function === planted.function;
    const lineMatch =
      f.line !== undefined && Math.abs(f.line - planted.line) <= lineWindow;
    if (functionMatch || lineMatch) return true;
  }
  return false;
}

/**
 * SECONDARY, INJECTED seam. Real impl (gated, later) = a different-Claude-TIER
 * call that does NOT see the arm label, judging whether a surfaced finding is
 * genuinely about the planted bug.
 *
 * OQ4: the grader MUST be blind (no arm label in its prompt) and run on a
 * DIFFERENT TIER than the arm under test. Claude-only infra means it is a
 * different tier, not a different model FAMILY — logged as an honest limit.
 * Here it is only a type + (in tests) a fake; no real call exists in this build.
 */
export type SemanticGrader = (args: {
  planted: PlantedBug;
  finding: EvalFinding;
  arm: string;
}) => Promise<{ aboutPlanted: boolean }>;

export interface ScoreResult {
  /** Did this example count as caught (deterministic primary)? */
  caught: boolean;
  /** True if a grader was supplied AND confirmed at least one finding. */
  semanticConfirmed?: boolean;
  /** For controls: true if ANY finding was surfaced (a false positive). */
  falsePositive?: boolean;
}

/**
 * Score one example's findings. Deterministic catch is primary; an optional
 * grader records a secondary semantic confirmation. Controls (planted === null)
 * score a false-positive whenever any finding is surfaced.
 */
export async function scoreExample(
  planted: PlantedBug | null,
  findings: EvalFinding[],
  grader?: SemanticGrader,
): Promise<ScoreResult> {
  // Control: no planted bug. Any finding at all is a false positive.
  if (planted === null) {
    return { caught: false, falsePositive: findings.length > 0 };
  }

  const caught = deterministicCatch(planted, findings);

  if (grader === undefined) {
    return { caught };
  }

  // Secondary, blind semantic confirmation over the findings. The grader never
  // changes `caught` — it only annotates. (Arm label passed through here would,
  // in the real impl, be withheld from the grader prompt; the seam carries it
  // so the real impl can audit blindness, not leak it.)
  let semanticConfirmed = false;
  for (const finding of findings) {
    const { aboutPlanted } = await grader({
      planted,
      finding,
      arm: "<withheld-from-grader>",
    });
    if (aboutPlanted) {
      semanticConfirmed = true;
      break;
    }
  }

  return { caught, semanticConfirmed };
}
