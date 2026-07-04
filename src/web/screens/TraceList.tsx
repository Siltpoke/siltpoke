// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
// Copyright (c) 2026 Jiaqi Duan
/** @jsxImportSource hono/jsx */
/**
 * TraceList screen — /traces  (cost + token analytics view)
 * TraceDetail screen — /traces/:trace_id  (split-panel: span tree + 4-tab detail)
 *
 * Redesigned with Phoenix/LangSmith-style split panel.
 * The waterfall (phase timing) is kept as a collapsible fallback below the
 * new split-panel detail view.
 */
import { Dashboard } from "../shells/Dashboard";
import { CANONICAL_NAV } from "../routes/nav";
import { TraceListPanel } from "../primitives/TraceListPanel";
import { TraceWaterfall } from "../primitives/TraceWaterfall";
import { SpanTree } from "../primitives/SpanTree";
import { SpanDetailPanel } from "../primitives/SpanDetailPanel";
import { tokens } from "../tokens/tokens";
import type { TraceSummary } from "../primitives/TraceListPanel";
import type { WaterfallSpan } from "../primitives/TraceWaterfall";
import type { SpanNode } from "../primitives/SpanTree";
import type { TabId } from "../primitives/SpanDetailPanel";

export interface TraceListProps {
  traces: TraceSummary[];
  filterStatus?: string;
  filterModel?: string;
  filterDate?: string;
  availableModels?: string[];
}

