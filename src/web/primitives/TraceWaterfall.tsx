// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
// Copyright (c) 2026 Jiaqi Duan
/** @jsxImportSource hono/jsx */
/**
 * TraceWaterfall — renders a list of spans as a horizontal waterfall chart.
 *
 * Each span is drawn as a bar whose left offset and width are proportional to
 * the trace's total duration. Root spans (parent_span_id = null) are shown
 * without indentation; children are indented 16px per level.
 */
import { tokens } from "../tokens/tokens";

export interface WaterfallSpan {
  trace_id: string;
  span_id: string;
  parent_span_id: string | null;
  name: string;
  start_unix_nano: number;
  end_unix_nano: number;
  status?: { code: string };
}

export interface TraceWaterfallProps {
  spans: WaterfallSpan[];
}

/**
 * Waterfall-only bold palette. The global cream-paper tokens are too
 * pastel for differentiating phases at a glance — these hexes push toward
 * fully-saturated primaries while staying within the warm/cool spread of
 * the rest of the page.
 *
 * Task 10b batch 2 — `tokens.kind.*` (see palette.ts's `kindPalette` for
 * the full light+dark design, the 3:1-vs-`edge` contrast gate, and the
 * distinctness fix for the two pairs that independently converged after
 * being lifted for dark mode). `siltpoke.brain.verify` intentionally shares
 * `tokens.kind.summarizerHaiku` with `siltpoke.summarizer.haiku` — a
 * pre-existing one-literal-two-keys design in this record, kept as ONE
 * token referenced twice rather than two tokens that happen to start equal.
 */
const KIND_COLORS: Record<string, string> = {
  "siltpoke.turn":              tokens.kind.turn, // crimson
  "siltpoke.summarizer.haiku":  tokens.kind.summarizerHaiku, // forest green
  "siltpoke.rubric.tier1":      tokens.kind.rubricTier1, // burnt orange
  "siltpoke.rubric.tier2":      tokens.kind.rubricTier2, // dark rust
  "siltpoke.intent.classify":   tokens.kind.intentClassify, // deep teal
  "siltpoke.prompt.build":      tokens.kind.promptBuild, // dark espresso
  "siltpoke.brain.find":        tokens.kind.brainFind, // deep blue
  "siltpoke.brain.verify":      tokens.kind.summarizerHaiku, // shares summarizer.haiku's token — see comment above
  "siltpoke.response.parse":    tokens.kind.responseParse, // vivid magenta
  "siltpoke.critique.persist":  tokens.kind.critiquePersist, // near-black (dark-mode hue-shifted, see palette.ts)
};

// Fallback bar color for an unmapped span name — folded into `tokens.color.ink`
// (near-exact match to the original `#2a241c`) rather than kept as a 10th
// competing hue in `kindPalette`: this is deliberately "not a recognized
// kind," a neutral signal, not another identity color needing distinctness
// from the other 9 (Task 10b batch 2).
const DEFAULT_BAR_COLOR = tokens.color.ink;
/** Darker track background so bars pop visually. Exact match to `tokens.color.edge`. */
const TRACK_BG = tokens.color.edge;

function depthOf(spanId: string, spans: WaterfallSpan[]): number {
  const span = spans.find(s => s.span_id === spanId);
  if (!span || span.parent_span_id === null) return 0;
  return 1 + depthOf(span.parent_span_id, spans);
}

function durationMs(span: WaterfallSpan): number {
  if (span.end_unix_nano <= 0) return 0;
  return (span.end_unix_nano - span.start_unix_nano) / 1_000_000;
}

export function TraceWaterfall({ spans }: TraceWaterfallProps) {
  if (spans.length === 0) {
    return (
      <div style={{ fontFamily: tokens.font.mono, fontSize: 12, color: tokens.color.ink3, padding: 16 }}>
        No spans
      </div>
    );
  }

  const minNano = Math.min(...spans.map(s => s.start_unix_nano));
  const maxNano = Math.max(...spans.map(s => s.end_unix_nano > 0 ? s.end_unix_nano : s.start_unix_nano));
  const totalNano = maxNano - minNano || 1;

  const sorted = [...spans].sort((a, b) => a.start_unix_nano - b.start_unix_nano);

  return (
    <div
      style={{
        background: tokens.color.paper,
        borderRadius: tokens.radius.md,
        padding: 12,
        overflowX: "auto",
      }}
    >
      <div style={{ minWidth: 600 }}>
        {sorted.map(span => {
          const depth = depthOf(span.span_id, spans);
          const offsetPct = ((span.start_unix_nano - minNano) / totalNano) * 100;
          const widthPct = Math.max(0.5, (durationMs(span) / (totalNano / 1_000_000)) * 100);
          const color = KIND_COLORS[span.name] ?? DEFAULT_BAR_COLOR;
          const ms = durationMs(span);

          return (
            <div
              key={span.span_id}
              style={{
                display: "flex",
                alignItems: "center",
                height: 26,
                marginBottom: 2,
                paddingLeft: depth * 16,
              }}
            >
              {/* Label */}
              <div
                style={{
                  width: 220,
                  flexShrink: 0,
                  fontFamily: tokens.font.mono,
                  fontSize: 11,
                  fontWeight: 600,
                  color: tokens.color.ink,
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  whiteSpace: "nowrap",
                  paddingRight: 8,
                }}
                title={span.name}
              >
                {span.name}
              </div>
              {/* Bar track */}
              <div style={{ flex: 1, position: "relative", height: 16, background: TRACK_BG, borderRadius: 3 }}>
                <div
                  style={{
                    position: "absolute",
                    left: `${offsetPct}%`,
                    width: `${Math.min(widthPct, 100 - offsetPct)}%`,
                    height: "100%",
                    background: color,
                    borderRadius: 3,
                  }}
                  title={`${ms.toFixed(1)}ms`}
                />
              </div>
              {/* Duration label */}
              <div
                style={{
                  width: 64,
                  flexShrink: 0,
                  fontFamily: tokens.font.mono,
                  fontSize: 11,
                  fontWeight: 600,
                  color: tokens.color.ink,
                  textAlign: "right",
                  paddingLeft: 6,
                }}
              >
                {ms > 0 ? `${ms.toFixed(0)}ms` : "—"}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
