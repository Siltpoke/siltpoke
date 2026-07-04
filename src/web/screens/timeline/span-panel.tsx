// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
// Copyright (c) 2026 Jiaqi Duan
/** @jsxImportSource hono/jsx */
/**
 * Inline span detail panel — the body of each span row's <details> in the
 * /timeline Trace tab (clicking a span inspects IN the page instead of
 * navigating to /traces/:id).
 *
 * HARD CONSTRAINT: the trace fragment is injected via Alpine x-html, so
 * Alpine directives inside it never initialize. Everything here is native
 * HTML — the Messages | Metadata | Raw tabs are CSS-only radio inputs
 * (`.tl-rtab-*:checked ~ .tl-pane-*` rules live in TimelineScreen's
 * TIMELINE_CSS). No Alpine, no <script>.
 *
 * Rendered honestly from what the span actually carries:
 *   - Messages tab only when siltpoke.input / siltpoke.output exist;
 *   - Metadata rows (design's KV list) only for data-bearing fields;
 *   - Raw is always available (the span record as JSON).
 * Cost is computed from gen_ai.* attrs with the same computeCost the
 * brain-cost table uses. A small "open span explorer →" link keeps the
 * deep-dive path (the row itself no longer navigates).
 */

import { computeCost } from "../../../observability/cost-calc";
import { KIND_COLOR, type SpanKind } from "../../primitives/SpanTree";
import { tokens } from "../../tokens/tokens";
import { fmtDurationMs, fmtTraceCost, numAttr, strAttr } from "./format";
import type { TraceFragmentSpan } from "./trace-fragment-types";

interface MetaRow {
  k: string;
  v: string;
  color?: string;
}

/**
 * Design's Metadata KV list — build only the rows whose data exists on
 * this span (span_id / parent / kind / status / latency / siltpoke.repo /
 * siltpoke.cwd / llm.model / tokens.* / cost.usd), omit the rest.
 */
function buildMetaRows(
  span: TraceFragmentSpan,
  kind: SpanKind,
  ms: number,
  cost: number | null,
): MetaRow[] {
  const attrs = span.attributes;
  const statusCode = span.status?.code;
  const inTok = numAttr(attrs, "gen_ai.usage.input_tokens");
  const outTok = numAttr(attrs, "gen_ai.usage.output_tokens");
  const cached = numAttr(attrs, "gen_ai.usage.cache_read_input_tokens");
  const model = strAttr(attrs, "gen_ai.request.model");
  const repo = strAttr(attrs, "siltpoke.repo");
  const cwd = strAttr(attrs, "siltpoke.cwd");

  const rows: MetaRow[] = [
    { k: "span_id", v: span.span_id },
    { k: "parent_span_id", v: span.parent_span_id ?? "(root)", color: tokens.color.ink3 },
  ];
  if (kind !== "unknown") rows.push({ k: "span.kind", v: kind, color: KIND_COLOR[kind] });
  if (statusCode) {
    rows.push({
      k: "status",
      v: statusCode,
      color: statusCode === "ERROR" ? tokens.color.terra : tokens.color.moss,
    });
  }
  rows.push({ k: "latency", v: fmtDurationMs(ms), color: tokens.color.ink });
  if (repo) rows.push({ k: "siltpoke.repo", v: repo, color: tokens.color.sky });
  if (cwd) rows.push({ k: "siltpoke.cwd", v: cwd });
  if (model) {
    rows.push({ k: "llm.model", v: model, color: tokens.color.sky });
    rows.push({ k: "tokens.input", v: String(inTok), color: tokens.color.ink });
    rows.push({ k: "tokens.output", v: String(outTok), color: tokens.color.ink });
    if (cached > 0) {
      // Denominator = whole prompt (input_tokens excludes cache reads).
      const pct = ` (${Math.round((cached / (inTok + cached)) * 100)}%)`;
      rows.push({ k: "tokens.cached", v: `${cached}${pct}`, color: tokens.color.moss });
    }
    if (cost !== null) rows.push({ k: "cost.usd", v: fmtTraceCost(cost), color: tokens.color.ink });
  }
  return rows;
}

const PRE_STYLE = {
  margin: 0,
  fontFamily: tokens.font.mono,
  fontSize: 10.5,
  lineHeight: 1.55,
  color: tokens.color.ink2,
  background: tokens.color.paper,
  border: `1px solid ${tokens.color.edge}`,
  borderRadius: tokens.radius.md,
  padding: "10px 12px",
  whiteSpace: "pre-wrap" as const,
  overflowX: "auto" as const,
};

function IoBlock({ label, text }: { label: string; text: string }) {
  // Same display cap as MessagesView's MessageCard — io payloads can run to
  // hundreds of KB and Raw already carries the full record.
  const truncated = text.length > 2000 ? `${text.slice(0, 2000)}… [truncated]` : text;
  return (
    <div style={{ marginBottom: 10 }}>
      <div
        style={{
          fontFamily: tokens.font.mono,
          fontSize: 9,
          textTransform: "uppercase",
          letterSpacing: "0.06em",
          color: tokens.color.ink3,
          marginBottom: 5,
        }}
      >
        {label}
      </div>
      <pre style={PRE_STYLE}>{truncated}</pre>
    </div>
  );
}

