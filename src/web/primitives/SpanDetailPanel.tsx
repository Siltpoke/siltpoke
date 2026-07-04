// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
// Copyright (c) 2026 Jiaqi Duan
/** @jsxImportSource hono/jsx */
/**
 * SpanDetailPanel — 4-tab detail panel for a single span.
 *
 * Tabs: Messages | I/O | Tools | Metadata | Raw
 *
 * Per-span "Analysis" (Haiku narrative) tab removed.
 *
 * Tab switching via ?tab= query param — no JS, pure SSR re-render.
 * Active tab determined by `activeTab` prop (default "io").
 *
 * - Messages tab: only shown for kind=llm. Parses siltpoke.input as messages array.
 * - I/O tab: JSON pretty-print of siltpoke.input and siltpoke.output.
 * - Tools tab: shown when active span has child tool spans. ToolCallTable.
 * - Metadata tab: k/v of all attributes except input/output.
 * - Raw tab: full span JSON dump (collapsed by default).
 */
import { tokens } from "../tokens/tokens";
import type { SpanNode } from "./SpanTree";
import { MessagesView } from "./MessagesView";
import { JsonView } from "./JsonView";
import { ToolCallTable } from "./ToolCallTable";
import { MetadataPanel } from "./MetadataPanel";

export type TabId = "messages" | "io" | "tools" | "metadata" | "raw";

export interface SpanDetailPanelProps {
  span: SpanNode;
  /** All spans in trace — used to find tool children */
  allSpans: SpanNode[];
  activeTab: TabId;
  activeSpanId: string;
}

const EMPTY_INPUT_MSG =
  "no data captured — span pre-dates tracer.setInput/setOutput wire (Step C)";

function TabLink({
  tab,
  label,
  activeTab,
  activeSpanId,
  available,
}: {
  tab: TabId;
  label: string;
  activeTab: TabId;
  activeSpanId: string;
  available?: boolean;
}) {
  const isActive = activeTab === tab;
  const isDisabled = available === false;

  if (isDisabled) {
    return (
      <span
        style={{
          padding: "6px 12px",
          fontFamily: tokens.font.mono,
          fontSize: 11,
          color: tokens.color.ink3,
          opacity: 0.4,
          cursor: "not-allowed",
          borderBottom: "2px solid transparent",
          display: "inline-block",
        }}
      >
        {label}
      </span>
    );
  }

  return (
    <a
      href={`?span=${activeSpanId}&tab=${tab}`}
      style={{
        padding: "6px 12px",
        fontFamily: tokens.font.mono,
        fontSize: 11,
        color: isActive ? tokens.color.ink : tokens.color.ink3,
        textDecoration: "none",
        borderBottom: isActive
          ? `2px solid ${tokens.color.sky}`
          : "2px solid transparent",
        display: "inline-block",
        background: isActive ? tokens.color.cream : "transparent",
      }}
    >
      {label}
    </a>
  );
}

function _fmtCost(usd: number): string {
  if (usd === 0) return "";
  if (usd < 0.001) return ` · $${(usd * 1000).toFixed(3)}m`;
  return ` · $${usd.toFixed(4)}`;
}

function fmtTokens(n: number): string {
  if (n <= 0) return "";
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
  return String(n);
}

