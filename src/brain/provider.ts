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
import { type BrainCallResult, type BrainUsage, type CallBrainOptions, callBrainText, DEFAULT_MODEL } from "./brain";
import { brainOutputFromText } from "./parse-raw";

export type BillingKind = "usd" | "quota";

export interface BrainProviderMeta {
  name: "claude" | "codex" | "agy" | "qoder" | "codebuddy";
  billing: BillingKind;
  genAiSystem: string; // "anthropic" | "openai" | "google" | "alibaba" | "tencent" — span truth (AC14)
  /**
   * Whether THIS provider's argv actually carries `opts.model` to the CLI.
   * Declared here, beside the argv that does (or does not) push it, because a
   * separate list went stale silently: `familySupportsModelChoice` hardcoded
   * `family === "claude"` while agy/qoder/codebuddy had been pushing `--model`
   * all along, and codex — which never passes `-m` — accepted a model into
   * config that the process never saw (spec 2026-09-12-brain-select-four-gaps
   * §2.6). Required, not optional: a sixth provider must answer it, and the
   * registry test asserts every family in FAMILIES declares a boolean here.
   */
  acceptsModel: boolean;
}

/**
 * Does this family's argv actually carry `opts.model` to the CLI?
 *
 * ONE declaration, read by each provider's `meta.acceptsModel` AND by the select
 * surface (`familySupportsModelChoice`), so the answer cannot be true in one
 * place and false in another — which is exactly what happened: the select
 * surface hardcoded `family === "claude"` while agy and both CC-forks had been
 * pushing `--model` all along, and codex accepted a model into config that its
 * spawn argv never carried (spec 2026-09-12-brain-select-four-gaps §2.6).
 *
 * `satisfies Record<...>` makes a SIXTH provider a compile error here rather
 * than a silent default. It cannot prove the declared answer matches the argv —
 * only that an answer was given; the registry test pairs each provider's meta
 * against this record, and each provider's own argv test pins the rest.
 */
export const FAMILY_ACCEPTS_MODEL = {
  claude: true, // brain.ts argv --model
  agy: true, // providers/agy.ts argv --model
  qoder: true, // ccfork buildArgv --model
  codebuddy: true, // ccfork buildArgv --model
  codex: false, // providers/codex.ts spawn array has no -m at all
} as const satisfies Record<BrainProviderMeta["name"], boolean>;

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
    meta: {
      name: "claude",
      billing: "usd",
      genAiSystem: "anthropic",
      acceptsModel: FAMILY_ACCEPTS_MODEL.claude,
    },
    callRaw,
    call: async (opts: CallBrainOptions): Promise<BrainCallResult & { servedModel?: string }> => {
      const raw = await callRaw(opts);
      return { output: brainOutputFromText(raw.text), usage: raw.usage, servedModel: raw.servedModel };
    },
  };
}
