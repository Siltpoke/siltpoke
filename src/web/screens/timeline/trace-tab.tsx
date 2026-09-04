// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
// Copyright (c) 2026 Jiaqi Duan
/** @jsxImportSource hono/jsx */
/**
 * Trace tab SSR fragment — the HTML body the /timeline Trace tab fetches
 * on demand from GET /api/critique/:critique_id/trace.
 *
 * Same fragment pattern as GET /api/critique/:id/diff: the route renders
 * these components to a string and the client injects it via x-html —
 * no trace data is ever embedded in the /timeline page itself.
 *
 * Design parity (2026-07-02 companion + 2nd-smoke fixup): cache banner
 * (always shown when the trace has brain calls — zeros stay honest) +
 * per-brain-span cost breakdown + a merged SPAN TIMELINE table (tree
 * indentation + kind tags + waterfall bars + TOK/LAT; each row is a native
 * <details> that expands an inline span panel IN the page — the
 * /traces/:id?span=… deep-link lives inside the panel). The SpanTree /
 * SpanDetailPanel split view stays on the full trace page.
 *
 * Injected via x-html — NO Alpine allowed in here, native HTML only.
 */

import { tokens } from "../../tokens/tokens";
import type { BrainSpanCost, TraceTotals } from "../TraceList";
import { fmtTokens, fmtTraceCost } from "./format";
import { SpanTimelineTable, type TraceFragmentTrace } from "./span-timeline";

export type { TraceFragmentSpan, TraceFragmentTrace } from "./span-timeline";

/**
 * Honest empty/degraded states. Rendered server-side
 * into the fragment so the client shell stays a dumb x-html sink.
 */
export const TRACE_NOTE_COPY = {
  "no-index":
    "no trace index — the sqlite span index (~/.siltpoke/traces/index.sqlite) does not exist yet. Spans are recorded when the review runs with tracing enabled.",
  "index-error":
    "trace index unreadable — the sqlite span index exists but could not be queried. The review itself is unaffected; see the Code Review tab.",
  "no-trace":
    "no trace recorded for this turn — the trace index has no spans linked to this critique_id.",
  // REMOVED: "no-critique-id". It claimed the turn "pre-dates per-row review
  // ids" — a guess, and on a real store the wrong one for 94.5% of turns, which
  // have a specific recorded reason instead. It was also unreachable from here:
  // this fragment is only rendered by GET /api/critique/:critique_id/trace, so
  // a missing id never reaches it. The reachable branch lives in
  // `detail-tabs.tsx`'s TraceTab and now renders `audit_absence`.
  //
  // Checked before deleting (deletion is the one edit reading cannot undo):
  // no literal `kind="no-critique-id"` anywhere; the only dynamic index is
  // `TRACE_NOTE_COPY[kind]` in TraceTabNote below, whose four call sites in
  // `routes/timeline.tsx` all pass literals (index-error / no-index / no-trace);
  // `tests/web/routes/timeline-tabs.test.ts` touches only `["no-trace"]`.
} as const;

export type TraceNoteKind = keyof typeof TRACE_NOTE_COPY;

export function TraceTabNote({ kind }: { kind: TraceNoteKind }) {
  return (
    <div
      data-trace-note={kind}
      style={{
        fontFamily: tokens.font.body,
        fontSize: 12,
        fontStyle: "italic",
        color: tokens.color.ink3,
        lineHeight: 1.6,
        padding: "14px 4px",
      }}
    >
      {TRACE_NOTE_COPY[kind]}
    </div>
  );
}

function fmtModel(model: string): string {
  return model
    .replace(/^claude-/, "")
    .replace(/-(\d+)-(\d+)$/, "-$1.$2")
    .replace(/-20\d{6}$/, "");
}

/**
 * Cache banner (design parity): `CACHE saved $X · would have cost $Y ·
 * actual $Z` + right-aligned hit rate. Rendered whenever the trace has
 * brain calls — zeros are shown honestly (live brain spans record no
 * gen_ai usage today, and hiding the banner read as a bug in smoke).
 */
function CacheBanner({ totals, brainCallCount }: {
  totals: TraceTotals;
  brainCallCount: number;
}) {
  if (brainCallCount === 0) return null;
  // input_tokens is EXCLUSIVE of cache reads (claude -p semantics) — the
  // hit-rate denominator is the whole prompt: uncached input + cache reads.
  const promptTotal = totals.total_input_tokens + totals.total_cached_tokens;
  const pct = promptTotal > 0 ? Math.round((totals.total_cached_tokens / promptTotal) * 100) : null;
  const dim = { color: tokens.color.ink3 };
  return (
    <div
      class="tl-trace-cache-banner"
      data-cache-banner="true"
      style={{
        display: "flex",
        alignItems: "center",
        gap: 14,
        flexWrap: "wrap",
        fontFamily: tokens.font.mono,
        fontSize: 11,
        padding: "8px 10px",
        background: tokens.color.paper,
        borderRadius: tokens.radius.md,
        border: `1px solid ${tokens.color.edge}`,
      }}
    >
      <span
        style={{
          color: tokens.color.ink3,
          fontSize: 9,
          letterSpacing: "0.07em",
          textTransform: "uppercase",
        }}
      >
        cache
      </span>
      <span style={dim}>
        saved <span style={{ color: tokens.color.moss }}>{fmtTraceCost(totals.cache_savings_usd)}</span>
      </span>
      <span style={dim}>
        would have cost{" "}
        <span style={{ color: tokens.color.ink2 }}>{fmtTraceCost(totals.would_have_cost_usd)}</span>
      </span>
      <span style={dim}>
        actual <span style={{ color: tokens.color.ink }}>{fmtTraceCost(totals.cost_usd)}</span>
      </span>
      <span data-cache-hit="true" style={{ marginLeft: "auto", color: tokens.color.ink3 }}>
        {pct !== null ? `${pct}% · ${fmtTokens(totals.total_cached_tokens)} cached` : "—"}
      </span>
    </div>
  );
}

