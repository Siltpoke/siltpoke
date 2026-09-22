// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
// Copyright (c) 2026 Jiaqi Duan
/**
 * The `claude -p --output-format json` stdout envelope: its shapes, and the
 * three helpers that read one.
 *
 * Split out of `brain.ts` so the two consumers that are not the critic —
 * `explain/providers.ts` and `reflection.ts` — can read an envelope without
 * importing the whole Brain module (and so `brain.ts` stays under the 400-LOC
 * cap). Nothing here knows about prompts, spawning, budgets or schemas.
 *
 * `EnvelopeShapeError` rather than `BrainError`: this module must not depend
 * on `brain.ts`, which depends on it. `brain.ts` re-wraps into `BrainError` at
 * its own boundary so its callers see the class they always saw.
 */

/** A malformed or unreadable stdout envelope. */
export class EnvelopeShapeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EnvelopeShapeError";
  }
}

export interface ResultEvent {
  type: "result";
  subtype?: string;
  is_error?: boolean;
  result?: string;
  error?: string;
  total_cost_usd?: number;
  usage?: {
    cache_creation_input_tokens?: number;
    cache_read_input_tokens?: number;
    input_tokens?: number;
    output_tokens?: number;
  };
}

export interface ClaudeStreamEvent {
  type: string;
  [key: string]: unknown;
}

export interface BrainUsage {
  cache_creation_input_tokens: number;
  cache_read_input_tokens: number;
  input_tokens: number;
  output_tokens: number;
  total_cost_usd: number | null;
}

/**
 * Accept BOTH stdout envelopes `claude -p --output-format json` can produce.
 *
 * With verbose on it is the full event array; with verbose off it is a single
 * `type:"result"` object carrying the same `result` / `usage` /
 * `total_cost_usd` fields. Defect [12] shipped because only the array was
 * handled, so a clean new-user config killed every review with the unhelpful
 * `was not a JSON array`. Every call site also passes `--verbose` now — this
 * is the second, independent defense, so a host that strips the flag degrades
 * to working rather than to silence.
 *
 * Anything else throws naming the shape that actually arrived, because the old
 * message named a type and not a cause (same family as defect [4]).
 */
export function normalizeStreamEnvelope(parsed: unknown): ClaudeStreamEvent[] {
  if (Array.isArray(parsed)) return parsed as ClaudeStreamEvent[];
  if (parsed !== null && typeof parsed === "object") {
    const obj = parsed as ClaudeStreamEvent;
    if (obj.type === "result") return [obj];
    const keys = Object.keys(obj).slice(0, 8).join(", ");
    throw new EnvelopeShapeError(
      `claude -p stdout was a single JSON object with no result event (type=${JSON.stringify(obj.type ?? null)}, keys: ${keys || "none"})`,
    );
  }
  throw new EnvelopeShapeError(
    `claude -p stdout was ${parsed === null ? "null" : typeof parsed}, not a result event or event array`,
  );
}

export function findResultEvent(events: ClaudeStreamEvent[]): ResultEvent {
  for (let i = events.length - 1; i >= 0; i--) {
    const ev = events[i]!;
    if (ev.type === "result") return ev as unknown as ResultEvent;
  }
  throw new EnvelopeShapeError("claude -p stream contained no result event");
}

export function extractUsage(resultEvent: ResultEvent): BrainUsage {
  const u = resultEvent.usage ?? {};
  return {
    cache_creation_input_tokens: u.cache_creation_input_tokens ?? 0,
    cache_read_input_tokens: u.cache_read_input_tokens ?? 0,
    input_tokens: u.input_tokens ?? 0,
    output_tokens: u.output_tokens ?? 0,
    total_cost_usd: resultEvent.total_cost_usd ?? null,
  };
}
