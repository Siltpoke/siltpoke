// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
// Copyright (c) 2026 Jiaqi Duan
import { validateVerbalization } from "../../quiz/index";
import type { StructuralVerdict } from "../../quiz/index";
import type { StreamChatOptions, StreamEvent, StreamUsage } from "./chat-stream";

/**
 * Appended to the system prompt on the single retry attempt after the first
 * Brain pass produced caving/hedging prose. Never surfaced to the client —
 * it only ever shapes the model's own next turn.
 */
export const QUIZ_STRICT_REMINDER =
  "\n\nSTRICT: do not agree, praise, hedge ('both are true'), or add because/so-that. State the given verdict plainly.";

const ZERO_USAGE: StreamUsage = { input_tokens: 0, output_tokens: 0 };

function sumUsage(a: StreamUsage, b: StreamUsage): StreamUsage {
  return { input_tokens: a.input_tokens + b.input_tokens, output_tokens: a.output_tokens + b.output_tokens };
}

/**
 * Drains a stream to completion and returns its accumulated text — preferring
 * the authoritative `message_stop.full_text`, falling back to concatenated
 * `content_block_delta` text when a fake/test stream omits it — alongside
 * the REAL usage the Brain reported on `message_stop` (cost-honesty: a
 * stream that never reaches message_stop — e.g. an error/abort mid-call —
 * reports zero usage rather than fabricating a number, mirroring
 * `reduceStreamEvents`'s own presence-gated usage discipline in chat.ts).
 */
async function drainStream(
  stream: AsyncGenerator<StreamEvent, void, void>,
): Promise<{ text: string; usage: StreamUsage }> {
  let deltaText = "";
  let fullText: string | null = null;
  let usage: StreamUsage = ZERO_USAGE;
  for await (const ev of stream) {
    if (ev.type === "content_block_delta") {
      deltaText += ev.text;
    } else if (ev.type === "message_stop") {
      fullText = ev.full_text;
      usage = ev.usage;
    }
  }
  return { text: fullText ?? deltaText, usage };
}

/**
 * The anti-sycophancy backstop for buffered verdict-verbalization turns.
 * Runs the Brain to completion, validates the prose against the structural
 * verdict, retries ONCE with a strict reminder appended to the system
 * prompt, and — if the retry is still caving/hedging — falls back to the
 * deterministic `quizFallbackVerbalization` text. The client only ever sees
 * the returned `text`; un-validated prose never reaches the wire.
 *
 * `usage` is the SUM of every real Brain call this made (the initial attempt
 * plus the retry, when one happened) — cost-honesty: this turn's spend is
 * real even when the fallback text (not the Brain's own prose) is what
 * ultimately gets shown, so the caller must ledger `usage`, never a
 * synthetic zero.
 */
export async function generateValidatedVerbalization(input: {
  streamFactory: (o: StreamChatOptions) => AsyncGenerator<StreamEvent, void, void>;
  baseOpts: StreamChatOptions;
  verdict: StructuralVerdict;
  fallback: string;
}): Promise<{ text: string; usedFallback: boolean; retried: boolean; usage: StreamUsage }> {
  const { streamFactory, baseOpts, verdict, fallback } = input;

  const first = await drainStream(streamFactory(baseOpts));
  if (validateVerbalization(first.text, verdict).ok) {
    return { text: first.text, usedFallback: false, retried: false, usage: first.usage };
  }

  const second = await drainStream(
    streamFactory({ ...baseOpts, systemPrompt: (baseOpts.systemPrompt ?? "") + QUIZ_STRICT_REMINDER }),
  );
  const usage = sumUsage(first.usage, second.usage);
  if (validateVerbalization(second.text, verdict).ok) {
    return { text: second.text, usedFallback: false, retried: true, usage };
  }

  return { text: fallback, usedFallback: true, retried: true, usage };
}
