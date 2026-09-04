// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
// Copyright (c) 2026 Jiaqi Duan
/**
 * Quiz-mode branch for `POST /api/chat` — extracted out of `chat.ts` per the
 * Task 4 brief's implementer note (keeps the already-large route handler
 * lean; chat.ts is close to the 400-LOC soft cap). Detects quiz mode (the
 * opener's `body.quiz` field, or a continuation via `quizStore.read`), gates
 * scope, loads the module graph, and runs the PURE `prepareQuizTurn`
 * orchestrator (`src/quiz/orchestrate.ts`) to produce the conductor's system
 * prompt for this turn. The route threads the result into
 * `composeBaseSystemPrompt` via `quizPrompt` (highest precedence — see
 * `src/chat/compose-base-context.ts`).
 *
 * Engine imports go through the barrel (`src/quiz/index.ts`) — this file is
 * a CALLER of the quiz engine, never part of it; `src/quiz/*` itself is
 * never modified here (global constraint, Task 4 brief).
 *
 * Scope note (Task 4 brief "SCOPE DISCIPLINE"): only the OPENER path was
 * required to work end-to-end for Task 4. Continuation detection is wired
 * (per the brief's interface: "quizStore.read(session_id) returns non-null"
 * = active); the buffered validate-retry-fallback emission (a wrong
 * continuation answer producing a `contradict` verdict reply) is wired by
 * the ROUTE (chat.ts) — Task 6 — using `generateValidatedVerbalization`
 * (chat-quiz-emit.ts) keyed on the `buffered`/`priorVerdict` this file
 * surfaces on `QuizTurnResult`.
 *
 * Persistence note (Task 6): this file no longer calls `quizStore.write`
 * itself. `prepareQuizTurn`'s `nextState` is only a PROPOSAL for what the
 * session should become after this turn; chat.ts writes it AFTER the
 * turn's Brain call actually completes (not cancelled, not failed) — an
 * eager write here, before the client ever saw a reply, could advance the
 * overlay/target for a turn the user never actually received (e.g. a
 * buffered verbalization call that throws before chat.ts's persistence
 * gate runs).
 */
import { loadRepoGraphConfig } from "../../config/repo-graph-config";
import {
  emptyOverlay,
  gateScope,
  pickTarget,
  prepareQuizTurn,
  type QuizSessionState,
  type QuizTurnPlan,
  type Scope,
} from "../../quiz/index";
import { type IndexStaleness, readIndexStaleness } from "../../repo-graph/index-health";
import type { ModuleGraph } from "../../repo-graph/module-graph";

/** The scope-gate blocked the opener (stale index / scope gone / dirty tree).
 * Discriminates on `blocked` (not `kind`) — mirrors every OTHER pre-flight
 * signal in this route (`BudgetSignal`, `BlockedSignal`, `NodeGoneSignal`,
 * `CritiqueGoneSignal`), which the frontend's dispatcher
 * (`src/web/client/islands/floating-chat.ts`) branches on via
 * `signal.blocked === "..."`. Terminal, status 200, nothing streams. */
export interface QuizBlockedSignal {
  blocked: "quiz_blocked";
  reason: "stale" | "scope_gone" | "dirty";
  message: string;
}

/** No module graph could be loaded for this project (never indexed, or the
 * index resolved to nothing) — the quiz cannot run at all. Same `blocked`
 * discriminant discipline as `QuizBlockedSignal` above. */
export interface QuizUnavailableSignal {
  blocked: "quiz_unavailable";
  reason: "no_index";
}

export interface QuizRouteDeps {
  homeBase: string;
  /** proj_hash → module graph, or null when there is no index. */
  loadModuleGraph?: (projHash: string) => Promise<ModuleGraph | null>;
  /** Reused from ChatRouteDeps — resolves the opener's proj_hash to the
   * project's cwd for the staleness read the scope gate needs. Absent →
   * staleness stays unknown and the gate fails open on that axis (mirrors
   * the route's existing staleness fail-open discipline elsewhere). */
  resolveProjectRootByHash?: (projHash: string) => Promise<string | null>;
}

/** Task 7 dedupe — a continuation arrived on a session whose loaded state
 * already had `wrappedUp === true` ON ENTRY (before this turn ran). The
 * quiz is over; `prepareQuizTurn` is never called (it would just return
 * `phase: "wrapup"` again — see orchestrate.ts's `state.wrappedUp ||`
 * guard), so the route must not re-run `buildWrapup`, must not advance any
 * state, and must not persist anything. The fixed line below is the ONLY
 * thing emitted. */
export const QUIZ_COMPLETE_LINE =
  "This quiz is complete — start a new one to keep going.";

