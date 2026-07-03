// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Copyright (c) 2026 Jiaqi Duan
/**
 * extractDurableFacts — one gated-already, ledgered Haiku call that distills
 * durable facts ABOUT THE USER from a single chat message.
 *
 * Mirrors the gated+ledgered precedent in `repo-summary.ts` (NOT the
 * unledgered `facts/parse`): the caller has already passed the send-gate
 * (chat.ts top gate), so this needs no second gate — it just runs the cheap
 * extraction on the success path and ledgers the spend so future budget gates
 * stay honest.
 *
 * 🟢 Never throws — any CLI/timeout/parse failure degrades to `[]` (the caller
 * treats that as "nothing to capture", reply still streams). The routing
 * decision (whether to call this at all) is made upstream in code by
 * `looksLikeFactStatement` (security rule: paid call gated from code).
 */

import { z } from "zod";
import { callBrainRaw } from "../brain/brain";
import type { EntityRef } from "./entity";
import { ledgerBrainCall } from "../state/usage";

const EXTRACT_MODEL = "claude-haiku-4-5-20251001";
const EXTRACT_TIMEOUT_MS = 60_000;

// Trimmed single-message version of the summarizer durability framing
// (summarizer.ts SUMMARIZER_SYSTEM_PROMPT + durability test). No existing-facts
// context in the base prompt — dedupe happens downstream in captureChatFactCore.
const EXTRACT_CORE_PROMPT =
  "Extract ONLY durable facts ABOUT THE USER from their message — preferences, " +
  "identity, project context, stable habits. DURABILITY TEST: emit a fact only " +
  "if it would still matter next week. EXCLUDE ephemeral mood ('我今天累了'), " +
  "one-off task requests ('帮我看 bug'), questions, and anything not about the " +
  "user. Each fact: atomic, third-person, ≤280 chars (e.g. '喜欢奶油海绵蛋糕'). " +
  "For each fact also list the named entities it is about — people, places, " +
  "hobbies, projects, things — as a canonical short name + type " +
  "(person|place|hobby|project|thing|other). Empty list if the fact names nothing. ";

// No-candidates prompt — byte-identical to the pre-classification prompt
// (this is the rollback path: candidates absent → today's add-only behavior).
const EXTRACT_SYSTEM_PROMPT =
  EXTRACT_CORE_PROMPT +
  'Reply with ONLY JSON: {"facts": [{"text": "...", "entities": [{"name": "...", "type": "..."}]}]}. ' +
  "Empty facts array if nothing durable.";

// Classification rules — adapted from NL_EDIT_SYSTEM_PROMPT (nl-edit.ts),
// per-fact instead of per-message, incl. the numeric-specifics guard.
const EXTRACT_CLASSIFY_RULES =
  "You are also given the user's existing memory facts as CANDIDATE FACTS " +
  "(lines of `- <id>: <text>`). For EACH extracted fact, additionally classify " +
  "it against the candidates: " +
  '"restate" — a candidate means the SAME thing → set target_fact_id to that candidate\'s id. ' +
  '"contradict" — the fact DIRECTLY contradicts a candidate (they cannot both be true) → set target_fact_id to that candidate\'s id. ' +
  '"add" — neither; net-new information → target_fact_id = null. ' +
  "GUARD: facts that are merely similar, or that differ only in specifics " +
  "(especially numeric values, quantities, or added detail), are NOT " +
  'contradictions and NOT restatements — classify those as "add". Only mark ' +
  '"contradict" when the two cannot both be true. ' +
  "confidence: 0-1, how confident you are in the extracted fact and its classification. " +
  "target_fact_id MUST be one of the provided candidate ids, or null. Never invent an id. ";

// Candidates-present prompt — same extraction contract + per-fact classification.
const EXTRACT_CLASSIFY_SYSTEM_PROMPT =
  EXTRACT_CORE_PROMPT +
  EXTRACT_CLASSIFY_RULES +
  'Reply with ONLY JSON: {"facts": [{"text": "...", "entities": [{"name": "...", "type": "..."}], ' +
  '"classification": "add"|"restate"|"contradict", "target_fact_id": "<candidate-id>"|null, ' +
  '"confidence": 0.0-1.0}]}. Empty facts array if nothing durable.';

