// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Copyright (c) 2026 Jiaqi Duan
/**
 * Chat-memory correction (2026-07-02) — apply-side pure cores.
 *
 * Split out of transitions.ts at the 800-LOC cap; the import edge is strictly
 * one-directional (chat-claim-apply → transitions, no cycle).
 *
 * Everything here is memory-in → memory-out, no I/O. Multi-claim atomicity
 * is the CALLER doing ONE `writeMemory` of the returned object.
 */

import type { EntityRef } from "./entity";
import type { CoreMemory, Fact } from "./memory";
import { newId } from "./memory";
import {
  captureChatFactCore,
  findFact,
  replaceFact,
  RETIRED_REASON_SUPERSEDED,
} from "./transitions";

// ---------------------------------------------------------------------------
// Shared internals
// ---------------------------------------------------------------------------

/**
 * Reaffirm a fact in place — the field set `captureChatFactCore`'s exact-text
 * dedupe stamps (both clocks + recall_count bump + "reaffirmed" event). `reason`
 * tags the origin ("chat_restate" = classifier verdict, vs "chat_repeat" =
 * exact-text dedupe inside captureChatFactCore). NOTE: restateFactCore and
 * captureChatFactCore each carry an older inline copy of this stamp — folding
 * those onto this helper is a noted dedup opportunity, deliberately not done in
 * this surgical slice.
 */
function reaffirmFact(fact: Fact, ts: string, reason: string | null): Fact {
  return {
    ...fact,
    last_seen_at: ts,
    last_confirmed_at: ts,
    recall_count: fact.recall_count + 1,
    events: [...fact.events, { action: "reaffirmed", at: ts, reason }],
  };
}

/**
 * Construct the chat-provenance correction fact both cores share —
 * `captureChatFactCore`'s born-fact shape (confidence 1.0, stream "chat",
 * kind null, durable) plus the `supersedes` link. Only `status` differs:
 * "active" (auto-supersede) also stamps last_confirmed_at; "pending"
 * (mid-band proposal) leaves it null like `addFactCore`'s pending-first shape.
 */
function newChatCorrectionFact(
  input: SupersedeChatFactInput,
  status: "active" | "pending",
): Fact {
  const { ts } = input;
  const entities = input.entities ?? [];
  return {
    id: newId("f"),
    text: input.text,
    source_session_id: null,
    confidence: 1.0,
    status,
    created_at: ts,
    last_seen_at: ts,
    supersedes: input.targetId,
    superseded_by: null,
    pinned: false,
    recall_count: 0,
    retired_reason: null,
    stability: "durable",
    learned_from: { stream: "chat", session_id: null },
    kind: null,
    last_confirmed_at: status === "active" ? ts : null,
    expires_at: null,
    save_reason: input.saveReason ?? null,
    invalid_at: null,
    events: [{ action: "created", at: ts, reason: null }],
    ...(entities.length > 0 ? { entities } : {}),
  };
}

// ---------------------------------------------------------------------------
// supersedeChatFactCore — auto-replace
// ---------------------------------------------------------------------------

/** Input for the correction cores — an already layer-2-validated contradict claim. */
export interface SupersedeChatFactInput {
  text: string;
  entities?: EntityRef[];
  /** id of the ACTIVE fact this claim contradicts (validated again here — belt). */
  targetId: string;
  /** ISO timestamp shared by the whole turn (runner derives once per batch). */
  ts: string;
  /** Optional "why this was worth saving", stored on the new fact (default null). */
  saveReason?: string | null;
}

export interface SupersedeChatFactResult {
  memory: CoreMemory;
  /** The new born-active fact, or null when the belt no-opped. */
  fact: Fact | null;
  /** Post-retire snapshot of the old fact (carries oldText for the marker), null on no-op. */
  retired: Fact | null;
}

