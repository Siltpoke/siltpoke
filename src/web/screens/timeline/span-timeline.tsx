// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Copyright (c) 2026 Jiaqi Duan
/** @jsxImportSource hono/jsx */
/**
 * SPAN TIMELINE · CLICK TO EXPAND — the merged span table of the /timeline
 * Trace-tab fragment, following the reference design companion. One table
 * replaces the old flat "phase timing waterfall": tree hierarchy from
 * parent_span_id (depth-indented), kind tags from `siltpoke.kind`, inline
 * waterfall bars positioned on the trace window, TOK/LAT columns.
 *
 * Split from trace-tab.tsx (400-LOC ratchet). Same x-html constraint: the
 * fragment is injected via x-html, so NO Alpine here. Each row is a native
 * <details>/<summary> that expands an inline SpanInlinePanel IN the page
 * (Messages | Metadata | Raw via CSS-only radio tabs) — clicking no longer
 * navigates away; the span explorer deep-link lives INSIDE the panel.
 * Hover/marker/tab styles live in TimelineScreen's TIMELINE_CSS
 * (.tl-span-row / .tl-span-details / .tl-rtab-*).
 *
 * Hierarchy build + kind mapping are reused from the explorer's SpanTree
 * primitive (buildSpanTree / spanKindOf / KIND_COLOR); bar math mirrors
 * TraceWaterfall's offset/width percentages.
 */

import { buildSpanTree, KIND_COLOR, spanKindOf } from "../../primitives/SpanTree";
import { tokens } from "../../tokens/tokens";
import { fmtDurationMs, fmtTokens, numAttr } from "./format";
import { SpanInlinePanel } from "./span-panel";
import type { TraceFragmentSpan, TraceFragmentTrace } from "./trace-fragment-types";

export { fmtDurationMs } from "./format";
export type { TraceFragmentSpan, TraceFragmentTrace } from "./trace-fragment-types";

/** Shared 4-column grid: name+tag | timeline bar | TOK | LAT. */
const SPAN_GRID = "minmax(0,1fr) 140px 48px 56px";

interface SpanTimelineRowProps {
  span: TraceFragmentSpan;
  depth: number;
  traceId: string;
  minNano: number;
  totalNano: number;
}

/**
 * One span row: a <details> whose <summary> is the tree-indented short
 * name + kind tag + inline waterfall bar + TOK/LAT, and whose body is the
 * inline SpanInlinePanel — clicking expands in place (the explorer
 * deep-link moved inside the panel).
 */
function SpanTimelineRow({ span, depth, traceId, minNano, totalNano }: SpanTimelineRowProps) {
  const kind = spanKindOf(span.attributes);
  const color = KIND_COLOR[kind];
  const isErr = span.status?.code === "ERROR";
  const barColor = isErr ? tokens.color.terra : color;
  const isLlm = kind === "llm";

  const durationNano = span.end_unix_nano > 0 ? span.end_unix_nano - span.start_unix_nano : 0;
  const ms = durationNano / 1_000_000;
  const offsetPct = ((span.start_unix_nano - minNano) / totalNano) * 100;
  const widthPct = Math.max(1.4, (durationNano / totalNano) * 100);

  const tok =
    numAttr(span.attributes, "gen_ai.usage.input_tokens") +
    numAttr(span.attributes, "gen_ai.usage.output_tokens");

  return (
    <details class="tl-span-details">
      <summary
        class="tl-span-row"
        style={{
          display: "grid",
          gridTemplateColumns: SPAN_GRID,
          gap: 9,
          alignItems: "center",
          padding: "6px 12px",
          borderBottom: `1px solid ${tokens.color.edge}`,
          cursor: "pointer",
        }}
      >
      <span style={{ display: "flex", alignItems: "center", gap: 7, paddingLeft: depth * 15, minWidth: 0 }}>
        <span
          style={{ width: 7, height: 7, borderRadius: 2, background: barColor, flexShrink: 0 }}
        />
        <span
          title={span.name}
          style={{
            fontFamily: tokens.font.mono,
            fontSize: 11,
            // LLM spans read visually distinct (ink + weight), like the
            // old primitives' color-coding singled them out.
            color: isLlm ? tokens.color.ink : tokens.color.ink2,
            fontWeight: isLlm ? 600 : 400,
            whiteSpace: "nowrap",
            overflow: "hidden",
            textOverflow: "ellipsis",
          }}
        >
          {span.name.replace(/^siltpoke\./, "")}
        </span>
        {kind !== "unknown" && (
          <span
            data-kind={kind}
            style={{
              fontFamily: tokens.font.mono,
              fontSize: 8,
              letterSpacing: "0.03em",
              textTransform: "uppercase",
              color,
              border: `1px solid ${color}`,
              borderRadius: 4,
              padding: "1px 4px",
              flexShrink: 0,
            }}
          >
            {kind}
          </span>
        )}
      </span>
      <span style={{ position: "relative", height: 7, background: tokens.color.paperD, borderRadius: 3 }}>
        <span
          style={{
            position: "absolute",
            left: `${offsetPct}%`,
            width: `${Math.min(widthPct, 100 - offsetPct)}%`,
            top: 0,
            bottom: 0,
            background: barColor,
            borderRadius: 3,
            minWidth: 2,
          }}
        />
      </span>
        <span style={{ fontFamily: tokens.font.mono, fontSize: 10, textAlign: "right", color: tokens.color.ink3 }}>
          {tok > 0 ? fmtTokens(tok) : "·"}
        </span>
        <span style={{ fontFamily: tokens.font.mono, fontSize: 10, textAlign: "right", color: tokens.color.ink2 }}>
          {fmtDurationMs(ms)}
        </span>
      </summary>
      <SpanInlinePanel span={span} traceId={traceId} kind={kind} ms={ms} />
    </details>
  );
}

