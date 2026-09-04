// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
// Copyright (c) 2026 Jiaqi Duan
/**
 * Natural-language memory-edit intent parser.
 *
 * The /memory composer sends free text (). This module makes a
 * single Brain call (haiku) that extracts an atomic candidate claim and
 * classifies it against the user's current ACTIVE facts:
 *   - "add"       — net-new; no existing fact matches or contradicts.
 *   - "restate"   — an existing fact means the same thing (reconfirm it).
 *   - "contradict"— the candidate contradicts an existing active fact (supersede).
 *
 * Trust boundary: the LLM verdict is UNTRUSTED. The classification,
 * the named target id, and the claim text are all re-validated in code here, and
 * NOTHING is written by this module — it only returns a structured result for
 * the composer to render a proposal the user must confirm. A "restate"/
 * "contradict" naming an unknown or non-active id is downgraded to "add" so we
 * never act on a phantom target.
 *
 * Mirrors callSummarizerBrain's pattern: callBrainRaw + own Zod validation
 * (NOT callBrain's critic-shaped schema).
 */

import { z } from "zod";
import type { Fact } from "./memory";

export type MemoryEditClassification = "add" | "restate" | "contradict";

export interface MemoryEditResult {
  /** The atomic claim extracted from the user's text. */
  candidate_claim: string;
  /** Code-validated classification (may be downgraded from the LLM's verdict). */
  classification: MemoryEditClassification;
  /** Existing fact id for restate/contradict; null for add (or after downgrade). */
  target_fact_id: string | null;
  /** Model-suggested confidence for the claim (0–1). */
  confidence: number;
}

/** Injectable Brain function (default: callBrainRaw) — keeps the call testable. */
export type BrainRawFn = (opts: {
  systemPrompt: string;
  contextBundle: string;
  model?: string;
  timeoutMs?: number;
}) => Promise<{ output: unknown }>;

export interface ParseMemoryEditDeps {
  brainFn?: BrainRawFn;
  timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 60_000;
const MAX_CLAIM_LEN = 280;

const llmResultSchema = z.object({
  candidate_claim: z.string().min(1).max(MAX_CLAIM_LEN),
  classification: z.enum(["add", "restate", "contradict"]),
  target_fact_id: z.string().nullable(),
  confidence: z.number().min(0).max(1),
});

export const NL_EDIT_SYSTEM_PROMPT = `You parse a single user message into ONE atomic durable memory claim and classify it against the user's existing memory facts.

Return ONLY JSON: {"candidate_claim": string, "classification": "add"|"restate"|"contradict", "target_fact_id": string|null, "confidence": number}.

- candidate_claim: the user's intent as one short, atomic, third-person fact about the user (e.g. "User prefers pink"). Max ${MAX_CLAIM_LEN} chars.
- Compare it against the EXISTING FACTS provided (each has an id + text):
  - "restate": an existing fact means the SAME thing → set target_fact_id to that fact's id.
  - "contradict": the claim DIRECTLY contradicts an existing fact (cannot both be true) → set target_fact_id to that fact's id.
  - "add": neither — net-new information → target_fact_id = null.
- GUARD: facts that are merely similar, or that differ only in specifics (especially numeric values, quantities, or added detail), are NOT contradictions and NOT restatements — classify those as "add". Only mark "contradict" when the two cannot both be true.
- confidence: 0–1, how confident you are in the extracted claim.
- target_fact_id MUST be one of the provided fact ids, or null. Never invent an id.`;

function assemblePrompt(text: string, activeFacts: Fact[]): string {
  const factLines =
    activeFacts.length === 0
      ? "(no existing facts)"
      : activeFacts.map((f) => `- ${f.id}: ${f.text}`).join("\n");
  return `EXISTING FACTS:\n${factLines}\n\nUSER MESSAGE:\n${text}`;
}

/**
 * Parse + classify a NL memory-edit message. Throws on a malformed LLM response
 * (callers surface an honest "couldn't parse" message). Never writes.
 */
export async function parseMemoryEdit(
  text: string,
  activeFacts: Fact[],
  deps: ParseMemoryEditDeps = {},
): Promise<MemoryEditResult> {
  const brainFn =
    deps.brainFn ??
    (async (opts) => (await import("../brain/brain")).callBrainRaw(opts));
  const timeoutMs = deps.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  const raw = await brainFn({
    systemPrompt: NL_EDIT_SYSTEM_PROMPT,
    contextBundle: assemblePrompt(text, activeFacts),
    timeoutMs,
  });

  const parsed = llmResultSchema.safeParse(raw.output);
  if (!parsed.success) {
    throw new Error(`nl-edit parse failed schema validation: ${parsed.error}`);
  }

  let { classification, target_fact_id } = parsed.data;

  // Re-derive the routing decision in code — the LLM verdict is untrusted.
  // A restate/contradict must name a real, currently-active fact; otherwise
  // downgrade to a plain add so we never act on a phantom or stale target.
  if (classification === "add") {
    target_fact_id = null;
  } else {
    const target = activeFacts.find((f) => f.id === target_fact_id);
    if (!target || target.status !== "active") {
      classification = "add";
      target_fact_id = null;
    }
  }

  return {
    candidate_claim: parsed.data.candidate_claim,
    classification,
    target_fact_id,
    confidence: parsed.data.confidence,
  };
}
