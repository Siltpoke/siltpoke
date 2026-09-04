// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
// Copyright (c) 2026 Jiaqi Duan
/**
 * Shared trace-cost builders + span loaders — extracted from
 * src/web/routes/traces.tsx so the /timeline
 * Trace-tab fragment endpoint can reuse the exact math /traces/:trace_id
 * uses. Behavior is unchanged; traces.tsx now imports from here.
 *
 * NAMING: the trace-side totals builder is exported as `buildTraceTotals`
 * (renamed from the module-private `buildTotals`) to avoid colliding with
 * the state-side `buildTotals` in src/state/critic-event-log.ts if
 * both ever land in one importer.
 */

import { Database } from "bun:sqlite";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { computeCost } from "../../observability/cost-calc";
import type { Span } from "../../observability/types";
import type { BrainSpanCost, TraceTotals } from "../screens/TraceList";

/** Readonly handle on the sqlite span index; null when it doesn't exist. */
export function openIndexDb(homeBase: string): Database | null {
  const dbPath = join(homeBase, "traces", "index.sqlite");
  if (!existsSync(dbPath)) return null;
  return new Database(dbPath, { readonly: true });
}

/** Full spans (with attributes) for one trace from its day-partition JSONL. */
export function loadFullSpans(homeBase: string, day: string, traceId: string): Span[] {
  const file = join(homeBase, "traces", `${day}.jsonl`);
  if (!existsSync(file)) return [];
  try {
    return readFileSync(file, "utf8")
      .trim()
      .split("\n")
      .filter((l) => l.length > 0)
      .map((l) => JSON.parse(l) as Span)
      .filter((s) => s.trace_id === traceId);
  } catch {
    return [];
  }
}

export function numAttr(attrs: Record<string, string | number | boolean>, key: string): number {
  const v = attrs[key];
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string") {
    const n = Number(v);
    if (Number.isFinite(n)) return n;
  }
  return 0;
}

export function strAttr(attrs: Record<string, string | number | boolean>, key: string): string {
  const v = attrs[key];
  return typeof v === "string" ? v : "";
}

/** Per-brain-span cost rows from gen_ai.* OTEL attributes.
 * Track #7 T3 (AC8/AC14): a span whose `gen_ai.system` is present and
 * non-anthropic (codex/quota-billed) NEVER goes through computeCost — that
 * table is a claude USD price list, and pricing a quota call would fabricate
 * a dollar figure. Legacy spans predating this attribute (empty string)
 * default to anthropic, matching pre-track behavior byte-for-byte. */
export function buildBrainCosts(spans: Span[]): BrainSpanCost[] {
  return spans
    .filter((s) => s.name.startsWith("siltpoke.brain."))
    .map((s) => {
      const genAiSystem = strAttr(s.attributes, "gen_ai.system") || "anthropic";
      const isAnthropic = genAiSystem === "anthropic";
      const model =
        strAttr(s.attributes, "gen_ai.request.model") ||
        (isAnthropic ? "claude-haiku-4-5" : "(unknown)");
      const input = numAttr(s.attributes, "gen_ai.usage.input_tokens");
      const output = numAttr(s.attributes, "gen_ai.usage.output_tokens");
      const cached = numAttr(s.attributes, "gen_ai.usage.cache_read_input_tokens");
      const duration_ms =
        s.end_unix_nano > 0 ? (s.end_unix_nano - s.start_unix_nano) / 1_000_000 : 0;
      const { cost_usd, cache_savings_usd } = isAnthropic
        ? computeCost({
            input_tokens: input,
            output_tokens: output,
            cached_input_tokens: cached,
            model,
          })
        : { cost_usd: 0, cache_savings_usd: 0 };
      return {
        span_name: s.name,
        model,
        input_tokens: input,
        output_tokens: output,
        cached_tokens: cached,
        cost_usd,
        cache_savings_usd,
        duration_ms,
      };
    });
}

/** Trace-level sums over brain-span cost rows (incl. cache-savings math). */
export function buildTraceTotals(brainCosts: BrainSpanCost[]): TraceTotals {
  const totalInput = brainCosts.reduce((s, b) => s + b.input_tokens, 0);
  const totalOutput = brainCosts.reduce((s, b) => s + b.output_tokens, 0);
  const totalCached = brainCosts.reduce((s, b) => s + b.cached_tokens, 0);
  const totalCost = brainCosts.reduce((s, b) => s + b.cost_usd, 0);
  const totalSavings = brainCosts.reduce((s, b) => s + b.cache_savings_usd, 0);
  return {
    total_input_tokens: totalInput,
    total_output_tokens: totalOutput,
    total_cached_tokens: totalCached,
    cost_usd: totalCost,
    cache_savings_usd: totalSavings,
    would_have_cost_usd: totalCost + totalSavings,
  };
}
