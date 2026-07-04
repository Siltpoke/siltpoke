// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
// Copyright (c) 2026 Jiaqi Duan
/**
 * Pure-function state transition core for facts.
 *
 * Design: functional-core-imperative-shell.
 *
 * Both transitions return a `TransitionResult` discriminated union:
 *   - { ok: true,  memory, fact }  — caller writes new memory and surfaces fact
 *   - { ok: false, error }         — caller maps error.kind to HTTP/CLI status
 *
 * Immutability: input `memory` is never mutated. On the happy path a new
 * top-level memory object and a new `facts` array are returned (unchanged
 * facts share references — shallow copy is sufficient).
 *
 * Idempotency: `retireFactCore` on an already-retired fact returns the input
 * `memory` reference unchanged. HTTP/CLI callers use reference equality
 * (`result.memory === input`) as the signal to skip `writeMemory`.
 */

import type { EntityRef } from "./entity";
import type { CoreMemory, Fact } from "./memory";
import { newId } from "./memory";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Input for `addFactCore` — the validated, user-confirmed candidate coming from
 * the NL-edit composer. `supersedes` is set ONLY on the replace path; when
 * present, the named old fact gets a "supersession proposed" link but stays
 * active until the new fact is approved (see `addFactCore` / `approveFactCore`).
 */
export interface FactDraft {
  text: string;
  confidence: number;
  save_reason?: string | null;
  supersedes?: string | null;
}

export type TransitionError =
  | { kind: "not_found"; id: string }
  | { kind: "not_pending"; current_status: Fact["status"] }
  | { kind: "not_retire_proposed"; current_status: Fact["status"] }
  | { kind: "not_retired"; current_status: Fact["status"] }
  | { kind: "already_retired" };

export type TransitionResult =
  | { ok: true; memory: CoreMemory; fact: Fact }
  | { ok: false; error: TransitionError };

type NowFn = () => string;

const defaultNow: NowFn = () => new Date().toISOString();

// Typed constant for the only HTTP/CLI-callable retire reason. Constraining
// against `NonNullable<Fact["retired_reason"]>` ties the value to the schema
// enum — renaming or removing the enum member becomes a compile error here
// rather than a silent runtime drift.
const RETIRED_REASON_USER_REJECTED = "user_rejected" as const satisfies NonNullable<
  Fact["retired_reason"]
>;

// Retire reason stamped on the OLD fact when its supersession is resolved
// (the new fact approved). Tied to the schema enum the same way as above.
// Exported for the chat-correction apply cores (chat-claim-apply.ts), which
// mirror this retire block.
export const RETIRED_REASON_SUPERSEDED = "superseded" as const satisfies NonNullable<
  Fact["retired_reason"]
>;

// ---------------------------------------------------------------------------
// Internal helpers — exported ONLY as the seam for chat-claim-apply.ts (the
// chat-correction apply cores split out at the 800-LOC cap). Import edge is
// one-directional: chat-claim-apply → transitions. Not part of the public
// transition API.
// ---------------------------------------------------------------------------

export function findFact(
  memory: CoreMemory,
  id: string,
): { idx: number; fact: Fact } | null {
  const idx = memory.facts.findIndex((f) => f.id === id);
  if (idx === -1) return null;
  return { idx, fact: memory.facts[idx]! };
}

export function replaceFact(
  memory: CoreMemory,
  idx: number,
  updated: Fact,
): CoreMemory {
  const facts = memory.facts;
  const updatedFacts = [...facts.slice(0, idx), updated, ...facts.slice(idx + 1)];
  return { ...memory, facts: updatedFacts };
}

// ---------------------------------------------------------------------------
// Transitions
// ---------------------------------------------------------------------------

/**
 * Create a NEW fact from a user-typed, validated draft. Always born
 * `pending` (approval flips it active via the ✓确认 button / `approveFactCore`).
 *
 * Provenance is fixed to `{stream: "user", session_id: null}` (typed via the
 * /memory composer); stability defaults to `durable`; confidence + save_reason
 * + optional supersedes come from the draft.
 *
 * Supersession (replace path): when `draft.supersedes` is set, the named old
 * fact must exist (else `not_found`). The old fact gets `superseded_by = <new
 * id>` (a "supersession proposed" link) but stays ACTIVE — it is NOT retired
 * here. Retirement happens only when the new fact is approved
 * (`approveFactCore`); rejection clears the link (`retireFactCore`).
 *
 * - supersedes names a missing fact → { ok: false, error: { kind: "not_found", id } }
 * - otherwise                       → { ok: true, memory: <new>, fact: <new pending fact> }
 */
