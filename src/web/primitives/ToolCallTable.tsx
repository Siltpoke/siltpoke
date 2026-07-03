// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Copyright (c) 2026 Jiaqi Duan
/** @jsxImportSource hono/jsx */
/**
 * ToolCallTable — renders child tool spans as a table.
 *
 * Shows: name | status | duration | args preview | result preview.
 * Each row is a <details> for expanding full args/result.
 *
 * Only renders tool spans (siltpoke.kind === "tool") from the children list.
 */
import { tokens } from "../tokens/tokens";
import type { SpanNode } from "./SpanTree";

export interface ToolCallTableProps {
  toolSpans: SpanNode[];
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

function preview(s: string, maxLen = 120): string {
  if (!s || s === "null") return "—";
  const clean = s.replace(/\n/g, " ").trim();
  return clean.length > maxLen ? `${clean.slice(0, maxLen)}…` : clean;
}

const cellStyle = {
  padding: "5px 8px",
  fontFamily: "\"JetBrains Mono\", ui-monospace, monospace",
  fontSize: 11,
  color: tokens.color.ink2,
  borderBottom: `1px solid ${tokens.color.edge}`,
  verticalAlign: "top" as const,
};

const headerStyle = {
  ...cellStyle,
  color: tokens.color.ink3,
  fontSize: 10,
  textTransform: "uppercase" as const,
  letterSpacing: "0.06em",
  background: tokens.color.paper,
  verticalAlign: "middle" as const,
};

export function ToolCallTable({ toolSpans }: ToolCallTableProps) {
  if (toolSpans.length === 0) {
    return (
      <div
        style={{
          fontFamily: tokens.font.mono,
          fontSize: 12,
          color: tokens.color.ink3,
          padding: "16px 0",
        }}
      >
        No tool child spans captured. Tool spans appear here when child spans have{" "}
        <code style={{ fontFamily: tokens.font.mono, fontSize: 11 }}>siltpoke.kind = tool</code>.
      </div>
    );
  }

  return (
    <div style={{ overflowX: "auto" }}>
      <table style={{ width: "100%", borderCollapse: "collapse" }}>
        <thead>
          <tr>
            <th style={headerStyle}>Tool</th>
            <th style={headerStyle}>Status</th>
            <th style={{ ...headerStyle, textAlign: "right" }}>Duration</th>
            <th style={headerStyle}>Args</th>
            <th style={headerStyle}>Result</th>
          </tr>
        </thead>
        <tbody>
          {toolSpans.map((span) => {
            const ms = durationMs(span);
            const isOk = span.status.code !== "ERROR";
            const toolName = String(
              span.attributes["siltpoke.tool.name"] ?? span.name
            );
            const argsRaw = String(span.attributes["siltpoke.tool.args"] ?? "");
            const resultRaw = String(span.attributes["siltpoke.tool.result"] ?? "");
            const argsPreview = preview(argsRaw);
            const resultPreview = preview(resultRaw);

            return (
              <tr key={span.span_id} style={{ background: tokens.color.cream }}>
                <td style={cellStyle}>
                  <span style={{ color: tokens.color.moss, fontWeight: "bold" }}>
                    {toolName}
                  </span>
                </td>
                <td style={cellStyle}>
                  <span
                    style={{
                      color: isOk ? tokens.color.moss : tokens.color.terra,
                    }}
                  >
                    {isOk ? "✓ ok" : "✗ error"}
                  </span>
                </td>
                <td style={{ ...cellStyle, textAlign: "right", color: tokens.color.ink3 }}>
                  {fmtMs(ms)}
                </td>
                <td style={cellStyle}>
                  {argsRaw && argsRaw !== "" && argsRaw !== "null" ? (
                    <details>
                      <summary
                        style={{
                          cursor: "pointer",
                          color: tokens.color.sky,
                          fontFamily: tokens.font.mono,
                          fontSize: 10,
                        }}
                      >
                        {argsPreview}
                      </summary>
                      <pre
                        style={{
                          margin: "4px 0 0",
                          fontFamily: tokens.font.mono,
                          fontSize: 10,
                          background: tokens.color.paper,
                          padding: "6px 8px",
                          borderRadius: tokens.radius.sm,
                          whiteSpace: "pre-wrap",
                          wordBreak: "break-word",
                          maxHeight: 200,
                          overflowY: "auto",
                        }}
                      >
                        {argsRaw}
                      </pre>
                    </details>
                  ) : (
                    <span style={{ color: tokens.color.ink3 }}>—</span>
                  )}
                </td>
                <td style={cellStyle}>
                  {resultRaw && resultRaw !== "" && resultRaw !== "null" ? (
                    <details>
                      <summary
                        style={{
                          cursor: "pointer",
                          color: tokens.color.sky,
                          fontFamily: tokens.font.mono,
                          fontSize: 10,
                        }}
                      >
                        {resultPreview}
                      </summary>
                      <pre
                        style={{
                          margin: "4px 0 0",
                          fontFamily: tokens.font.mono,
                          fontSize: 10,
                          background: tokens.color.paper,
                          padding: "6px 8px",
                          borderRadius: tokens.radius.sm,
                          whiteSpace: "pre-wrap",
                          wordBreak: "break-word",
                          maxHeight: 200,
                          overflowY: "auto",
                        }}
                      >
                        {resultRaw}
                      </pre>
                    </details>
                  ) : (
                    <span style={{ color: tokens.color.ink3 }}>—</span>
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