export type QuizTurnResult =
  | { kind: "blocked"; signal: QuizBlockedSignal | QuizUnavailableSignal }
  | { kind: "complete" }
  | {
      kind: "ok";
      quizPrompt: string;
      nextState: QuizSessionState;
      /** The route (chat.ts) branches on `plan.buffered`/`plan.priorVerdict`
       * for verdict-turn emission (Task 6), on `plan.phase === "wrapup"`
       * for the wrap-up emission (Task 7), and persists `plan.nextState`
       * via `quizStore.write` itself, AFTER the turn completes. */
      plan: QuizTurnPlan;
    };

/** Scope-gate the opener. No git-dirty detector exists in the codebase yet
 * (checked — nothing wires "is this repo dirty" today), so `dirty` is
 * hardcoded `false`; that axis of the gate is a pass-through until a real
 * check lands (deferred). Staleness fails open (null → `stalenessVerdict`
 * reads `not_indexed`, never `"stale"`) when `resolveProjectRootByHash` is
 * absent or its read errors — same fail-open discipline the route's
 * existing R10/R14 staleness block already uses. */
async function gateOpener(
  deps: QuizRouteDeps,
  projHash: string,
  mg: ModuleGraph,
  scope: Scope,
): Promise<{ ok: true } | { ok: false; reason: "stale" | "scope_gone" | "dirty"; message: string }> {
  let staleness: IndexStaleness | null = null;
  let warnPct = 0.2;
  if (deps.resolveProjectRootByHash) {
    try {
      const projectRoot = await deps.resolveProjectRootByHash(projHash);
      if (projectRoot) {
        const rgCfg = await loadRepoGraphConfig(deps.homeBase);
        warnPct = rgCfg.staleness_warn_pct;
        staleness = await readIndexStaleness({ cwd: projectRoot, home: deps.homeBase });
      }
    } catch {
      // Fail-open — staleness stays null (see doc comment above).
    }
  }
  return gateScope({ staleness, warnPct, mg, scope, dirty: false });
}

/**
 * Run one quiz turn for `POST /api/chat`. Exactly one of `opener` /
 * `existingState` is expected non-null by the caller's mode-detection logic
 * (`body.quiz` present = opener; `quizStore.read` non-null = continuation).
 */
export async function runQuizTurn(
  input: {
    /** The raw chat message for this turn. Ignored on the opener (which has
     * no user answer yet — `prepareQuizTurn` is called with `userMessage:
     * null`); used verbatim as the continuation's answer to fact-check. */
    userMessage: string;
    opener: { proj_hash: string; scope_module_id: string | null } | null;
    existingState: QuizSessionState | null;
  },
  deps: QuizRouteDeps,
): Promise<QuizTurnResult> {
  const { opener, existingState } = input;

  if (opener) {
    const projHash = opener.proj_hash;
    const mg = deps.loadModuleGraph ? await deps.loadModuleGraph(projHash) : null;
    if (!mg) return { kind: "blocked", signal: { blocked: "quiz_unavailable", reason: "no_index" } };

    const scope: Scope = { moduleId: opener.scope_module_id };
    const gate = await gateOpener(deps, projHash, mg, scope);
    if (!gate.ok) {
      return {
        kind: "blocked",
        signal: { blocked: "quiz_blocked", reason: gate.reason, message: gate.message },
      };
    }

    const state: QuizSessionState = {
      mode: "quiz",
      scope,
      overlay: emptyOverlay(),
      currentTarget: pickTarget(mg, scope, emptyOverlay()),
      ladderStep: null,
      turnCount: 0,
      wrappedUp: false,
      projHash,
    };

    const plan = prepareQuizTurn({ userMessage: null, mg, state });
    return { kind: "ok", quizPrompt: plan.systemPrompt, nextState: plan.nextState, plan };
  }

  // Continuation — existingState is guaranteed non-null by the caller's
  // detection (quizStore.read returned non-null). `projHash` was set on the
  // state at opener time (folded in, Task 6) — no separate sidecar read.
  const state = existingState as QuizSessionState;

  // Task 7 dedupe — checked BEFORE loading the module graph (a deterministic
  // "quiz is over" reply needs no graph at all, and must not touch
  // `prepareQuizTurn`/`buildWrapup` a second time).
  if (state.wrappedUp) {
    return { kind: "complete" };
  }

  const mg = deps.loadModuleGraph ? await deps.loadModuleGraph(state.projHash) : null;
  if (!mg) return { kind: "blocked", signal: { blocked: "quiz_unavailable", reason: "no_index" } };

  const plan = prepareQuizTurn({ userMessage: input.userMessage, mg, state });
  return { kind: "ok", quizPrompt: plan.systemPrompt, nextState: plan.nextState, plan };
}
