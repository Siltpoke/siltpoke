// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
// Copyright (c) 2026 Jiaqi Duan
/**
 * Cross-family Brain provider abstraction (track #7 T1).
 *
 * A ReviewerBrainProvider wraps ONE reviewer backend (claude / codex / ...) behind
 * a single call() shape so brain-guarded.ts and run-critic.ts can swap the
 * call target without touching retry/budget/telemetry logic.
 *
 * The claude provider's call() (single-brain identity #10, S2) now layers on
 * callRaw() + brainOutputFromText() instead of calling callBrain() directly —
 * same runBrainCall → extractJsonString → JSON.parse → parseBrainOutput chain,
 * byte-identical behavior (AC1). brain.ts's public API (callBrain/callBrainRaw/
 * callBrainText) is untouched; unmigrated consumers keep importing it
 * directly — that IS the allowlist mechanism (AC9).
 */
import { callBrainText, DEFAULT_MODEL, type BrainCallResult, type BrainUsage, type CallBrainOptions } from "./brain";
import { brainOutputFromText } from "./parse-raw";

export type BillingKind = "usd" | "quota";

export interface BrainProviderMeta {
  name: "claude" | "codex" | "agy" | "qoder" | "codebuddy";
  billing: BillingKind;
  genAiSystem: string; // "anthropic" | "openai" | "google" | "alibaba" | "tencent" — span truth (AC14)
}

export interface CallRawResult {
  text: string;
  usage: BrainUsage;
  servedModel?: string;
}

// "Reviewer" prefix: src/explain/explain.ts already exports an unrelated
// function-shaped `BrainProvider` — distinct name prevents wrong-import mixups.
export interface ReviewerBrainProvider {
  meta: BrainProviderMeta;
  /**
   * Primitive (single-brain #10 S2): raw model text + usage, NO schema, NO
   * persona injection — systemPrompt is passed verbatim. `extract`/`chat`
   * consumers layer their own zod/sanitize; `call()` layers brainOutputFromText.
   */
  callRaw(opts: CallBrainOptions): Promise<CallRawResult>;
  call(opts: CallBrainOptions): Promise<BrainCallResult & { servedModel?: string }>;
}

/**
 * Byte-identical wrap of callBrain (brain.ts:118-129 argv untouched).
 * servedModel is added on top (never fed back into argv/behavior) so
 * claude ledger rows carry a model string too (T3, AC7) — claude has no
 * model-pinning ambiguity, so "served" is exactly the requested model.
 */
export function makeClaudeProvider(): ReviewerBrainProvider {
  const callRaw = async (opts: CallBrainOptions): Promise<CallRawResult> => {
    const { text, usage } = await callBrainText(opts);
    return { text, usage, servedModel: opts.model ?? DEFAULT_MODEL };
  };
  return {
    meta: { name: "claude", billing: "usd", genAiSystem: "anthropic" },
    callRaw,
    call: async (opts: CallBrainOptions): Promise<BrainCallResult & { servedModel?: string }> => {
      const raw = await callRaw(opts);
      return { output: brainOutputFromText(raw.text), usage: raw.usage, servedModel: raw.servedModel };
    },
  };
}