export function addFactCore(
  memory: CoreMemory,
  draft: FactDraft,
  now: NowFn = defaultNow,
): TransitionResult {
  const ts = now();
  const newFactId = newId("f");
  const newFact: Fact = {
    id: newFactId,
    text: draft.text,
    source_session_id: null,
    confidence: draft.confidence,
    status: "pending",
    created_at: ts,
    last_seen_at: ts,
    supersedes: draft.supersedes ?? null,
    superseded_by: null,
    pinned: false,
    recall_count: 0,
    retired_reason: null,
    stability: "durable",
    learned_from: { stream: "user", session_id: null },
    kind: null,
    last_confirmed_at: null,
    expires_at: null,
    save_reason: draft.save_reason ?? null,
    invalid_at: null,
    events: [{ action: "created", at: ts, reason: null }],
  };

  // No supersede link → plain append.
  if (!newFact.supersedes) {
    const updatedMemory: CoreMemory = {
      ...memory,
      facts: [...memory.facts, newFact],
    };
    return { ok: true, memory: updatedMemory, fact: newFact };
  }

  // Replace path: link the old fact (must exist) but leave it active.
  const old = findFact(memory, newFact.supersedes);
  if (!old) {
    return { ok: false, error: { kind: "not_found", id: newFact.supersedes } };
  }
  const linkedOld: Fact = { ...old.fact, superseded_by: newFactId };
  const withLinkedOld = replaceFact(memory, old.idx, linkedOld);
  const updatedMemory: CoreMemory = {
    ...withLinkedOld,
    facts: [...withLinkedOld.facts, newFact],
  };
  return { ok: true, memory: updatedMemory, fact: newFact };
}

/**
 * Restate (reconfirm) an existing fact named by the NL-edit classifier.
 *
 * - not found  → { ok: false, error: { kind: "not_found", id } }
 * - pending    → delegates to `approveFactCore` (restating a pending fact IS an
 *                approval → active + reconfirm stamps).
 * - otherwise  → reconfirm in place: refresh last_seen_at + last_confirmed_at
 *                AND bump recall_count (the active-fact analogue of keepFactCore),
 *                status unchanged.
 */
export function restateFactCore(
  memory: CoreMemory,
  id: string,
  now: NowFn = defaultNow,
): TransitionResult {
  const found = findFact(memory, id);
  if (!found) {
    return { ok: false, error: { kind: "not_found", id } };
  }

  const { idx, fact } = found;

  // Pending → restate is an approval.
  if (fact.status === "pending") {
    return approveFactCore(memory, id, now);
  }

  // Active (or other) → reconfirm: stamp both clocks, leave status as-is.
  // Reuse recall_count: a user reaffirmation is a strong "this fact keeps
  // mattering" signal, so we bump recall_count here (it already feeds
  // decay-protection). Only the active-reconfirm path bumps it — the
  // pending→approve branch above delegates to approveFactCore (first approval
  // ≠ reaffirmation) and deliberately does NOT bump recall_count.
  const ts = now();
  const updatedFact: Fact = {
    ...fact,
    last_seen_at: ts,
    last_confirmed_at: ts,
    recall_count: fact.recall_count + 1,
    events: [...fact.events, { action: "reaffirmed", at: ts, reason: null }],
  };
  const updatedMemory = replaceFact(memory, idx, updatedFact);
  return { ok: true, memory: updatedMemory, fact: updatedFact };
}

/**
 * Approve a pending fact: pending → active.
 *
 * - Not found     → { ok: false, error: { kind: "not_found", id } }
 * - Already active/retired → { ok: false, error: { kind: "not_pending", current_status } }
 * - pending       → { ok: true, memory: <new>, fact: <updated> } with
 *                   status="active", last_seen_at = now() and
 *                   last_confirmed_at = now() (approval IS a reconfirmation,
 *                   resetting the durable-staleness clock — see decay.isStale).
 */