/**
 * The auto-replace transition for a high-confidence chat contradiction:
 * in ONE returned memory, a new fact is born ACTIVE (chat provenance, confidence
 * 1.0, `supersedes: targetId` — `captureChatFactCore`'s born-active shape) and
 * the target is retired (`retired_reason:"superseded"`, `superseded_by:<newId>`,
 * `invalid_at: ts` — `approveFactCore`'s retire-block semantics). At no point in
 * the returned object are both facts retired or both active.
 *
 * Belt (backstop): the target must exist AND be status "active";
 * otherwise the input memory is returned REFERENCE-EQUAL with `fact: null`
 * (same skip-writeMemory signal as `retireFactCore`'s idempotent no-op — the
 * runner's layer-2 re-derivation makes this branch unreachable in practice).
 * No dedupe / no reactivation: a correction ALWAYS creates a fresh fact so the
 * supersession chain stays fully linked (undo = supersede the superseder;
 * dedupe-reactivation is an explicitly-deferred nice-to-have).
 * Empty text throws — programmer-error contract, mirrors `captureChatFactCore`.
 * Pure: input memory is never mutated.
 */
export function supersedeChatFactCore(
  memory: CoreMemory,
  input: SupersedeChatFactInput,
): SupersedeChatFactResult {
  if (!input.text.trim()) {
    throw new Error("supersedeChatFactCore: empty text — caller must guard");
  }

  const target = findFact(memory, input.targetId);
  if (!target || target.fact.status !== "active") {
    return { memory, fact: null, retired: null }; // belt — reference-equal no-op
  }

  const { ts } = input;
  const newFact = newChatCorrectionFact(input, "active");

  const retiredOld: Fact = {
    ...target.fact,
    status: "retired",
    retired_reason: RETIRED_REASON_SUPERSEDED,
    invalid_at: ts,
    superseded_by: newFact.id,
    events: [...target.fact.events, { action: "retired", at: ts, reason: "superseded" }],
  };

  const withRetiredOld = replaceFact(memory, target.idx, retiredOld);
  const updatedMemory: CoreMemory = {
    ...withRetiredOld,
    facts: [...withRetiredOld.facts, newFact],
  };
  return { memory: updatedMemory, fact: newFact, retired: retiredOld };
}

// ---------------------------------------------------------------------------
// proposeChatFactCore — pending-replace
// ---------------------------------------------------------------------------

export interface ProposeChatFactResult {
  memory: CoreMemory;
  /** The new born-PENDING fact, or null when the belt no-opped. */
  fact: Fact | null;
  /** The (untouched, still-active) target — oldText source for the marker; null on no-op. */
  target: Fact | null;
}

/**
 * The mid-band pending-replace: a contradict claim whose confidence sits
 * in [T_MID, T_HIGH) lands as a new fact born PENDING with the `supersedes`
 * link + chat provenance; the target stays ACTIVE and literally untouched
 * (deliberately NO `superseded_by` proposed-link, unlike `addFactCore` — the
 * existing `approveFactCore` keys the later flip on the pending fact's
 * `supersedes` alone, so the /memory approve flow completes it with zero new UI).
 * Same belt, empty-text and purity contracts as `supersedeChatFactCore`
 * (symmetric core, only the born status + target treatment differ).
 */
export function proposeChatFactCore(
  memory: CoreMemory,
  input: SupersedeChatFactInput,
): ProposeChatFactResult {
  if (!input.text.trim()) {
    throw new Error("proposeChatFactCore: empty text — caller must guard");
  }

  const target = findFact(memory, input.targetId);
  if (!target || target.fact.status !== "active") {
    return { memory, fact: null, target: null }; // belt — reference-equal no-op
  }

  const pendingFact = newChatCorrectionFact(input, "pending");
  const updatedMemory: CoreMemory = { ...memory, facts: [...memory.facts, pendingFact] };
  return { memory: updatedMemory, fact: pendingFact, target: target.fact };
}

// ---------------------------------------------------------------------------
// applyChatClaimsCore — per-turn routing
// ---------------------------------------------------------------------------

