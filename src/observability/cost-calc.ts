// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
// Copyright (c) 2026 Jiaqi Duan
/**
 * cost-calc — pure cost computation for gen_ai span token usage.
 *
 * Rates are per-million tokens ($ / M tokens).
 * Cache-read tokens are billed at a discounted rate.
 * Cache-create tokens are billed at the regular input rate.
 */

export interface CostInput {
  input_tokens: number;
  output_tokens: number;
  cached_input_tokens: number;
  model: string;
}

export interface CostResult {
  /** Total cost in USD. */
  cost_usd: number;
  /** How much was saved vs. billing cached tokens at full input rate. */
  cache_savings_usd: number;
  breakdown: {
    billed_input: number;
    billed_cached: number;
    billed_output: number;
    input_cost_usd: number;
    cached_cost_usd: number;
    output_cost_usd: number;
  };
}

interface Rate {
  /** $ per million input tokens (non-cached). */
  input: number;
  /** $ per million cache-read tokens. */
  cached: number;
  /** $ per million output tokens. */
  output: number;
}

const RATES: Record<string, Rate> = {
  "claude-haiku-4-5": { input: 1.0, cached: 0.10, output: 5.0 },
  "claude-haiku-4-5-20251001": { input: 1.0, cached: 0.10, output: 5.0 },
  "claude-sonnet-4-6": { input: 3.0, cached: 0.30, output: 15.0 },
  "claude-sonnet-4-6-20251115": { input: 3.0, cached: 0.30, output: 15.0 },
  // Opus 4.5+ pricing (in/out/cache-read $5 / $25 / $0.50 per MTok) per
  // platform.claude.com/docs/en/about-claude/pricing as of 2026-06-14.
  // (The deprecated Opus 4.1 was $15 / $75 / $1.50 — do not reuse here.)
  "claude-opus-4-7": { input: 5.0, cached: 0.50, output: 25.0 },
  "claude-opus-4-7-20251101": { input: 5.0, cached: 0.50, output: 25.0 },
  "claude-opus-4-8": { input: 5.0, cached: 0.50, output: 25.0 },
};

const DEFAULT_RATE: Rate = { input: 1.0, cached: 0.10, output: 5.0 };

function rateFor(model: string): Rate {
  return RATES[model] ?? DEFAULT_RATE;
}

const PER_MILLION = 1_000_000;

export function computeCost({
  input_tokens,
  output_tokens,
  cached_input_tokens,
  model,
}: CostInput): CostResult {
  const rate = rateFor(model);

  // claude -p usage follows the Anthropic API semantics: input_tokens counts
  // ONLY non-cached prompt tokens; cache reads are reported separately.
  // (The old `input - cached` subtraction assumed inclusive input — on a
  // cache-heavy real turn it clamped billed_input to 0.)
  const billed_input = input_tokens;
  const billed_cached = cached_input_tokens;
  const billed_output = output_tokens;

  const input_cost_usd = (billed_input / PER_MILLION) * rate.input;
  const cached_cost_usd = (billed_cached / PER_MILLION) * rate.cached;
  const output_cost_usd = (billed_output / PER_MILLION) * rate.output;

  const cost_usd = input_cost_usd + cached_cost_usd + output_cost_usd;

  // Savings = what cached tokens would have cost at full input rate, minus what we actually paid
  const cache_savings_usd = (billed_cached / PER_MILLION) * (rate.input - rate.cached);

  return {
    cost_usd,
    cache_savings_usd,
    breakdown: {
      billed_input,
      billed_cached,
      billed_output,
      input_cost_usd,
      cached_cost_usd,
      output_cost_usd,
    },
  };
}