const CELL = {
  padding: "5px 10px",
  fontFamily: tokens.font.mono,
  fontSize: 11,
  color: tokens.color.ink2,
  borderBottom: `1px solid ${tokens.color.edge}`,
  verticalAlign: "middle" as const,
  whiteSpace: "nowrap" as const,
};

const HEADER = {
  ...CELL,
  color: tokens.color.ink3,
  fontSize: 10,
  textTransform: "uppercase" as const,
  letterSpacing: "0.06em",
  background: tokens.color.paper,
};

/** Per-brain-span cost breakdown — same columns as /traces/:trace_id. */
function BrainCostTable({ brainCosts }: { brainCosts: BrainSpanCost[] }) {
  if (brainCosts.length === 0) return null;
  return (
    <div>
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
        Brain call cost breakdown ({brainCosts.length} {brainCosts.length === 1 ? "call" : "calls"})
      </div>
      <div style={{ overflowX: "auto" }}>
        <table class="tl-trace-costs" style={{ width: "100%", borderCollapse: "collapse" }}>
          <thead>
            <tr>
              <th style={HEADER}>Span</th>
              <th style={HEADER}>Model</th>
              <th style={{ ...HEADER, textAlign: "right" }}>Input</th>
              <th style={{ ...HEADER, textAlign: "right" }}>Output</th>
              <th style={{ ...HEADER, textAlign: "right" }}>Cached</th>
              <th style={{ ...HEADER, textAlign: "right" }}>Cost</th>
              <th style={{ ...HEADER, textAlign: "right" }}>Savings</th>
              <th style={{ ...HEADER, textAlign: "right" }}>Latency</th>
            </tr>
          </thead>
          <tbody>
            {brainCosts.map((b, i) => (
              <tr key={`${b.span_name}-${i}`} style={{ background: tokens.color.cream }}>
                <td style={CELL}>{b.span_name}</td>
                <td style={{ ...CELL, color: tokens.color.ink3 }}>{fmtModel(b.model)}</td>
                <td style={{ ...CELL, textAlign: "right" }}>{fmtTokens(b.input_tokens)}</td>
                <td style={{ ...CELL, textAlign: "right" }}>{fmtTokens(b.output_tokens)}</td>
                <td
                  style={{
                    ...CELL,
                    textAlign: "right",
                    color: b.cached_tokens > 0 ? tokens.color.moss : tokens.color.ink3,
                  }}
                >
                  {b.cached_tokens > 0 ? fmtTokens(b.cached_tokens) : "—"}
                </td>
                <td style={{ ...CELL, textAlign: "right" }}>{fmtTraceCost(b.cost_usd)}</td>
                <td
                  style={{
                    ...CELL,
                    textAlign: "right",
                    color: b.cache_savings_usd > 0 ? tokens.color.moss : tokens.color.ink3,
                  }}
                >
                  {b.cache_savings_usd > 0 ? fmtTraceCost(b.cache_savings_usd) : "—"}
                </td>
                <td style={{ ...CELL, textAlign: "right", color: tokens.color.ink3 }}>
                  {b.duration_ms > 0 ? `${b.duration_ms.toFixed(0)}ms` : "—"}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function SingleTrace({ trace, index, total }: {
  trace: TraceFragmentTrace;
  index: number;
  total: number;
}) {
  const root = trace.spans.find((s) => s.parent_span_id === null);
  return (
    <div
      class="tl-trace"
      data-trace-id={trace.trace_id}
      style={{ display: "flex", flexDirection: "column", gap: 14 }}
    >
      <div style={{ display: "flex", alignItems: "baseline", gap: 10, flexWrap: "wrap" }}>
        <span
          style={{
            fontFamily: tokens.font.mono,
            fontSize: 10,
            letterSpacing: "0.08em",
            textTransform: "uppercase",
            color: tokens.color.ink3,
          }}
        >
          {total > 1 ? `trace ${index + 1} of ${total} · ` : "trace · "}
          {root?.name ?? trace.trace_id.slice(0, 12)}
        </span>
        <a
          href={`/traces/${trace.trace_id}`}
          style={{
            fontFamily: tokens.font.mono,
            fontSize: 10,
            color: tokens.color.sky,
            textDecoration: "none",
          }}
        >
          open span explorer →
        </a>
      </div>
      <CacheBanner totals={trace.totals} brainCallCount={trace.brainCosts.length} />
      <BrainCostTable brainCosts={trace.brainCosts} />
      <SpanTimelineTable trace={trace} />
    </div>
  );
}

/**
 * The full fragment body: one SingleTrace per linked trace (a critique can
 * link several — e.g. find + verify passes recorded as separate traces).
 */
export function TraceTabFragment({ traces }: { traces: TraceFragmentTrace[] }) {
  // paddingTop 10 = the same top gap the Diff/Critic panes get from their
  // Section wrapper (Trace content sat flush under the tab bar while the
  // other tabs breathe).
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 26, paddingTop: 10 }}>
      {traces.map((t, i) => (
        <SingleTrace key={t.trace_id} trace={t} index={i} total={traces.length} />
      ))}
    </div>
  );
}