/**
 * A chat claim AFTER the runner's layer-2 re-derivation:
 * classification is code-validated, and for contradict claims `tier` is derived
 * in the RUNNER from the numeric confidence vs T_HIGH/T_MID constants — this
 * core never sees a raw confidence and never trusts an LLM boolean.
 */
export interface ClassifiedClaim {
  text: string;
  entities?: EntityRef[];
  classification: "add" | "restate" | "contradict";
  /** Layer-2-validated target fact id; null for plain adds. */
  targetId: string | null;
  /** Contradict ladder rung (runner-derived). Absent on add/restate claims. */
  tier?: "auto" | "pending" | "drop";
}

/**
 * Per-claim outcome — the marker source for the runner:
 * - saved       → [SAVED: "text"]                       (fresh active fact)
 * - reaffirmed  → [ALREADY KNOWN: "text"]               (dedupe / restate reaffirm)
 * - replaced    → [REPLACED: "oldText" → "newText"]     (auto-supersede)
 * - proposed    → [PROPOSED-REPLACE: "newText" …]       (pending-replace)
 * - dropped     → no marker                             (sub-floor discard)
 */
export type ClaimOutcome =
  | { outcome: "saved"; factId: string; text: string }
  | { outcome: "reaffirmed"; factId: string; text: string }
  | { outcome: "replaced"; factId: string; newText: string; oldFactId: string; oldText: string }
  | { outcome: "proposed"; factId: string; newText: string; oldFactId: string; oldText: string }
  | { outcome: "dropped"; text: string };

export interface ApplyChatClaimsResult {
  memory: CoreMemory;
  results: ClaimOutcome[];
  /** How many contradict claims fell below T_MID (telemetry). */
  droppedCount: number;
}

/** One routed claim: the memory after it applied + its outcome. Null = blank-text skip. */
type ClaimApplication = { memory: CoreMemory; result: ClaimOutcome } | null;

/**
 * Route one contradict claim down the ladder. Returns null when the claim must
 * fall through to the add downgrade (phantom/non-active target — the
 * "else → add" path).
 */
function applyContradict(
  mem: CoreMemory,
  claim: ClassifiedClaim,
  ts: string,
  saveReason: string | null,
): ClaimApplication {
  const tier = claim.tier ?? "pending"; // conservative belt (see applyChatClaimsCore JSDoc)

  if (tier === "drop") {
    // Ladder floor — an explicit drop discards outright, target-validity
    // notwithstanding (below floor = discard, never a fallback save).
    return { memory: mem, result: { outcome: "dropped", text: claim.text } };
  }

  if (!claim.targetId) return null; // falls through to the add downgrade

  const input: SupersedeChatFactInput = {
    text: claim.text,
    entities: claim.entities,
    targetId: claim.targetId,
    ts,
    saveReason,
  };

  if (tier === "auto") {
    const res = supersedeChatFactCore(mem, input);
    if (!res.fact || !res.retired) return null; // belt no-op → falls through to the add downgrade
    return {
      memory: res.memory,
      result: {
        outcome: "replaced",
        factId: res.fact.id,
        newText: res.fact.text,
        oldFactId: res.retired.id,
        oldText: res.retired.text,
      },
    };
  }

  // tier "pending" — pending-replace.
  const res = proposeChatFactCore(mem, input);
  if (!res.fact || !res.target) return null; // belt no-op → falls through to the add downgrade
  return {
    memory: res.memory,
    result: {
      outcome: "proposed",
      factId: res.fact.id,
      newText: res.fact.text,
      oldFactId: res.target.id,
      oldText: res.target.text,
    },
  };
}