function SpanHeader({ span }: { span: SpanNode }) {
  const attrs = span.attributes;
  const kind = String(attrs["siltpoke.kind"] ?? "span");
  const isOk = span.status.code !== "ERROR";
  const inputTok = Number(attrs["gen_ai.usage.input_tokens"] ?? 0);
  const outputTok = Number(attrs["gen_ai.usage.output_tokens"] ?? 0);
  const cachedTok = Number(attrs["gen_ai.usage.cache_read_input_tokens"] ?? 0);
  const model = String(attrs["gen_ai.request.model"] ?? "");
  const durationMs =
    span.end_unix_nano > 0
      ? `${((span.end_unix_nano - span.start_unix_nano) / 1_000_000).toFixed(0)}ms`
      : "—";

  return (
    <div
      style={{
        padding: "10px 14px",
        borderBottom: `1px solid ${tokens.color.edge}`,
        background: tokens.color.paper,
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 8,
          flexWrap: "wrap",
        }}
      >
        <span
          style={{
            fontFamily: tokens.font.mono,
            fontSize: 13,
            color: tokens.color.ink,
            fontWeight: "bold",
          }}
        >
          {span.name}
        </span>
        <span
          style={{
            fontFamily: tokens.font.mono,
            fontSize: 10,
            color: tokens.color.ink3,
            background: tokens.color.paperD,
            padding: "1px 5px",
            borderRadius: tokens.radius.sm,
          }}
        >
          {kind}
        </span>
        <span
          style={{
            fontFamily: tokens.font.mono,
            fontSize: 11,
            color: isOk ? tokens.color.moss : tokens.color.terra,
          }}
        >
          {isOk ? "✓" : "✗ ERROR"}
        </span>
        <span
          style={{
            fontFamily: tokens.font.mono,
            fontSize: 10,
            color: tokens.color.ink3,
          }}
        >
          {durationMs}
        </span>
        {model && (
          <span
            style={{
              fontFamily: tokens.font.mono,
              fontSize: 10,
              color: tokens.color.sky,
            }}
          >
            {model.replace(/^claude-/, "").replace(/-(\d+)-(\d+)$/, "-$1.$2").replace(/-20\d{6}$/, "")}
          </span>
        )}
        {inputTok > 0 && (
          <span
            style={{
              fontFamily: tokens.font.mono,
              fontSize: 10,
              color: tokens.color.ink3,
            }}
          >
            {fmtTokens(inputTok)} in · {fmtTokens(outputTok)} out
            {cachedTok > 0 ? ` · ${fmtTokens(cachedTok)} cached` : ""}
          </span>
        )}
        {!isOk && span.status.message && (
          <span
            style={{
              fontFamily: tokens.font.mono,
              fontSize: 10,
              color: tokens.color.terra,
              wordBreak: "break-all",
            }}
          >
            {span.status.message}
          </span>
        )}
      </div>
      <div
        style={{
          fontFamily: tokens.font.mono,
          fontSize: 9,
          color: tokens.color.ink3,
          marginTop: 4,
        }}
      >
        {span.span_id}
      </div>
    </div>
  );
}