export function approveFactCore(
  memory: CoreMemory,
  id: string,
  now: NowFn = defaultNow,
): TransitionResult {
  const found = findFact(memory, id);
  if (!found) {
    return { ok: false, error: { kind: "not_found", id } };
  }

  const { idx, fact } = found;

  if (fact.status !== "pending") {
    return {
      ok: false,
      error: { kind: "not_pending", current_status: fact.status },
    };
  }

  const ts = now();
  const updatedFact: Fact = {
    ...fact,
    status: "active",
    last_seen_at: ts,
    last_confirmed_at: ts,
    events: [...fact.events, { action: "approved", at: ts, reason: null }],
  };
  let updatedMemory = replaceFact(memory, idx, updatedFact);

  // Supersession resolution: approving a fact that supersedes an older one
  // atomically retires the old fact (recency-wins soft-invalidate). The old
  // fact is stamped retired + retired_reason="superseded" + invalid_at=now,
  // and keeps its superseded_by link pointing at this (the new) fact. Done in
  // the SAME transition so there is never a window where neither is active.
  //
  // Stale-supersession guard: the retire-stamp is
  // skipped ONLY when the target is already RETIRED. If something else retired
  // it first (e.g. a chat auto-supersede won the race against a mid-band
  // pending proposal), the approved fact still goes active with its
  // historically accurate `supersedes` link, but the target keeps its original
  // superseded_by / invalid_at / single retired event — never re-stamped.
  // Any other non-active status (notably retire_proposed from the decay sweep,
  // which appends NO event on active→retire_proposed) still gets the
  // retire-stamp — otherwise a decayed target would strand in the confirm
  // queue and a later "keep" would reactivate it alongside its own replacement
  // (two actives for one claim).
  if (updatedFact.supersedes) {
    const old = findFact(updatedMemory, updatedFact.supersedes);
    if (old && old.fact.status !== "retired") {
      const retiredOld: Fact = {
        ...old.fact,
        status: "retired",
        retired_reason: RETIRED_REASON_SUPERSEDED,
        invalid_at: ts,
        superseded_by: updatedFact.id,
        events: [...old.fact.events, { action: "retired", at: ts, reason: "superseded" }],
      };
      updatedMemory = replaceFact(updatedMemory, old.idx, retiredOld);
    }
  }

  return { ok: true, memory: updatedMemory, fact: updatedFact };
}

/**
 * Retire a fact: * → retired (with retired_reason="user_rejected").
 *
 * - Not found              → { ok: false, error: { kind: "not_found", id } }
 * - Already retired        → { ok: true, memory: <input ref>, fact }  (idempotent)
 * - pending or active      → { ok: true, memory: <new>, fact: <updated> }
 *
 * Matches CLI `reject-fact.ts` parity: status + retired_reason are the only
 * fields written. `last_seen_at` is NOT bumped on retire (the CLI doesn't
 * either, and the field is meant for "fact most recently re-observed", which
 * a retirement event is not). The `now` parameter timestamps the retirement event.
 */
export function retireFactCore(
  memory: CoreMemory,
  id: string,
  _now: NowFn = defaultNow,
): TransitionResult {
  const found = findFact(memory, id);
  if (!found) {
    return { ok: false, error: { kind: "not_found", id } };
  }

  const { idx, fact } = found;

  // Idempotent: same input memory reference signals caller to skip writeMemory.
  if (fact.status === "retired") {
    return { ok: true, memory, fact };
  }

  const ts = _now();
  const updatedFact: Fact = {
    ...fact,
    status: "retired",
    retired_reason: RETIRED_REASON_USER_REJECTED,
    events: [...fact.events, { action: "retired", at: ts, reason: "user_rejected" }],
  };
  let updatedMemory = replaceFact(memory, idx, updatedFact);

  // Reject path: rejecting a fact that proposed a supersession clears the
  // OLD fact's superseded_by link (only if it still points at this fact) so the
  // old fact stays cleanly active with no dangling link — the coexistence /
  // mis-judgement escape hatch.
  if (updatedFact.supersedes) {
    const old = findFact(updatedMemory, updatedFact.supersedes);
    if (old && old.fact.superseded_by === updatedFact.id) {
      const cleared: Fact = { ...old.fact, superseded_by: null };
      updatedMemory = replaceFact(updatedMemory, old.idx, cleared);
    }
  }

  return { ok: true, memory: updatedMemory, fact: updatedFact };
}