function MetaGrid({ rows }: { rows: MetaRow[] }) {
  return (
    <div class="tl-span-meta">
      {rows.map((r) => (
        <div
          key={r.k}
          style={{
            display: "grid",
            gridTemplateColumns: "150px 1fr",
            gap: 10,
            padding: "5px 0",
            borderBottom: `1px solid ${tokens.color.paperD}`,
          }}
        >
          <span style={{ fontFamily: tokens.font.mono, fontSize: 10.5, color: tokens.color.ink3 }}>
            {r.k}
          </span>
          <span
            style={{
              fontFamily: tokens.font.mono,
              fontSize: 10.5,
              color: r.color ?? tokens.color.ink2,
              whiteSpace: "nowrap",
              overflow: "hidden",
              textOverflow: "ellipsis",
            }}
          >
            {r.v}
          </span>
        </div>
      ))}
    </div>
  );
}

export interface SpanInlinePanelProps {
  span: TraceFragmentSpan;
  traceId: string;
  kind: SpanKind;
  /** Span duration in ms (0 for open-ended spans → "—"). */
  ms: number;
}

export function SpanInlinePanel({ span, traceId, kind, ms }: SpanInlinePanelProps) {
  const attrs = span.attributes;
  const accent = kind === "unknown" ? tokens.color.ink3 : KIND_COLOR[kind];
  const model = strAttr(attrs, "gen_ai.request.model");
  const inTok = numAttr(attrs, "gen_ai.usage.input_tokens");
  const outTok = numAttr(attrs, "gen_ai.usage.output_tokens");
  const cached = numAttr(attrs, "gen_ai.usage.cache_read_input_tokens");
  const cost =
    model && inTok + outTok > 0
      ? computeCost({
          input_tokens: inTok,
          output_tokens: outTok,
          cached_input_tokens: cached,
          model,
        }).cost_usd
      : null;
  const input = strAttr(attrs, "siltpoke.input");
  const output = strAttr(attrs, "siltpoke.output");
  const hasIo = input !== "" || output !== "";

  const meta = buildMetaRows(span, kind, ms, cost);
  const raw = JSON.stringify(
    {
      trace_id: span.trace_id,
      span_id: span.span_id,
      parent_span_id: span.parent_span_id,
      name: span.name,
      start_unix_nano: span.start_unix_nano,
      end_unix_nano: span.end_unix_nano,
      status: span.status,
      attributes: span.attributes,
    },
    null,
    2,
  );

  // Radio group id — unique per trace+span so panels never fight.
  const base = `tl-rtab-${traceId.slice(0, 8)}-${span.span_id}`;

  return (
    <div
      class="tl-span-panel"
      style={{
        padding: "10px 14px 12px",
        background: tokens.color.cream,
        borderBottom: `1px solid ${tokens.color.edge}`,
        borderLeft: `2px solid ${accent}`,
      }}
    >
      {/* No panel header — the <summary> row right above already shows
          name / kind / TOK / LAT; model / cost / status live in the
          Metadata tab. The panel starts at the tabs. */}
      {/* CSS-only radio tabs (x-html constraint — no Alpine, no script). */}
      <div class="tl-span-tabctl" style={{ position: "relative" }}>
        {hasIo && (
          <input class="tl-rtab tl-rtab-msg" type="radio" name={base} id={`${base}-msg`} checked />
        )}
        <input
          class="tl-rtab tl-rtab-meta"
          type="radio"
          name={base}
          id={`${base}-meta`}
          checked={!hasIo}
        />
        <input class="tl-rtab tl-rtab-raw" type="radio" name={base} id={`${base}-raw`} />
        <div
          class="tl-span-tabs"
          style={{
            display: "flex",
            gap: 4,
            borderBottom: `1px solid ${tokens.color.edge}`,
            marginBottom: 10,
          }}
        >
          {hasIo && (
            <label class="tl-span-tab tl-tab-msg" for={`${base}-msg`}>
              Messages
            </label>
          )}
          <label class="tl-span-tab tl-tab-meta" for={`${base}-meta`}>
            Metadata
          </label>
          <label class="tl-span-tab tl-tab-raw" for={`${base}-raw`}>
            Raw
          </label>
        </div>
        {hasIo && (
          <div class="tl-pane tl-pane-msg">
            {input !== "" && <IoBlock label="input" text={input} />}
            {output !== "" && <IoBlock label="output" text={output} />}
          </div>
        )}
        <div class="tl-pane tl-pane-meta">
          <MetaGrid rows={meta} />
        </div>
        <div class="tl-pane tl-pane-raw">
          <pre style={PRE_STYLE}>{raw}</pre>
        </div>
      </div>

      {/* Deep-dive stays one small link away (the row no longer navigates). */}
      <a
        class="tl-span-explorer-link"
        href={`/traces/${traceId}?span=${span.span_id}`}
        style={{
          display: "inline-block",
          marginTop: 10,
          fontFamily: tokens.font.mono,
          fontSize: 10,
          color: tokens.color.sky,
          textDecoration: "none",
        }}
      >
        open span explorer →
      </a>
    </div>
  );
}
