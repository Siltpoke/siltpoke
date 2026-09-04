// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
import type { QuizTarget, Scope, StructuralVerdictObject } from "./types";

export const CONDUCTOR_SYSTEM_PROMPT = `You are quizzing the user on THEIR OWN codebase, teacher-style.

DISCIPLINE (non-negotiable):
- You NEVER decide whether an answer is right or wrong. A deterministic fact-checker
  decides the verdict; you only phrase the question and put the given verdict into
  plain, kind words.
- ASK, do not tell. One question at a time; funnel from broad structure to specifics.
- Clear without shaming: give a neutral receipt for a wrong or unverifiable answer.
  DO NOT praise a wrong answer to soften it. No "good way to think about it" before a
  correction.
- Never attach a "why / because / so that / designed to" rationale to a structural fact.
  Structure is graph-grounded; "why" has no oracle — mark it as discussion, never a verdict.
- No score, no tally, no percentage, no streak — ever. Feedback is specific and about the
  graph, not evaluative adjectives.
- Frame a gap as "a piece of the map we haven't connected yet," never as a failure.`;

export function buildConductorTurn(input: {
  scope: Scope;
  target: QuizTarget;
  priorVerdict?: StructuralVerdictObject;
}): string {
  const { scope, target, priorVerdict } = input;
  const scopeLine = scope.moduleId ? `Scope: ${scope.moduleId}` : "Scope: whole repo";
  const lines: string[] = [scopeLine];

  if (priorVerdict) {
    lines.push(
      `PRE-DECIDED VERDICT to verbalize (do not change it): verdict=${priorVerdict.verdict}` +
        (priorVerdict.claim ? ` claim=${priorVerdict.claim.entityA} depends_on ${priorVerdict.claim.entityB}` : "") +
        (priorVerdict.abstain_reason ? ` reason=${priorVerdict.abstain_reason}` : "") +
        (priorVerdict.evidence_ids.length > 0 ? ` evidence=${priorVerdict.evidence_ids.join(",")}` : ""),
    );
  }

  if (target.kind === "dependency_edge") {
    lines.push(`Ask the user about the dependency between ${target.a} and ${target.b} (direction matters).`);
  } else if (target.kind === "component_role") {
    lines.push(`Ask the user what ${target.moduleId} is responsible for. Treat their answer as a low-confidence, wiring-only summary — never assert why.`);
  } else {
    lines.push("The in-scope structure is covered. Move to a qualitative wrap-up.");
  }
  return lines.join("\n");
}