/** The full section: header (kicker + duration·count) + the merged table. */
export function SpanTimelineTable({ trace }: { trace: TraceFragmentTrace }) {
  const spans = trace.spans;
  if (spans.length === 0) return null;

  const minNano = Math.min(...spans.map((s) => s.start_unix_nano));
  const maxNano = Math.max(
    ...spans.map((s) => (s.end_unix_nano > 0 ? s.end_unix_nano : s.start_unix_nano)),
  );
  const totalNano = maxNano - minNano || 1;
  const totalLabel = fmtDurationMs(totalNano / 1_000_000);

  // Depth-first flatten over the same hierarchy build SpanTree uses.
  // Orphans (parent id missing from the set) render as roots, not dropped.
  const ids = new Set(spans.map((s) => s.span_id));
  const childrenOf = buildSpanTree(spans);
  const roots = spans
    .filter((s) => s.parent_span_id === null || !ids.has(s.parent_span_id))
    .sort((a, b) => a.start_unix_nano - b.start_unix_nano);
  const rows: Array<{ span: TraceFragmentSpan; depth: number }> = [];
  const visit = (span: TraceFragmentSpan, depth: number) => {
    rows.push({ span, depth });
    for (const child of childrenOf.get(span.span_id) ?? []) visit(child, depth + 1);
  };
  for (const root of roots) visit(root, 0);

  const kicker = {
    fontFamily: tokens.font.mono,
    fontSize: 10,
    color: tokens.color.ink3,
    textTransform: "uppercase" as const,
    letterSpacing: "0.06em",
  };

  return (
    <div>
      <div
        style={{
          display: "flex",
          alignItems: "baseline",
          justifyContent: "space-between",
          gap: 10,
          marginBottom: 6,
        }}
      >
        <div style={kicker}>Span timeline · click to expand</div>
        <div style={{ fontFamily: tokens.font.mono, fontSize: 10, color: tokens.color.ink3 }}>
          {totalLabel} · {spans.length} {spans.length === 1 ? "span" : "spans"}
        </div>
      </div>
      <div
        class="tl-span-timeline"
        style={{
          border: `1px solid ${tokens.color.edge}`,
          borderRadius: tokens.radius.md,
          overflow: "hidden",
          background: tokens.color.cream,
        }}
      >
        <div
          style={{
            display: "grid",
            gridTemplateColumns: SPAN_GRID,
            gap: 9,
            padding: "6px 12px",
            background: tokens.color.paper,
            borderBottom: `1px solid ${tokens.color.edge}`,
            fontFamily: tokens.font.mono,
            fontSize: 8.5,
            letterSpacing: "0.05em",
            textTransform: "uppercase",
            color: tokens.color.ink3,
          }}
        >
          <span>span</span>
          <span>timeline · {totalLabel}</span>
          <span style={{ textAlign: "right" }}>tok</span>
          <span style={{ textAlign: "right" }}>lat</span>
        </div>
        {rows.map(({ span, depth }) => (
          <SpanTimelineRow
            key={span.span_id}
            span={span}
            depth={depth}
            traceId={trace.trace_id}
            minNano={minNano}
            totalNano={totalNano}
          />
        ))}
      </div>
    </div>
  );
}