export function SpanDetailPanel({
  span,
  allSpans,
  activeTab,
  activeSpanId,
}: SpanDetailPanelProps) {
  const attrs = span.attributes;
  const kind = String(attrs["siltpoke.kind"] ?? "unknown");
  const isLlm = kind === "llm";

  const inputJson = String(attrs["siltpoke.input"] ?? "");
  const outputJson = String(attrs["siltpoke.output"] ?? "");
  const hasInput = inputJson !== "" && inputJson !== "null";
  const hasOutput = outputJson !== "" && outputJson !== "null";
  // Spillover markers — Tracer sets these when the full payload exceeded
  // the in-memory cap and was written to a spillover JSON file.
  const inputSpilled = attrs["siltpoke.input.spilled"] === true;
  const outputSpilled = attrs["siltpoke.output.spilled"] === true;
  const inputFullBytes = Number(attrs["siltpoke.input.full_bytes"] ?? 0);
  const outputFullBytes = Number(attrs["siltpoke.output.full_bytes"] ?? 0);
  const spilloverHref = (role: "input" | "output"): string =>
    `/api/traces/${span.trace_id}/spans/${span.span_id}/spillover/${role}`;

  // Find tool children
  const toolChildren = allSpans.filter(
    (s) =>
      s.parent_span_id === span.span_id &&
      String(s.attributes["siltpoke.kind"]) === "tool"
  );
  const hasTools = toolChildren.length > 0;

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%" }}>
      <SpanHeader span={span} />

      {/* Tab bar */}
      <div
        style={{
          display: "flex",
          borderBottom: `1px solid ${tokens.color.edge}`,
          background: tokens.color.paper,
          flexWrap: "wrap",
        }}
      >
        <TabLink
          tab="messages"
          label="Messages"
          activeTab={activeTab}
          activeSpanId={activeSpanId}
          available={isLlm}
        />
        <TabLink
          tab="io"
          label="I/O"
          activeTab={activeTab}
          activeSpanId={activeSpanId}
        />
        <TabLink
          tab="tools"
          label="Tools"
          activeTab={activeTab}
          activeSpanId={activeSpanId}
          available={hasTools}
        />
        <TabLink
          tab="metadata"
          label="Metadata"
          activeTab={activeTab}
          activeSpanId={activeSpanId}
        />
        <TabLink
          tab="raw"
          label="Raw"
          activeTab={activeTab}
          activeSpanId={activeSpanId}
        />
      </div>

      {/* Spillover banner — shown on tabs that DON'T already carry an
          inline 'open full' link. I/O tab renders its own per-section
          links beside the Input/Output headers, so we hide the banner
          there to avoid duplication. */}
      {(inputSpilled || outputSpilled) && activeTab !== "io" && (
        <div
          style={{
            display: "flex",
            flexWrap: "wrap",
            gap: 12,
            padding: "6px 16px",
            background: tokens.color.paper,
            borderBottom: `1px solid ${tokens.color.edge}`,
            fontFamily: tokens.font.mono,
            fontSize: 10,
            color: tokens.color.ink3,
          }}
        >
          <span>spillover:</span>
          {inputSpilled && (
            <a
              href={spilloverHref("input")}
              target="_blank"
              rel="noreferrer"
              style={{ color: tokens.color.sky, textDecoration: "none" }}
              title={`full input ${inputFullBytes.toLocaleString()} bytes`}
            >
              open full input ({inputFullBytes.toLocaleString()} bytes) ↗
            </a>
          )}
          {outputSpilled && (
            <a
              href={spilloverHref("output")}
              target="_blank"
              rel="noreferrer"
              style={{ color: tokens.color.sky, textDecoration: "none" }}
              title={`full output ${outputFullBytes.toLocaleString()} bytes`}
            >
              open full output ({outputFullBytes.toLocaleString()} bytes) ↗
            </a>
          )}
        </div>
      )}

      {/* Tab content */}
      <div
        style={{
          flex: 1,
          padding: "14px 16px",
          overflowY: "auto",
          background: tokens.color.cream,
        }}
      >
        {activeTab === "messages" && (
          isLlm ? (
            hasInput ? (
              <MessagesView inputJson={inputJson} outputJson={outputJson} />
            ) : (
              <EmptyState message={EMPTY_INPUT_MSG} />
            )
          ) : (
            <EmptyState message="Messages tab is only available for LLM spans." />
          )
        )}

        {activeTab === "io" && (
          <div>
            <div
              style={{
                display: "flex",
                alignItems: "baseline",
                gap: 10,
                marginBottom: 6,
              }}
            >
              <span
                style={{
                  fontFamily: tokens.font.mono,
                  fontSize: 10,
                  color: tokens.color.ink3,
                  textTransform: "uppercase",
                  letterSpacing: "0.06em",
                }}
              >
                Input
              </span>
              {inputSpilled && (
                <a
                  href={spilloverHref("input")}
                  target="_blank"
                  rel="noreferrer"
                  style={{
                    fontFamily: tokens.font.mono,
                    fontSize: 10,
                    color: tokens.color.sky,
                    textDecoration: "none",
                  }}
                  title={`truncated above; full payload ${inputFullBytes.toLocaleString()} bytes`}
                >
                  open full ({inputFullBytes.toLocaleString()} bytes) ↗
                </a>
              )}
            </div>
            {hasInput ? (
              <JsonView value={inputJson} collapsed={false} />
            ) : (
              <EmptyState message={EMPTY_INPUT_MSG} />
            )}

            <div
              style={{
                display: "flex",
                alignItems: "baseline",
                gap: 10,
                marginBottom: 6,
                marginTop: 16,
              }}
            >
              <span
                style={{
                  fontFamily: tokens.font.mono,
                  fontSize: 10,
                  color: tokens.color.ink3,
                  textTransform: "uppercase",
                  letterSpacing: "0.06em",
                }}
              >
                Output
              </span>
              {outputSpilled && (
                <a
                  href={spilloverHref("output")}
                  target="_blank"
                  rel="noreferrer"
                  style={{
                    fontFamily: tokens.font.mono,
                    fontSize: 10,
                    color: tokens.color.sky,
                    textDecoration: "none",
                  }}
                  title={`truncated above; full payload ${outputFullBytes.toLocaleString()} bytes`}
                >
                  open full ({outputFullBytes.toLocaleString()} bytes) ↗
                </a>
              )}
            </div>
            {hasOutput ? (
              <JsonView value={outputJson} collapsed={false} />
            ) : (
              <EmptyState message={EMPTY_INPUT_MSG} />
            )}
          </div>
        )}

        {activeTab === "tools" && (
          hasTools ? (
            <ToolCallTable toolSpans={toolChildren} />
          ) : (
            <EmptyState message="No tool child spans found. Tool spans appear as children of this span when siltpoke.kind=tool." />
          )
        )}

        {activeTab === "metadata" && (
          <MetadataPanel
            attributes={attrs}
            statusCode={span.status.code}
            statusMessage={span.status.message}
            spanName={span.name}
            startNano={span.start_unix_nano}
            endNano={span.end_unix_nano}
          />
        )}

        {activeTab === "raw" && (
          <JsonView value={span} mode="expanded" />
        )}
      </div>
    </div>
  );
}

function EmptyState({ message }: { message: string }) {
  return (
    <div
      style={{
        fontFamily: tokens.font.mono,
        fontSize: 12,
        color: tokens.color.ink3,
        padding: "16px 0",
        fontStyle: "italic",
      }}
    >
      {message}
    </div>
  );
}
