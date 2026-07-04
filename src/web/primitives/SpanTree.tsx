// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
// Copyright (c) 2026 Jiaqi Duan
/** @jsxImportSource hono/jsx */
/**
 * SpanTree — recursive indented span tree for /traces/:id split-panel.
 *
 * Renders each span as a clickable row with:
 *   - color-coded left border by siltpoke.kind
 *   - status badge (✓ / ✗)
 *   - compact metadata (model, tokens for LLM; duration for all)
 *
 * Click = <a href="?span=<id>&tab=<tab>"> — no JS needed; SSR re-render.
 */
import { tokens } from "../tokens/tokens";
import { SPAN_KIND_EXPLAIN } from "./CritiqueAuditBlocks";

export type SpanKind = "llm" | "tool" | "rubric" | "chain" | "parser" | "persist" | "unknown";

export const KIND_COLOR: Record<SpanKind, string> = {
  llm: "#7fb0c8",
  tool: "#7a9a5e",
  rubric: "#c8a87f",
  chain: "#9b89c8",
  parser: "#8a7c64",
  persist: "#5a4f3f",
  unknown: tokens.color.edge,
};

const KIND_LABEL: Record<SpanKind, string> = {
  llm: "llm",
  tool: "tool",
  rubric: "rubric",
  chain: "chain",
  parser: "parser",
  persist: "persist",
  unknown: "span",
};

export interface SpanNode {
  trace_id: string;
  span_id: string;
  parent_span_id: string | null;
  name: string;
  start_unix_nano: number;
  end_unix_nano: number;
  status: { code: "UNSET" | "OK" | "ERROR"; message?: string };
  attributes: Record<string, string | number | boolean>;
}

export interface SpanTreeProps {
  spans: SpanNode[];
  activeSpanId: string;
  activeTab: string;
}

/**
 * Semantic kind from a span's `siltpoke.kind` attribute. Exported so other
 * span renderers (e.g. the /timeline Trace-tab fragment) share the same
 * mapping instead of re-deriving it.
 */
export function spanKindOf(
  attributes: Record<string, string | number | boolean> | undefined,
): SpanKind {
  const k = attributes?.["siltpoke.kind"];
  if (
    k === "llm" ||
    k === "tool" ||
    k === "rubric" ||
    k === "chain" ||
    k === "parser" ||
    k === "persist"
  ) {
    return k;
  }
  return "unknown";
}

function getKind(span: SpanNode): SpanKind {
  return spanKindOf(span.attributes);
}

function durationMs(span: SpanNode): number {
  if (span.end_unix_nano <= 0) return 0;
  return (span.end_unix_nano - span.start_unix_nano) / 1_000_000;
}

function fmtMs(ms: number): string {
  if (ms <= 0) return "—";
  if (ms >= 1000) return `${(ms / 1000).toFixed(1)}s`;
  return `${ms.toFixed(0)}ms`;
}

function fmtTokens(n: number): string {
  if (n <= 0) return "";
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
  return String(n);
}

function fmtModel(model: string): string {
  return model
    .replace(/^claude-/, "")
    .replace(/-(\d+)-(\d+)$/, "-$1.$2")
    .replace(/-20\d{6}$/, "");
}

/**
 * Group spans by parent_span_id (children sorted by start time). Generic +
 * exported so the /timeline Trace-tab fragment reuses the same hierarchy
 * build instead of re-deriving it.
 */
export function buildSpanTree<
  T extends { span_id: string; parent_span_id: string | null; start_unix_nano: number },
>(spans: T[]): Map<string | null, T[]> {
  const tree = new Map<string | null, T[]>();
  for (const span of spans) {
    const key = span.parent_span_id ?? null;
    const existing = tree.get(key) ?? [];
    existing.push(span);
    tree.set(key, existing);
  }
  // sort children by start time
  for (const children of tree.values()) {
    children.sort((a, b) => a.start_unix_nano - b.start_unix_nano);
  }
  return tree;
}

interface SpanRowProps {
  span: SpanNode;
  depth: number;
  tree: Map<string | null, SpanNode[]>;
  activeSpanId: string;
  activeTab: string;
}