/**
 * Confirm retirement of a decay proposal: retire_proposed → retired (retired_reason="decayed").
 * Human-confirm of a decay proposal.
 *
 * - Not found              → { ok: false, error: { kind: "not_found", id } }
 * - Not retire_proposed    → { ok: false, error: { kind: "not_retire_proposed", current_status } }
 * - retire_proposed        → { ok: true, memory: <new>, fact: <updated> }
 */
export function confirmRetireFactCore(
  memory: CoreMemory,
  id: string,
  _now: NowFn = defaultNow,
): TransitionResult {
  const found = findFact(memory, id);
  if (!found) {
    return { ok: false, error: { kind: "not_found", id } };
  }

  const { idx, fact } = found;

  if (fact.status !== "retire_proposed") {
    return { ok: false, error: { kind: "not_retire_proposed", current_status: fact.status } };
  }

  const ts = _now();
  const updatedFact: Fact = {
    ...fact,
    status: "retired",
    retired_reason: "decayed",
    events: [...fact.events, { action: "retired", at: ts, reason: "decayed" }],
  };
  const updatedMemory = replaceFact(memory, idx, updatedFact);
  return { ok: true, memory: updatedMemory, fact: updatedFact };
}

/**
 * Keep a fact from retiring: retire_proposed → active, refreshing last_seen_at
 * (resets the decay clock).
 *
 * - Not found              → { ok: false, error: { kind: "not_found", id } }
 * - Not retire_proposed    → { ok: false, error: { kind: "not_retire_proposed", current_status } }
 * - retire_proposed        → { ok: true, memory: <new>, fact: <updated> }
 */
export function keepFactCore(
  memory: CoreMemory,
  id: string,
  now: NowFn = defaultNow,
): TransitionResult {
  const found = findFact(memory, id);
  if (!found) {
    return { ok: false, error: { kind: "not_found", id } };
  }

  const { idx, fact } = found;

  if (fact.status !== "retire_proposed") {
    return { ok: false, error: { kind: "not_retire_proposed", current_status: fact.status } };
  }

  // Keep/revive is a RECONFIRMATION — stamp last_confirmed_at
  // so the revived fact's staleness clock resets, same as approveFactCore.
  const ts = now();
  const updatedFact: Fact = {
    ...fact,
    status: "active",
    last_seen_at: ts,
    last_confirmed_at: ts,
    events: [...fact.events, { action: "reactivated", at: ts, reason: null }],
  };
  const updatedMemory = replaceFact(memory, idx, updatedFact);
  return { ok: true, memory: updatedMemory, fact: updatedFact };
}

/**
 * Reactivate a retired fact: retired → active (undo a retire).
 *
 * - Not found        → { ok: false, error: { kind: "not_found", id } }
 * - Not retired      → { ok: false, error: { kind: "not_retired", current_status } }
 * - retired          → { ok: true, memory: <new>, fact: <updated> } with
 *                      status="active", retired_reason cleared, and
 *                      last_seen_at = last_confirmed_at = now() (revival IS a
 *                      reconfirmation — resets the decay clock, same as
 *                      approveFactCore / keepFactCore).
 */
export function reactivateFactCore(
  memory: CoreMemory,
  id: string,
  now: NowFn = defaultNow,
): TransitionResult {
  const found = findFact(memory, id);
  if (!found) {
    return { ok: false, error: { kind: "not_found", id } };
  }

  const { idx, fact } = found;

  if (fact.status !== "retired") {
    return {
      ok: false,
      error: { kind: "not_retired", current_status: fact.status },
    };
  }

  const ts = now();
  const updatedFact: Fact = {
    ...fact,
    status: "active",
    retired_reason: null,
    last_seen_at: ts,
    last_confirmed_at: ts,
    events: [...fact.events, { action: "reactivated", at: ts, reason: null }],
  };
  const updatedMemory = replaceFact(memory, idx, updatedFact);
  return { ok: true, memory: updatedMemory, fact: updatedFact };
}

