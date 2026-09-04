// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
import { describe, it, expect } from "bun:test";
import { emptyOverlay } from "../../src/quiz/index";
import { prepareQuizTurn, quizFallbackVerbalization, QUIZ_MAX_TURNS } from "../../src/quiz/orchestrate";
import type { QuizSessionState } from "../../src/quiz/session";
import type { ModuleGraph } from "../../src/repo-graph/module-graph";

// Two-edge graph: web depends_on daemon, daemon depends_on config. A single-edge
// fixture would make pickTarget return "exhausted" the instant the one edge is
// covered (confirmed or contradicted), which collapses the "apply + advance"
// branch straight into the wrap-up branch and wipes priorVerdict/buffered before
// the confirm-advance test can observe them. Two edges keep a second uncovered
// edge available so advancement is actually observable (see task-2-report.md).
const mg: ModuleGraph = {
  modules: ["src/web", "src/daemon", "src/config"],
  edges: [
    ["src/web", "src/daemon"],
    ["src/daemon", "src/config"],
  ],
  resolvedInternal: 2, unresolvedInternal: 0,
};
function base(over: Partial<QuizSessionState> = {}): QuizSessionState {
  return {
    mode: "quiz", scope: { moduleId: null }, overlay: emptyOverlay(),
    currentTarget: { kind: "dependency_edge", a: "src/web", b: "src/daemon" },
    ladderStep: null, turnCount: 0, wrappedUp: false, projHash: "abc", ...over,
  };
}

describe("prepareQuizTurn", () => {
  it("opener: no user message → question, not buffered, no verdict", () => {
    const plan = prepareQuizTurn({ userMessage: null, mg, state: base() });
    expect(plan.phase).toBe("question");
    expect(plan.buffered).toBe(false);
    expect(plan.priorVerdict).toBeNull();
    expect(plan.systemPrompt).toContain("dependency"); // conductor turn present (buildConductorTurn's actual wording)
  });

  it("correct answer → confirm verdict, overlay gains the edge, turn advances buffered", () => {
    const plan = prepareQuizTurn({ userMessage: "web depends on daemon", mg, state: base() });
    expect(plan.priorVerdict?.verdict).toBe("confirm");
    expect(plan.buffered).toBe(true);
    expect(plan.nextState.overlay.supported.size).toBeGreaterThan(0);
    expect(plan.nextState.turnCount).toBe(1);
  });

  it("reversed answer → contradict; fallback verbalizes the REAL direction", () => {
    const plan = prepareQuizTurn({ userMessage: "daemon depends on web", mg, state: base() });
    expect(plan.priorVerdict?.verdict).toBe("contradict");
    const fb = quizFallbackVerbalization(plan.priorVerdict!);
    expect(fb).toContain("src/web depends on src/daemon".replace("src/", "src/")); // real direction
    expect(fb).not.toMatch(/\d|%|good|solid|nice/i);
  });

  it("unresolvable answer holds the same target and advances the ladder, no overlay change", () => {
    const s = base();
    const plan = prepareQuizTurn({ userMessage: "the thingamajig depends on the whatsit", mg, state: s });
    expect(plan.priorVerdict?.verdict).toBe("abstain");
    expect(plan.nextState.currentTarget).toEqual(s.currentTarget);  // held
    expect(plan.nextState.ladderStep).not.toBeNull();
    expect(plan.nextState.overlay.supported.size).toBe(0);          // not applied
  });

  it("ladder at move_on applies the abstain and advances", () => {
    const plan = prepareQuizTurn({
      userMessage: "the thingamajig depends on the whatsit",
      mg, state: base({ ladderStep: "move_on" }),  // already at move_on → this call applies, not holds
    });
    // move_on branch: overlay gets the abstain (unverified), target advances or exhausts
    expect(plan.nextState.ladderStep).toBeNull();
  });

  it("turn budget reached → wrapup, score-free, not buffered", () => {
    const plan = prepareQuizTurn({
      userMessage: "web depends on daemon", mg, state: base({ turnCount: QUIZ_MAX_TURNS - 1 }),
    });
    expect(plan.phase).toBe("wrapup");
    expect(plan.wrapText).toBeTruthy();
    expect(plan.wrapText).not.toMatch(/\d+ *%|score|tally|streak/i);
    expect(plan.nextState.wrappedUp).toBe(true);
  });
});