const entityRefLoose = z.object({
  name: z.string(),
  type: z.enum(["person", "place", "hobby", "project", "thing", "other"]).nullable().optional(),
});
// Classification fields arrive from an UNTRUSTED small model — accept ANY
// shape here and normalize in code below (fail-open to "add"), so one bad
// field never rejects the fact or the whole batch (lenient discipline;
// the fence-strip lives upstream in callBrainRaw).
const factsSchema = z.object({
  facts: z.array(
    z.object({
      text: z.string(),
      entities: z.array(entityRefLoose).optional(),
      classification: z.unknown().optional(),
      target_fact_id: z.unknown().optional(),
      confidence: z.unknown().optional(),
    }),
  ),
});

export type FactClassification = "add" | "restate" | "contradict";

/** An active fact the extractor may classify against (id + display text). */
export interface CandidateFact {
  id: string;
  text: string;
}

export interface ExtractedFact {
  text: string;
  entities: EntityRef[];
  /** Only present when candidates were provided. Missing/invalid LLM verdict
   *  fails open to "add" (never rejects the fact). */
  classification?: FactClassification;
  /** Candidate id named by restate/contradict; null when absent/invalid. NOT
   *  validated against the candidate list here — that re-derivation (target
   *  must be active + in-list, else downgrade to add) is the runner's layer-2. */
  target_fact_id?: string | null;
  /** Model-reported confidence, kept only when a finite number in [0,1];
   *  undefined otherwise (NOT clamped — never inflate an uncalibrated score).
   *  Routing from this number happens in the runner, never here. */
  confidence?: number;
}

function normalizeClassification(v: unknown): FactClassification {
  return v === "restate" || v === "contradict" ? v : "add";
}

function normalizeTargetId(v: unknown): string | null {
  return typeof v === "string" && v.length > 0 ? v : null;
}

function normalizeConfidence(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) && v >= 0 && v <= 1 ? v : undefined;
}

/** `CANDIDATE FACTS` block + user message (mirrors nl-edit's assemblePrompt). */
function assembleContextBundle(message: string, candidates: CandidateFact[]): string {
  const lines = candidates.map((c) => `- ${c.id}: ${c.text}`).join("\n");
  return `CANDIDATE FACTS:\n${lines}\n\nUSER MESSAGE:\n${message}`;
}

export interface ExtractDurableFactsDeps {
  homeBase: string;
  sessionId: string;
}

export interface ExtractDurableFactsInject {
  callBrainRaw?: typeof callBrainRaw;
  ledger?: typeof ledgerBrainCall;
}

export async function extractDurableFacts(
  message: string,
  deps: ExtractDurableFactsDeps,
  candidates?: CandidateFact[],
  inject?: ExtractDurableFactsInject,
): Promise<ExtractedFact[]> {
  const brain = inject?.callBrainRaw ?? callBrainRaw;
  const ledger = inject?.ledger ?? ledgerBrainCall;
  // Absent OR empty candidates → exactly today's add-only behavior (rollback
  // path): base prompt, raw-message bundle, old output shape.
  const withCandidates = candidates !== undefined && candidates.length > 0;

  try {
    const raw = await brain({
      systemPrompt: withCandidates ? EXTRACT_CLASSIFY_SYSTEM_PROMPT : EXTRACT_SYSTEM_PROMPT,
      contextBundle: withCandidates ? assembleContextBundle(message, candidates) : message,
      model: EXTRACT_MODEL,
      timeoutMs: EXTRACT_TIMEOUT_MS,
    });

    // Ledger the real spend the moment the call returns — BEFORE parse — so a
    // malformed or empty result still records the tokens it cost (the whole
    // point of the dedicated `chat_capture` kind). Only reached when a call
    // actually completed; a throw skips this (no spend to record).
    await ledger(deps.homeBase, {
      kind: "chat_capture",
      session_id: deps.sessionId,
      model: EXTRACT_MODEL,
      usage: raw.usage,
    });

    // LLM output is untrusted — validate the shape, drop on malformed.
    const parsed = factsSchema.safeParse(raw.output);
    if (!parsed.success) return [];

    return parsed.data.facts
      .map((f): ExtractedFact => {
        const base: ExtractedFact = { text: f.text.trim(), entities: f.entities ?? [] };
        // Rollback path: keep exactly the old shape (drop any gratuitous
        // classification fields the model emitted unasked).
        if (!withCandidates) return base;
        return {
          ...base,
          classification: normalizeClassification(f.classification),
          target_fact_id: normalizeTargetId(f.target_fact_id),
          confidence: normalizeConfidence(f.confidence),
        };
      })
      .filter((f) => f.text.length > 0);
  } catch {
    return [];
  }
}