/**
 * Set the pinned flag (decay-exempt). Allowed on any non-retired fact.
 *
 * - Not found   → { ok: false, error: { kind: "not_found", id } }
 * - Retired     → { ok: false, error: { kind: "already_retired" } }
 * - Other       → { ok: true, memory: <new>, fact: <updated> }
 */
export function setFactPinnedCore(
  memory: CoreMemory,
  id: string,
  pinned: boolean,
  _now: NowFn = defaultNow,
): TransitionResult {
  const found = findFact(memory, id);
  if (!found) {
    return { ok: false, error: { kind: "not_found", id } };
  }

  const { idx, fact } = found;

  if (fact.status === "retired") {
    return { ok: false, error: { kind: "already_retired" } };
  }

  const updatedFact: Fact = { ...fact, pinned };
  const updatedMemory = replaceFact(memory, idx, updatedFact);
  return { ok: true, memory: updatedMemory, fact: updatedFact };
}

/**
 * Re-tag a fact's communication-style classification: kind → "style" | "profile"
 * (the /memory badge + re-tag affordance). Only `kind` changes (INV1). Idempotent:
 * setting the same kind returns the input memory REFERENCE unchanged, so the
 * caller skips writeMemory (same signal as retireFactCore). Allowed on any status
 * — kind is orthogonal to active/pending/retired. A manual kind sticks: the
 * daemon-startup backfill (ensure-fact-kinds) only seeds untagged facts.
 */
export function setFactKindCore(
  memory: CoreMemory,
  id: string,
  kind: "style" | "profile",
  _now: NowFn = defaultNow,
): TransitionResult {
  const found = findFact(memory, id);
  if (!found) {
    return { ok: false, error: { kind: "not_found", id } };
  }

  const { idx, fact } = found;

  if (fact.kind === kind) {
    return { ok: true, memory, fact }; // idempotent — no change, no write
  }

  const updatedFact: Fact = { ...fact, kind };
  const updatedMemory = replaceFact(memory, idx, updatedFact);
  return { ok: true, memory: updatedMemory, fact: updatedFact };
}

/**
 * Real-time chat capture (Memory campaign) — persist an explicit "记住 X" fact
 * told to the pet in chat. Mirrors the `/remember` active-trust path (pushFact)
 * but lands here in the pure core for consistency with the other transitions.
 *
 * New fact: status="active", learned_from.stream="chat", kind=null,
 * pinned=false, stability="durable", confidence=1.0, all clocks = now,
 * events=[created]. (Differs from /remember, which is pinned+permanent — a chat
 * "记住" is a durable working-fact, correctable later on /memory.)
 *
 * Dedupe: if an existing ACTIVE fact has normalized-equal text (trim +
 * lowercase, COMPARE only — stored text is never mutated), no duplicate is
 * created; instead that fact's last_confirmed_at is refreshed and a reconfirm
 * event is appended. Only `active` facts block — a retired/pending fact with the
 * same text does NOT dedupe (a fresh active fact is created).
 *
 * Schema deviation: the factEvent action enum (memory.ts) has no "confirmed"
 * member; the closest valid action is "reaffirmed" (the same one
 * restateFactCore stamps on an active-fact reconfirmation), tagged
 * reason:"chat_repeat" to mark the dedupe origin.
 *
 * Precondition: `text` must be non-empty. Trigger-only "记住" with no
 * content is the CALLER's no-op-with-feedback responsibility (chat.ts guards
 * payload === "" before calling); empty text reaching here is a programmer
 * error, signalled by `throw` — deliberately kept OUT of the ok/error
 * TransitionError union (which models domain outcomes, not contract violations).
 *
 * On a valid payload always returns ok:true (no domain failure mode); the
 * imperative shell handles writeMemory errors. `deduped` tells the caller which
 * ack to surface.
 */
