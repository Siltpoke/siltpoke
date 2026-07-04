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
import { join } from "node:path";
import { homedir } from "node:os";
import { existsSync } from "node:fs";
import { readFileSync } from "node:fs";
import { Database } from "bun:sqlite";
import { computeCost } from "../../observability/cost-calc";
import type { Span } from "../../observability/types";

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

export interface BrainSpanCost {
  span_name: string;
  model: string;
  input_tokens: number;
  output_tokens: number;
  cached_tokens: number;
  cost_usd: number;
  cache_savings_usd: number;
  duration_ms: number;
}

function openIndexDb(homeBase: string): Database | null {
  const dbPath = join(homeBase, "traces", "index.sqlite");
  if (!existsSync(dbPath)) return null;
  return new Database(dbPath, { readonly: true });
}

function loadSpansFromJsonl(homeBase: string, day: string, traceId: string): Span[] {
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

function isBrainSpan(name: string): boolean {
  return name.startsWith("siltpoke.brain.");
}

function numAttr(attrs: Record<string, string | number | boolean>, key: string): number {
  const v = attrs[key];
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string") {
    const n = Number(v);
    if (Number.isFinite(n)) return n;
  }
  return 0;
}

function strAttr(attrs: Record<string, string | number | boolean>, key: string): string {
  const v = attrs[key];
  return typeof v === "string" ? v : "";
}

function computeTraceCostSummary(row: TraceRow, spans: Span[]): TraceCostSummary {
  const brainSpans = spans.filter((s) => isBrainSpan(s.name));

  let totalInput = 0;
  let totalOutput = 0;
  let totalCached = 0;
  let totalCostUsd = 0;
  let totalSavingsUsd = 0;
  let model = "";

  for (const s of brainSpans) {
    const spanModel = strAttr(s.attributes, "gen_ai.request.model");
    if (!model && spanModel) model = spanModel;

    const input = numAttr(s.attributes, "gen_ai.usage.input_tokens");
    const output = numAttr(s.attributes, "gen_ai.usage.output_tokens");
    const cached = numAttr(s.attributes, "gen_ai.usage.cache_read_input_tokens");
    const m = spanModel || model || "claude-haiku-4-5";

    const { cost_usd, cache_savings_usd } = computeCost({
      input_tokens: input,
      output_tokens: output,
      cached_input_tokens: cached,
      model: m,
    });

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

function computeBrainSpanCosts(spans: Span[]): BrainSpanCost[] {
  return spans
    .filter((s) => isBrainSpan(s.name))
    .map((s) => {
      const model = strAttr(s.attributes, "gen_ai.request.model") || "claude-haiku-4-5";
      const input = numAttr(s.attributes, "gen_ai.usage.input_tokens");
      const output = numAttr(s.attributes, "gen_ai.usage.output_tokens");
      const cached = numAttr(s.attributes, "gen_ai.usage.cache_read_input_tokens");
      const duration_ms =
        s.end_unix_nano > 0 ? (s.end_unix_nano - s.start_unix_nano) / 1_000_000 : 0;

      const { cost_usd, cache_savings_usd } = computeCost({
        input_tokens: input,
        output_tokens: output,
        cached_input_tokens: cached,
        model,
      });

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

export function mountTracesRoutes(app: Hono, deps: TracesRouteDeps = {}): void {
  const homeBase =
    deps.homeBase ?? process.env.SILTPOKE_HOME ?? join(homedir(), ".siltpoke");

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
        const spans = loadSpansFromJsonl(homeBase, row.day, row.trace_id);
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
      const fullSpans = day ? loadSpansFromJsonl(homeBase, day, trace_id) : [];
      const brainCosts = computeBrainSpanCosts(fullSpans);

      // Aggregate totals across all brain spans
      const totalInput = brainCosts.reduce((s, b) => s + b.input_tokens, 0);
      const totalOutput = brainCosts.reduce((s, b) => s + b.output_tokens, 0);
      const totalCached = brainCosts.reduce((s, b) => s + b.cached_tokens, 0);
      const totalCost = brainCosts.reduce((s, b) => s + b.cost_usd, 0);
      const totalSavings = brainCosts.reduce((s, b) => s + b.cache_savings_usd, 0);
      const wouldHaveCost = totalCost + totalSavings;

      return c.json({
        success: true,
        data: rows,
        brain_costs: brainCosts,
        totals: {
          total_input_tokens: totalInput,
          total_output_tokens: totalOutput,
          total_cached_tokens: totalCached,
          cost_usd: totalCost,
          cache_savings_usd: totalSavings,
          would_have_cost_usd: wouldHaveCost,
        },
      });
    } finally {
      db.close();
    }
  });
}
