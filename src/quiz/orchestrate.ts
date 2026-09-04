// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
import { extractAnswer } from "./extract";
import { factCheck } from "./fact-check";
import { applyVerdict } from "./overlay";
import { pickTarget } from "./target-picker";
import { buildConductorTurn, CONDUCTOR_SYSTEM_PROMPT } from "./conductor-prompt";
import { buildWrapup } from "./wrapup";
import { nextLadderStep } from "./resolution-floor";
import type { StructuralVerdictObject } from "./types";
import type { ModuleGraph } from "../repo-graph/module-graph";
import type { QuizSessionState } from "./session";

export const QUIZ_MAX_TURNS = 8;

export interface QuizTurnPlan {
  phase: "question" | "wrapup";
  systemPrompt: string;
  wrapText?: string;
  priorVerdict: StructuralVerdictObject | null;
  buffered: boolean;
  nextState: QuizSessionState;
}

function isSoftAbstain(v: StructuralVerdictObject | undefined): boolean {
  return !!v && v.verdict === "abstain"
    && (v.abstain_reason === "unresolved_entity" || v.abstain_reason === "ambiguous");
}

export function prepareQuizTurn(input: {
  userMessage: string | null; mg: ModuleGraph; state: QuizSessionState; maxTurns?: number;
}): QuizTurnPlan {
  const { userMessage, mg, state } = input;
  const maxTurns = input.maxTurns ?? QUIZ_MAX_TURNS;
  const verdicts = userMessage ? factCheck(extractAnswer(userMessage, mg.modules), mg) : [];
  const v0 = verdicts[0];

  // Ladder hold — re-ask the same target with a locating question.
  if (userMessage && isSoftAbstain(v0) && state.ladderStep !== "move_on") {
    const nextState: QuizSessionState = {
      ...state, ladderStep: nextLadderStep(state.ladderStep), turnCount: state.turnCount + 1,
    };
    const systemPrompt = `${CONDUCTOR_SYSTEM_PROMPT}\n\n${buildConductorTurn({
      scope: state.scope, target: state.currentTarget, priorVerdict: v0,
    })}`;
    return { phase: "question", systemPrompt, priorVerdict: v0, buffered: true, nextState };
  }

  // Apply + advance.
  const overlay2 = verdicts.reduce((o, v) => applyVerdict(o, v, "user"), state.overlay);
  const turnCount2 = state.turnCount + (userMessage ? 1 : 0);
  const priorVerdict = v0 ?? null;
  const nextTarget = pickTarget(mg, state.scope, overlay2);

  if (state.wrappedUp || turnCount2 >= maxTurns || nextTarget.kind === "exhausted") {
    const nextState: QuizSessionState = {
      ...state, overlay: overlay2, ladderStep: null, turnCount: turnCount2,
      wrappedUp: true, currentTarget: { kind: "exhausted" },
    };
    return {
      phase: "wrapup", systemPrompt: CONDUCTOR_SYSTEM_PROMPT,
      wrapText: buildWrapup(overlay2), priorVerdict: null, buffered: false, nextState,
    };
  }

  const nextState: QuizSessionState = {
    ...state, overlay: overlay2, ladderStep: null, turnCount: turnCount2, currentTarget: nextTarget,
  };
  const systemPrompt = `${CONDUCTOR_SYSTEM_PROMPT}\n\n${buildConductorTurn({
    scope: state.scope, target: nextTarget, priorVerdict: priorVerdict ?? undefined,
  })}`;
  return { phase: "question", systemPrompt, priorVerdict, buffered: priorVerdict !== null, nextState };
}

export function quizFallbackVerbalization(v: StructuralVerdictObject): string {
  if (v.verdict === "confirm" && v.claim)
    return `That matches the map: ${v.claim.entityA} depends on ${v.claim.entityB}.`;
  if (v.verdict === "contradict" && v.claim)
    return `The map has that the other way: ${v.claim.entityB} depends on ${v.claim.entityA}, not the reverse.`;
  return "I can't verify that one against the static graph — it may connect at runtime. Let's look at a piece I can check.";
}