export function captureChatFactCore(
  memory: CoreMemory,
  text: string,
  now: NowFn = defaultNow,
  saveReason: string | null = null,
  entities: EntityRef[] = [],
): TransitionResult & { deduped: boolean } {
  if (!text.trim()) {
    throw new Error("captureChatFactCore: empty text — caller must guard");
  }

  const ts = now();
  const normalized = text.trim().toLowerCase();

  // Dedupe: reaffirm an existing active fact with normalized-equal text. Mirrors
  // restateFactCore's in-place reconfirm — refresh BOTH clocks (last_seen_at is
  // the decay staleness clock) + bump recall_count, so a fact the user just
  // re-mentioned in chat does not keep looking stale to the decay logic.
  const dupeIdx = memory.facts.findIndex(
    (f) => f.status === "active" && f.text.trim().toLowerCase() === normalized,
  );
  if (dupeIdx !== -1) {
    const existing = memory.facts[dupeIdx]!;
    const refreshed: Fact = {
      ...existing,
      last_seen_at: ts,
      last_confirmed_at: ts,
      recall_count: existing.recall_count + 1,
      events: [...existing.events, { action: "reaffirmed", at: ts, reason: "chat_repeat" }],
    };
    const updatedMemory = replaceFact(memory, dupeIdx, refreshed);
    return { ok: true, memory: updatedMemory, fact: refreshed, deduped: true };
  }

  const newFact: Fact = {
    id: newId("f"),
    text,
    source_session_id: null,
    confidence: 1.0,
    status: "active",
    created_at: ts,
    last_seen_at: ts,
    supersedes: null,
    superseded_by: null,
    pinned: false,
    recall_count: 0,
    retired_reason: null,
    stability: "durable",
    learned_from: { stream: "chat", session_id: null },
    kind: null,
    last_confirmed_at: ts,
    expires_at: null,
    save_reason: saveReason,
    invalid_at: null,
    events: [{ action: "created", at: ts, reason: null }],
    ...(entities.length > 0 ? { entities } : {}),
  };
  const updatedMemory: CoreMemory = { ...memory, facts: [...memory.facts, newFact] };
  return { ok: true, memory: updatedMemory, fact: newFact, deduped: false };
}

/**
 * One captured chat claim's outcome after `captureChatFactsCore`.
 * `deduped:true` = the claim reaffirmed an existing active fact (no new fact);
 * `deduped:false` = a fresh fact was created.
 */
export interface BatchCaptureItem {
  text: string;
  deduped: boolean;
}

export interface BatchCaptureResult {
  memory: CoreMemory;
  saved: BatchCaptureItem[];
}

/**
 * Apply N chat-captured claims to `memory`, threading the result of each
 * `captureChatFactCore` into the next (so dedupe sees facts added earlier in the
 * same batch). Blank/whitespace claims are skipped (`captureChatFactCore` throws
 * on empty). Each surviving claim reports whether it was a dedupe-reaffirm
 * (`deduped:true`) or a fresh save (`deduped:false`) — the caller derives the
 * truthful capture ack (SAVED vs ALREADY KNOWN) from these flags.
 *
 * Each item's optional `entities` (extracted by `extractDurableFacts`, or absent
 * for the explicit "记住 X" path which has no extractor) thread through to
 * `captureChatFactCore` so a fresh fact carries the entities it was extracted with.
 *
 * Pure: input `memory` is never mutated (each transition shallow-copies).
 */
export function captureChatFactsCore(
  memory: CoreMemory,
  items: Array<{ text: string; entities?: EntityRef[] }>,
  now: NowFn = defaultNow,
  saveReason: string | null = null,
): BatchCaptureResult {
  let mem = memory;
  const saved: BatchCaptureItem[] = [];
  for (const item of items) {
    // captureChatFactCore throws on empty — guard each claim.
    if (!item.text.trim()) continue;
    const res = captureChatFactCore(mem, item.text, now, saveReason, item.entities ?? []);
    // Non-empty text never yields ok:false (the core throws on empty, guarded
    // above) — the narrow is for the type system, not a real failure mode.
    if (res.ok) {
      mem = res.memory;
      saved.push({ text: res.fact.text, deduped: res.deduped });
    }
  }
  return { memory: mem, saved };
}

// Chat-memory correction (2026-07-02) apply-side cores — supersedeChatFactCore /
// proposeChatFactCore / applyChatClaimsCore — live in ./chat-claim-apply.ts
// (split at the 800-LOC cap; import edge chat-claim-apply → transitions only).
