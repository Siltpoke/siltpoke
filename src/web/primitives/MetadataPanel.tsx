// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Copyright (c) 2026 Jiaqi Duan
/** @jsxImportSource hono/jsx */
/**
 * MetadataPanel — k/v table of span attributes.
 *
 * Excludes siltpoke.input / siltpoke.output (shown in I/O tab).
 * Highlights gen_ai.* and siltpoke.* prefixed keys with small badges.
 */
import { tokens } from "../tokens/tokens";

export interface MetadataPanelProps {
  attributes: Record<string, string | number | boolean>;
  statusCode?: string;
  statusMessage?: string;
  spanName?: string;
  startNano?: number;
  endNano?: number;
}

const EXCLUDED_KEYS = new Set(["siltpoke.input", "siltpoke.output"]);

type PrefixBadge = "gen_ai" | "siltpoke" | "other";

function detectPrefix(key: string): PrefixBadge {
  if (key.startsWith("gen_ai.")) return "gen_ai";
  if (key.startsWith("siltpoke.")) return "siltpoke";
  return "other";
}

const BADGE_COLOR: Record<PrefixBadge, string> = {
  gen_ai: tokens.color.sky,
  siltpoke: tokens.color.moss,
  other: tokens.color.ink3,
};

const BADGE_LABEL: Record<PrefixBadge, string> = {
  gen_ai: "gen_ai",
  siltpoke: "siltpoke",
  other: "",
};

function PrefixBadge({ prefix }: { prefix: PrefixBadge }) {
  if (prefix === "other") return null;
  return (
    <span
      style={{
        fontFamily: tokens.font.mono,
        fontSize: 8,
        color: BADGE_COLOR[prefix],
        border: `1px solid ${BADGE_COLOR[prefix]}`,
        borderRadius: tokens.radius.sm,
        padding: "1px 3px",
        marginLeft: 4,
        verticalAlign: "middle",
        opacity: 0.8,
      }}
    >
      {BADGE_LABEL[prefix]}
    </span>
  );
}

const cellStyle = {
  padding: "4px 8px",
  fontFamily: "\"JetBrains Mono\", ui-monospace, monospace",
  fontSize: 11,
  color: tokens.color.ink2,
  borderBottom: `1px solid ${tokens.color.edge}`,
  verticalAlign: "top" as const,
};

export function MetadataPanel({
  attributes,
  statusCode,
  statusMessage,
  spanName,
  startNano,
  endNano,
}: MetadataPanelProps) {
  const filtered = Object.entries(attributes).filter(
    ([k]) => !EXCLUDED_KEYS.has(k)
  );

  const durationMs =
    startNano && endNano && endNano > 0
      ? `${((endNano - startNano) / 1_000_000).toFixed(1)}ms`
      : "—";

  return (
    <div>
      <table
        style={{ width: "100%", borderCollapse: "collapse", marginBottom: 12 }}
      >
        <colgroup>
          <col style={{ width: "35%" }} />
          <col style={{ width: "65%" }} />
        </colgroup>
        <tbody>
          {/* Structural fields first */}
          {spanName && (
            <tr style={{ background: tokens.color.paper }}>
              <td style={{ ...cellStyle, color: tokens.color.ink3 }}>span.name</td>
              <td style={cellStyle}>{spanName}</td>
            </tr>
          )}
          {statusCode && (
            <tr style={{ background: tokens.color.cream }}>
              <td style={{ ...cellStyle, color: tokens.color.ink3 }}>span.status</td>
              <td
                style={{
                  ...cellStyle,
                  color:
                    statusCode === "ERROR"
                      ? tokens.color.terra
                      : statusCode === "OK"
                      ? tokens.color.moss
                      : tokens.color.ink3,
                }}
              >
                {statusCode}
                {statusMessage ? ` — ${statusMessage}` : ""}
              </td>
            </tr>
          )}
          {(startNano ?? 0) > 0 && (
            <tr style={{ background: tokens.color.paper }}>
              <td style={{ ...cellStyle, color: tokens.color.ink3 }}>span.duration</td>
              <td style={{ ...cellStyle, color: tokens.color.ink3 }}>{durationMs}</td>
            </tr>
          )}

          {/* Span attributes */}
          {filtered.map(([k, v], i) => {
            const prefix = detectPrefix(k);
            const bg = i % 2 === 0 ? tokens.color.cream : tokens.color.paper;
            return (
              <tr key={k} style={{ background: bg }}>
                <td style={{ ...cellStyle, color: tokens.color.ink3 }}>
                  {k}
                  <PrefixBadge prefix={prefix} />
                </td>
                <td
                  style={{
                    ...cellStyle,
                    wordBreak: "break-all",
                    maxWidth: 400,
                  }}
                >
                  {String(v)}
                </td>
              </tr>
            );
          })}

          {filtered.length === 0 && !spanName && !statusCode && (
            <tr>
              <td colSpan={2} style={{ ...cellStyle, color: tokens.color.ink3 }}>
                No attributes on this span.
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );
}