export function TraceList({
  traces,
  filterStatus,
  filterModel,
  filterDate,
  availableModels,
}: TraceListProps) {
  return (
    <Dashboard navSections={CANONICAL_NAV} activeSection="traces">
      <div style={{ padding: 16 }}>
        <div style={{ marginBottom: 16 }}>
          <span
            style={{
              fontFamily: tokens.font.mono,
              fontSize: 10,
              color: tokens.color.ink3,
              letterSpacing: "0.08em",
              textTransform: "uppercase",
              display: "block",
              marginBottom: 4,
            }}
          >
            OTEL TRACES · cost + token analytics
          </span>
          <h1
            style={{
              margin: "0 0 4px",
              fontFamily: tokens.font.display,
              fontSize: 28,
              fontWeight: 400,
              color: tokens.color.ink,
              lineHeight: 1,
            }}
          >
            Cost &amp; Token Analytics
          </h1>
          <div
            style={{
              fontFamily: tokens.font.body,
              fontSize: 13,
              color: tokens.color.ink3,
            }}
          >
            Per-turn breakdown of token usage, cache hits, and per-model cost.
            For per-phase wall time, see /history.
          </div>
        </div>
        <TraceListPanel
          traces={traces}
          filterStatus={filterStatus}
          filterModel={filterModel}
          filterDate={filterDate}
          availableModels={availableModels}
        />
      </div>
    </Dashboard>
  );
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

export interface TraceTotals {
  total_input_tokens: number;
  total_output_tokens: number;
  total_cached_tokens: number;
  cost_usd: number;
  cache_savings_usd: number;
  would_have_cost_usd: number;
}

export interface TraceDetailProps {
  traceId: string;
  spans: WaterfallSpan[];
  /** Full spans with attributes — for split-panel detail */
  fullSpans?: SpanNode[];
  brainCosts?: BrainSpanCost[];
  totals?: TraceTotals;
  /** Active span id from ?span= query param (default = root) */
  activeSpanId?: string;
  /** Active tab from ?tab= query param (default = "io") */
  activeTab?: TabId;
  /** Back-link href — preserves filter state on return. Default "/traces". */
  backHref?: string;
}

function fmtCost(usd: number): string {
  if (usd === 0) return "$0.00";
  if (usd < 0.001) return `$${(usd * 1000).toFixed(3)}m`;
  return `$${usd.toFixed(4)}`;
}

function fmtTokens(n: number): string {
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

function fmtModel(model: string): string {
  return model
    .replace(/^claude-/, "")
    .replace(/-(\d+)-(\d+)$/, "-$1.$2")
    .replace(/-20\d{6}$/, "");
}


export function TraceDetail({
  traceId,
  spans,
  fullSpans = [],
  brainCosts = [],
  totals,
  activeSpanId,
  activeTab = "io",
  backHref = "/traces",
}: TraceDetailProps) {
  const root = spans.find((s) => s.parent_span_id === null);
  const title = root ? root.name : traceId.slice(0, 12);

  // Determine active span — default to root
  const effectiveActiveSpanId =
    activeSpanId ??
    (root ? root.span_id : fullSpans[0]?.span_id ?? "");

  const activeFullSpan = fullSpans.find((s) => s.span_id === effectiveActiveSpanId);

  const cellStyle = {
    padding: "5px 10px",
    fontFamily: tokens.font.mono,
    fontSize: 11,
    color: tokens.color.ink2,
    borderBottom: `1px solid ${tokens.color.edge}`,
    verticalAlign: "middle" as const,
    whiteSpace: "nowrap" as const,
  };

  const headerStyle = {
    ...cellStyle,
    color: tokens.color.ink3,
    fontSize: 10,
    textTransform: "uppercase" as const,
    letterSpacing: "0.06em",
    background: tokens.color.paper,
  };

  return (
    <Dashboard navSections={CANONICAL_NAV} activeSection="traces">
      <div style={{ padding: 16, maxWidth: "100%" }}>
        {/* Back link */}
        <a
          href={backHref}
          style={{
            fontFamily: tokens.font.mono,
            fontSize: 11,
            color: tokens.color.sky,
            textDecoration: "none",
          }}
        >
          ← traces
        </a>

        {/* Header */}
        <div style={{ marginBottom: 12, marginTop: 8 }}>
          <span
            style={{
              fontFamily: tokens.font.mono,
              fontSize: 10,
              color: tokens.color.ink3,
              letterSpacing: "0.08em",
              textTransform: "uppercase",
              display: "block",
              marginBottom: 4,
            }}
          >
            TRACE · span explorer
          </span>
          <h1
            style={{
              margin: "0 0 4px",
              fontFamily: tokens.font.display,
              fontSize: 24,
              fontWeight: 400,
              color: tokens.color.ink,
              lineHeight: 1,
            }}
          >
            {title}
          </h1>
          <div
            style={{
              fontFamily: tokens.font.mono,
              fontSize: 11,
              color: tokens.color.ink3,
            }}
          >
            {traceId.slice(0, 32)}
          </div>
        </div>

        {/* Cache savings summary */}
        {totals && totals.cost_usd > 0 && (
          <div
            style={{
              fontFamily: tokens.font.mono,
              fontSize: 11,
              color: tokens.color.ink3,
              marginBottom: 12,
              padding: "8px 10px",
              background: tokens.color.paper,
              borderRadius: tokens.radius.md,
              border: `1px solid ${tokens.color.edge}`,
            }}
          >
            Cache savings:{" "}
            <span style={{ color: tokens.color.moss }}>
              {fmtCost(totals.cache_savings_usd)}
            </span>{" "}
            · would have been{" "}
            <span style={{ color: tokens.color.ink2 }}>
              {fmtCost(totals.would_have_cost_usd)}
            </span>{" "}
            without caching · actual cost:{" "}
            <span style={{ color: tokens.color.ink2 }}>
              {fmtCost(totals.cost_usd)}
            </span>
          </div>
        )}

        {/* Split-panel: Span Tree (left) + Detail Panel (right) */}
        {fullSpans.length > 0 && activeFullSpan ? (
          <div
            style={{
              display: "flex",
              border: `1px solid ${tokens.color.edge}`,
              borderRadius: tokens.radius.md,
              overflow: "hidden",
              marginBottom: 24,
              minHeight: 500,
            }}
          >
            {/* Left panel: Span Tree (360px) */}
            <div
              style={{
                width: 360,
                flexShrink: 0,
                borderRight: `1px solid ${tokens.color.edge}`,
                overflowY: "auto",
                background: tokens.color.cream,
              }}
            >
              {/* Trace meta */}
              <div
                style={{
                  padding: "8px 10px",
                  borderBottom: `1px solid ${tokens.color.edge}`,
                  background: tokens.color.paper,
                }}
              >
                <div
                  style={{
                    fontFamily: tokens.font.mono,
                    fontSize: 9,
                    color: tokens.color.ink3,
                    textTransform: "uppercase",
                    letterSpacing: "0.06em",
                    marginBottom: 2,
                  }}
                >
                  Span tree · {fullSpans.length} spans
                </div>
                <div
                  style={{
                    fontFamily: tokens.font.mono,
                    fontSize: 10,
                    color: tokens.color.ink3,
                  }}
                >
                  {traceId.slice(0, 16)}…
                </div>
              </div>
              <SpanTree
                spans={fullSpans}
                activeSpanId={effectiveActiveSpanId}
                activeTab={activeTab}
              />
            </div>

            {/* Right panel: Detail */}
            <div style={{ flex: 1, minWidth: 0, overflowY: "auto" }}>
              <SpanDetailPanel
                span={activeFullSpan}
                allSpans={fullSpans}
                activeTab={activeTab}
                activeSpanId={effectiveActiveSpanId}
              />
            </div>
          </div>
        ) : (
          <div
            style={{
              fontFamily: tokens.font.mono,
              fontSize: 12,
              color: tokens.color.ink3,
              padding: 16,
              marginBottom: 24,
              background: tokens.color.paper,
              borderRadius: tokens.radius.md,
              border: `1px solid ${tokens.color.edge}`,
            }}
          >
            No span data available. Spans with attributes are loaded from JSONL trace files.
          </div>
        )}

        {/* Per-brain-call cost breakdown — always visible (primary info) */}
        {brainCosts.length > 0 && (
          <div style={{ marginBottom: 24 }}>
            <div
              style={{
                fontFamily: tokens.font.mono,
                fontSize: 10,
                color: tokens.color.ink3,
                textTransform: "uppercase",
                letterSpacing: "0.06em",
                marginBottom: 6,
              }}
            >
              Brain call cost breakdown ({brainCosts.length} calls)
            </div>
            <div style={{ overflowX: "auto" }}>
              <table style={{ width: "100%", borderCollapse: "collapse" }}>
                <thead>
                  <tr>
                    <th style={headerStyle}>Span</th>
                    <th style={headerStyle}>Model</th>
                    <th style={{ ...headerStyle, textAlign: "right" }}>Input</th>
                    <th style={{ ...headerStyle, textAlign: "right" }}>Output</th>
                    <th style={{ ...headerStyle, textAlign: "right" }}>Cached</th>
                    <th style={{ ...headerStyle, textAlign: "right" }}>Cost</th>
                    <th style={{ ...headerStyle, textAlign: "right" }}>Savings</th>
                    <th style={{ ...headerStyle, textAlign: "right" }}>Latency</th>
                  </tr>
                </thead>
                <tbody>
                  {brainCosts.map((b, i) => (
                    <tr key={`${b.span_name}-${i}`} style={{ background: tokens.color.cream }}>
                      <td style={cellStyle}>{b.span_name}</td>
                      <td style={{ ...cellStyle, color: tokens.color.ink3 }}>
                        {fmtModel(b.model)}
                      </td>
                      <td style={{ ...cellStyle, textAlign: "right" }}>
                        {fmtTokens(b.input_tokens)}
                      </td>
                      <td style={{ ...cellStyle, textAlign: "right" }}>
                        {fmtTokens(b.output_tokens)}
                      </td>
                      <td
                        style={{
                          ...cellStyle,
                          textAlign: "right",
                          color: b.cached_tokens > 0 ? tokens.color.moss : tokens.color.ink3,
                        }}
                      >
                        {b.cached_tokens > 0 ? fmtTokens(b.cached_tokens) : "—"}
                      </td>
                      <td style={{ ...cellStyle, textAlign: "right" }}>
                        {fmtCost(b.cost_usd)}
                      </td>
                      <td
                        style={{
                          ...cellStyle,
                          textAlign: "right",
                          color: b.cache_savings_usd > 0 ? tokens.color.moss : tokens.color.ink3,
                        }}
                      >
                        {b.cache_savings_usd > 0 ? fmtCost(b.cache_savings_usd) : "—"}
                      </td>
                      <td style={{ ...cellStyle, textAlign: "right", color: tokens.color.ink3 }}>
                        {b.duration_ms > 0 ? `${b.duration_ms.toFixed(0)}ms` : "—"}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}

        {/* Waterfall — default-expanded, user can collapse */}
        <details open style={{ marginBottom: 8 }}>
          <summary
            style={{
              fontFamily: tokens.font.mono,
              fontSize: 9,
              color: tokens.color.ink3,
              textTransform: "uppercase",
              letterSpacing: "0.06em",
              marginBottom: 6,
              opacity: 0.7,
              cursor: "pointer",
            }}
          >
            Phase timing waterfall (SRE view — also in /history)
          </summary>
          <div style={{ opacity: 0.55, marginTop: 8 }}>
            <TraceWaterfall spans={spans} />
          </div>
        </details>
      </div>
    </Dashboard>
  );
}
