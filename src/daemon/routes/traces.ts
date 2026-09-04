// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
// Copyright (c) 2026 Jiaqi Duan
/**
 * Trace viewer API routes
 *
 * GET /api/traces?limit=50          — list recent trace summaries with cost/token aggregates
 * GET /api/traces/:trace_id         — full span list for a single trace with per-brain-call costs
 *
 * Cost/token aggregates are computed from gen_ai.* OTEL attributes on
 * siltpoke.brain.* spans (find, verify). For phase wall-time see /history.
 */
import type { Hono } from "hono";
import { siltpokeRoot } from "../../installer/paths";
import { computeCost } from "../../observability/cost-calc";
import type { Span } from "../../observability/types";
import type { BrainSpanCost, TraceTotals } from "../../web/screens/TraceList";
import {
  buildBrainCosts,
  buildTraceTotals,
  loadFullSpans,
  numAttr,
  openIndexDb,
  strAttr,
} from "../../web/routes/trace-cost";

export interface TracesRouteDeps {
  homeBase?: string;
}

interface TraceRow {
  trace_id: string;
  name: string;
  start_unix_nano: number;
  end_unix_nano: number;
  day: string;
  critique_id: string | null;
  span_count: number;
}

interface SpanRow {
  trace_id: string;
  span_id: string;
  parent_span_id: string | null;
  name: string;
  start_unix_nano: number;
  end_unix_nano: number;
  day: string;
  critique_id: string | null;
}

export interface TraceCostSummary {
  trace_id: string;
  name: string;
  start_unix_nano: number;
  end_unix_nano: number;
  day: string;
  critique_id: string | null;
  span_count: number;
  /** Primary model used (from first brain span found). */
  model: string;
  total_input_tokens: number;
  total_output_tokens: number;
  total_cached_tokens: number;
  /** cache_hit_pct = cached / (input + cached) × 100 — input excludes cache reads. 0 when no prompt tokens. */
  cache_hit_pct: number;
  cost_usd: number;
  cache_savings_usd: number;
}

/** Track #7 T3 (AC8/AC14): a span whose `gen_ai.system` is present and
 * non-anthropic (codex/quota-billed) never goes through computeCost — never
 * haiku-fallback-price a quota-billed call. Legacy spans predating the
 * attribute (empty string) default to anthropic, matching pre-track behavior. */
function computeTraceCostSummary(row: TraceRow, spans: Span[]): TraceCostSummary {
  const brainSpans = spans.filter((s) => s.name.startsWith("siltpoke.brain."));

  let totalInput = 0;
  let totalOutput = 0;
  let totalCached = 0;
  let totalCostUsd = 0;
  let totalSavingsUsd = 0;
  let model = "";

  for (const s of brainSpans) {
    const genAiSystem = strAttr(s.attributes, "gen_ai.system") || "anthropic";
    const isAnthropic = genAiSystem === "anthropic";
    const spanModel = strAttr(s.attributes, "gen_ai.request.model");
    if (!model && spanModel) model = spanModel;

    const input = numAttr(s.attributes, "gen_ai.usage.input_tokens");
    const output = numAttr(s.attributes, "gen_ai.usage.output_tokens");
    const cached = numAttr(s.attributes, "gen_ai.usage.cache_read_input_tokens");
    const m = spanModel || (isAnthropic ? model || "claude-haiku-4-5" : "(unknown)");

    const { cost_usd, cache_savings_usd } = isAnthropic
      ? computeCost({
          input_tokens: input,
          output_tokens: output,
          cached_input_tokens: cached,
          model: m,
        })
      : { cost_usd: 0, cache_savings_usd: 0 };

    totalInput += input;
    totalOutput += output;
    totalCached += cached;
    totalCostUsd += cost_usd;
    totalSavingsUsd += cache_savings_usd;
  }

  // input_tokens is EXCLUSIVE of cache reads (claude -p semantics) — the
  // denominator is the whole prompt (same fix as the Timeline banner).
  const promptTotal = totalInput + totalCached;
  const cache_hit_pct = promptTotal > 0 ? (totalCached / promptTotal) * 100 : 0;

  return {
    trace_id: row.trace_id,
    name: row.name,
    start_unix_nano: row.start_unix_nano,
    end_unix_nano: row.end_unix_nano,
    day: row.day,
    critique_id: row.critique_id,
    span_count: row.span_count,
    model: model || "unknown",
    total_input_tokens: totalInput,
    total_output_tokens: totalOutput,
    total_cached_tokens: totalCached,
    cache_hit_pct,
    cost_usd: totalCostUsd,
    cache_savings_usd: totalSavingsUsd,
  };
}

export function mountTracesRoutes(app: Hono, deps: TracesRouteDeps = {}): void {
  const homeBase = deps.homeBase ?? siltpokeRoot();

  /**
   * GET /api/traces?limit=50
   * Returns a list of recent trace summaries with cost/token aggregates.
   * Brain spans are loaded from JSONL to extract gen_ai.* attributes.
   */
  app.get("/api/traces", (c) => {
    const db = openIndexDb(homeBase);
    if (!db) {
      return c.json({ success: true, data: [], meta: { total: 0 } });
    }
    try {
      const limitParam = c.req.query("limit");
      const limit = Math.min(200, Math.max(1, Number(limitParam) || 50));

      const rows = db.query<TraceRow, [number]>(`
        SELECT
          s.trace_id,
          s.name,
          s.start_unix_nano,
          s.end_unix_nano,
          s.day,
          s.critique_id,
          COUNT(*) OVER (PARTITION BY s.trace_id) AS span_count
        FROM spans s
        WHERE s.parent_span_id IS NULL
        ORDER BY s.start_unix_nano DESC
        LIMIT ?
      `).all(limit);

      const data: TraceCostSummary[] = rows.map((row) => {
        const spans = loadFullSpans(homeBase, row.day, row.trace_id);
        return computeTraceCostSummary(row, spans);
      });

      return c.json({
        success: true,
        data,
        meta: { total: data.length, limit },
      });
    } finally {
      db.close();
    }
  });

  /**
   * GET /api/traces/:trace_id
   * Returns all spans plus per-brain-call cost breakdown for a single trace.
   */
  app.get("/api/traces/:trace_id", (c) => {
    const trace_id = c.req.param("trace_id");
    const db = openIndexDb(homeBase);
    if (!db) {
      return c.json({ success: false, error: "trace store not initialised" }, 404);
    }
    try {
      const rows = db.query<SpanRow, [string]>(`
        SELECT trace_id, span_id, parent_span_id, name,
               start_unix_nano, end_unix_nano, day, critique_id
        FROM spans
        WHERE trace_id = ?
        ORDER BY start_unix_nano ASC
      `).all(trace_id);

      if (rows.length === 0) {
        return c.json({ success: false, error: "trace not found" }, 404);
      }

      // Load full spans (with attributes) from JSONL for cost calculation
      const day = rows[0]?.day ?? "";
      const fullSpans = day ? loadFullSpans(homeBase, day, trace_id) : [];
      const brainCosts: BrainSpanCost[] = buildBrainCosts(fullSpans);
      const totals: TraceTotals = buildTraceTotals(brainCosts);

      return c.json({
        success: true,
        data: rows,
        brain_costs: brainCosts,
        totals,
      });
    } finally {
      db.close();
    }
  });
}