function SpanRow({ span, depth, tree, activeSpanId, activeTab }: SpanRowProps) {
  const kind = getKind(span);
  const color = KIND_COLOR[kind];
  const isActive = span.span_id === activeSpanId;
  const isOk = span.status.code !== "ERROR";
  const ms = durationMs(span);

  const model = String(span.attributes["gen_ai.request.model"] ?? "");
  const inputTok = Number(span.attributes["gen_ai.usage.input_tokens"] ?? 0);
  const outputTok = Number(span.attributes["gen_ai.usage.output_tokens"] ?? 0);

  const tokenLabel =
    kind === "llm" && inputTok > 0
      ? ` · ${fmtTokens(inputTok)}/${fmtTokens(outputTok)}`
      : "";
  const modelLabel = kind === "llm" && model ? ` · ${fmtModel(model)}` : "";

  const children = tree.get(span.span_id) ?? [];

  const rowBg = isActive ? tokens.color.paperD : "transparent";
  const nameColor = isActive ? tokens.color.ink : tokens.color.ink2;
  const tabParam = activeTab || "io";

  return (
    <>
      <a
        href={`?span=${span.span_id}&tab=${tabParam}`}
        style={{
          display: "flex",
          alignItems: "center",
          paddingLeft: `${8 + depth * 16}px`,
          paddingRight: 8,
          paddingTop: 5,
          paddingBottom: 5,
          background: rowBg,
          borderLeft: `3px solid ${isActive ? color : "transparent"}`,
          textDecoration: "none",
          cursor: "pointer",
          borderBottom: `1px solid ${tokens.color.edge}`,
        }}
      >
        {/* Kind indicator dot — hover surfaces plain-English what/why so
            non-technical readers can tell at a glance whether the span is
            'an LLM call' / 'a local tool' / 'a rule engine' / etc. */}
        <span
          title={
            SPAN_KIND_EXPLAIN[kind]
              ? `${KIND_LABEL[kind]}: ${SPAN_KIND_EXPLAIN[kind]?.what}\n\n${SPAN_KIND_EXPLAIN[kind]?.why}`
              : KIND_LABEL[kind]
          }
          style={{
            display: "inline-block",
            width: 8,
            height: 8,
            borderRadius: "50%",
            background: color,
            flexShrink: 0,
            marginRight: 6,
            cursor: "help",
          }}
        />

        {/* Span name */}
        <span
          style={{
            flex: 1,
            fontFamily: tokens.font.mono,
            fontSize: 11,
            color: nameColor,
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }}
          title={span.name}
        >
          {span.name}
        </span>

        {/* Inline metadata: model/tokens or nothing */}
        {(modelLabel || tokenLabel) && (
          <span
            style={{
              fontFamily: tokens.font.mono,
              fontSize: 9,
              color: tokens.color.ink3,
              whiteSpace: "nowrap",
              marginLeft: 4,
              flexShrink: 0,
            }}
          >
            {modelLabel}
            {tokenLabel}
          </span>
        )}

        {/* Duration */}
        <span
          style={{
            fontFamily: tokens.font.mono,
            fontSize: 10,
            color: tokens.color.ink3,
            marginLeft: 8,
            flexShrink: 0,
            minWidth: 40,
            textAlign: "right",
          }}
        >
          {fmtMs(ms)}
        </span>

        {/* Status badge */}
        <span
          style={{
            fontFamily: tokens.font.mono,
            fontSize: 10,
            color: isOk ? tokens.color.moss : tokens.color.terra,
            marginLeft: 6,
            flexShrink: 0,
          }}
        >
          {isOk ? "✓" : "✗"}
        </span>

        {/* Kind badge */}
        <span
          style={{
            fontFamily: tokens.font.mono,
            fontSize: 9,
            color,
            marginLeft: 4,
            flexShrink: 0,
            opacity: 0.8,
          }}
        >
          {KIND_LABEL[kind]}
        </span>
      </a>

      {/* Render children recursively */}
      {children.map((child) => (
        <SpanRow
          key={child.span_id}
          span={child}
          depth={depth + 1}
          tree={tree}
          activeSpanId={activeSpanId}
          activeTab={activeTab}
        />
      ))}
    </>
  );
}

export function SpanTree({ spans, activeSpanId, activeTab }: SpanTreeProps) {
  if (spans.length === 0) {
    return (
      <div
        style={{
          fontFamily: tokens.font.mono,
          fontSize: 11,
          color: tokens.color.ink3,
          padding: 16,
        }}
      >
        No spans
      </div>
    );
  }

  const tree = buildSpanTree(spans);
  const roots = tree.get(null) ?? [];

  return (
    <div>
      {roots.map((root) => (
        <SpanRow
          key={root.span_id}
          span={root}
          depth={0}
          tree={tree}
          activeSpanId={activeSpanId}
          activeTab={activeTab}
        />
      ))}
    </div>
  );
}