/** Route one classified claim (see `applyChatClaimsCore` for the routing table). */
function applyOneClaim(
  mem: CoreMemory,
  claim: ClassifiedClaim,
  ts: string,
  saveReason: string | null,
): ClaimApplication {
  if (!claim.text.trim()) return null; // the cores throw on empty — skip blank claims

  if (claim.classification === "contradict") {
    const routed = applyContradict(mem, claim, ts, saveReason);
    if (routed) return routed;
    // belt no-op (phantom / non-active target) → falls through to the add downgrade below
  }

  if (claim.classification === "restate" && claim.targetId) {
    const found = findFact(mem, claim.targetId);
    if (found && found.fact.status === "active") {
      const refreshed = reaffirmFact(found.fact, ts, "chat_restate");
      return {
        memory: replaceFact(mem, found.idx, refreshed),
        result: { outcome: "reaffirmed", factId: found.fact.id, text: found.fact.text },
      };
    }
    // phantom / non-active target → falls through to the add downgrade below
  }

  // add — plus the downgrade path: restate/contradict whose target is missing
  // or non-active at apply time (the "else → add" path).
  const res = captureChatFactCore(mem, claim.text, () => ts, saveReason, claim.entities ?? []);
  if (!res.ok) return null; // unreachable on non-empty text — type narrow only
  return {
    memory: res.memory,
    result: res.deduped
      ? { outcome: "reaffirmed", factId: res.fact.id, text: res.fact.text }
      : { outcome: "saved", factId: res.fact.id, text: res.fact.text },
  };
}

/**
 * Apply a turn's classified chat claims to `memory` and return ONE new memory
 * object — multi-claim atomicity is the CALLER doing a single
 * `writeMemory` of the result. If nothing changed (all dropped / all blank /
 * empty list) the input memory is returned REFERENCE-EQUAL so the caller can
 * skip the write.
 *
 * Routing per claim:
 * - `add`                      → `captureChatFactCore` (exact-text dedupe intact;
 *                                dedupe hit reports `reaffirmed`, else `saved`).
 * - `restate` (active target)  → reaffirm the target in place — the same field
 *                                set as `captureChatFactCore`'s dedupe (both
 *                                clocks + recall_count + "reaffirmed" event),
 *                                tagged reason:"chat_restate" to mark the
 *                                classifier origin (vs "chat_repeat" = exact-text).
 * - `contradict` tier "auto"   → `supersedeChatFactCore`.
 * - `contradict` tier "pending"→ `proposeChatFactCore`.
 * - `contradict` tier "drop"   → no store change, counted. An explicit
 *                                drop wins over target-invalid downgrade —
 *                                below-floor is a discard, never a fallback save.
 * - `contradict` missing tier  → treated as "pending" (conservative belt: never
 *                                auto-retire without an explicit runner-derived
 *                                tier, never silently drop).
 *
 * Claims apply SEQUENTIALLY over the accumulating memory — claim N sees claim
 * N-1's effect. Honest semantic for a target invalidated mid-batch (e.g. two
 * contradicts against the same target): the belt no-ops and the claim
 * DOWNGRADES TO ADD (the "else → add" path), preserving the user's statement
 * as a visible active fact instead of silently dropping or phantom-superseding.
 * The same downgrade applies to restate/contradict with a phantom or non-active
 * target at apply time. Blank-text claims are skipped with no result entry
 * (`captureChatFactsCore` idiom).
 * `saveReason` (optional, default null) threads onto every fact this call
 * creates — adds, auto-supersede replacements and pending proposals alike (the
 * runner passes its capture-provenance string, e.g. SAVE_REASON_AUTO).
 * Pure: input memory is never mutated.
 */
export function applyChatClaimsCore(
  memory: CoreMemory,
  claims: ClassifiedClaim[],
  ts: string,
  saveReason: string | null = null,
): ApplyChatClaimsResult {
  let mem = memory;
  const results: ClaimOutcome[] = [];
  let droppedCount = 0;

  for (const claim of claims) {
    const applied = applyOneClaim(mem, claim, ts, saveReason);
    if (!applied) continue;
    mem = applied.memory;
    results.push(applied.result);
    if (applied.result.outcome === "dropped") droppedCount += 1;
  }

  return { memory: mem, results, droppedCount };
}
