// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Copyright (c) 2026 Jiaqi Duan
/**
 * Shared span/trace shapes for the /timeline Trace-tab fragment — extracted
 * from span-timeline.tsx so the table (span-timeline.tsx) and the inline
 * panel (span-panel.tsx) can both import them without a module cycle
 * (span-timeline renders SpanInlinePanel; the panel only needs the types).
 */

import type { BrainSpanCost, TraceTotals } from "../TraceList";

/**
 * Span shape the fragment renders. Full JSONL spans carry status +
 * attributes (kind tags, token counts, io payloads); the sqlite-index
 * fallback rows (day partition GC'd) lack them, so both are optional and
 * the row/panel degrade honestly (no tag, "·" TOK, sparse Metadata).
 */
export interface TraceFragmentSpan {
  trace_id: string;
  span_id: string;
  parent_span_id: string | null;
  name: string;
  start_unix_nano: number;
  end_unix_nano: number;
  status?: { code: string };
  attributes?: Record<string, string | number | boolean>;
}

export interface TraceFragmentTrace {
  trace_id: string;
  spans: TraceFragmentSpan[];
  brainCosts: BrainSpanCost[];
  totals: TraceTotals;
}
