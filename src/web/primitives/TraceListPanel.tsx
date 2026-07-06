// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
// Copyright (c) 2026 Jiaqi Duan
/** @jsxImportSource hono/jsx */
/**
 * TraceListPanel — cost + token analytics table for recent traces.
 *
 * Columns: When | Critique | Root | Status | Models | Spans | Tokens | Cached % | Cost
 * Filter dropdowns: Status | Model | Date range (via HTMX hx-get)
 * For per-phase wall time, see /history.
 */
import { tokens } from "../tokens/tokens";

export interface TraceSummary {
  trace_id: string;
  name: string;
  start_unix_nano: number;
  end_unix_nano: number;
  day: string;
  critique_id: string | null;
  span_count: number;
  /** Primary model name, may be "unknown" when no brain spans exist. */
  model: string;
  /** All unique model names used in LLM spans of this trace. */
  models?: string[];
  /** Root span status code (OK | ERROR | UNSET). */
  status?: string;
  total_input_tokens: number;
  total_output_tokens: number;
  total_cached_tokens: number;
  /** 0–100 percentage. */
  cache_hit_pct: number;
  cost_usd: number;
  cache_savings_usd: number;
}

export interface TraceListPanelProps {
  traces: TraceSummary[];
  /** Currently active filters — used to render dropdowns in correct state */
  filterStatus?: string;
  filterModel?: string;
  filterDate?: string;
  /** Distinct models seen across all traces (for model dropdown) */
  availableModels?: string[];
}

function formatTime(nanos: number): string {
  const d = new Date(nanos / 1_000_000);
  return d.toLocaleTimeString("en-US", {
    hour12: false,
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

function fmtTokens(n: number): string {
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

function fmtCost(usd: number): string {
  if (usd === 0) return "$0.00";
  if (usd < 0.001) return `$${(usd * 1000).toFixed(3)}m`; // sub-milli: show in millicents
  return `$${usd.toFixed(4)}`;
}

function fmtModel(model: string): string {
  // shorten "claude-haiku-4-5" → "haiku-4.5", etc.
  return model
    .replace(/^claude-/, "")
    .replace(/-(\d+)-(\d+)$/, "-$1.$2")
    .replace(/-20\d{6}$/, ""); // strip date suffix like -20251001
}

function ModelBadges({ models, primary }: { models?: string[]; primary: string }) {
  const list = models && models.length > 0 ? models : [primary];
  return (
    <>
      {list.map((m) => (
        <span
          key={m}
          style={{
            display: "inline-block",
            fontFamily: tokens.font.mono,
            fontSize: 9,
            color: tokens.color.sky,
            border: `1px solid ${tokens.color.sky}`,
            borderRadius: tokens.radius.pill,
            padding: "1px 5px",
            marginRight: 3,
            whiteSpace: "nowrap",
          }}
        >
          {fmtModel(m)}
        </span>
      ))}
    </>
  );
}

function totalsRow(traces: TraceSummary[]): {
  input: number;
  output: number;
  cost: number;
} {
  return traces.reduce(
    (acc, t) => ({
      input: acc.input + t.total_input_tokens,
      output: acc.output + t.total_output_tokens,
      cost: acc.cost + t.cost_usd,
    }),
    { input: 0, output: 0, cost: 0 },
  );
}

export function TraceListPanel({
  traces,
  filterStatus = "",
  filterModel = "",
  filterDate = "",
  // Continued-filter query: rebuilt from the current filters so each trace
  // row link can carry it forward, and the detail-page back-link can pop
  // back into the SAME filtered list.
  // Computed inside the function below.
  availableModels = [],
}: TraceListPanelProps) {
  // Encode the current filters into a query string so each trace row link
  // can carry it forward via `?from=` and the detail page's back link can
  // restore the SAME filtered view on return.
  const currentFilterQs = (() => {
    const p = new URLSearchParams();
    if (filterStatus) p.set("status", filterStatus);
    if (filterModel) p.set("model", filterModel);
    if (filterDate) p.set("date", filterDate);
    return p.toString();
  })();
  const fromParam = currentFilterQs ? `?from=${encodeURIComponent(currentFilterQs)}` : "";

  const cellStyle = {
    padding: "8px 12px",
    fontFamily: tokens.font.mono,
    fontSize: 11,
    color: tokens.color.ink2,
    borderBottom: `1px solid ${tokens.color.edge}`,
    verticalAlign: "middle" as const,
    whiteSpace: "nowrap" as const,
    textAlign: "left" as const,
  };

  const headerStyle = {
    ...cellStyle,
    color: tokens.color.ink3,
    fontSize: 10,
    fontWeight: "normal" as const,
    textTransform: "uppercase" as const,
    letterSpacing: "0.06em",
    background: tokens.color.paper,
  };

  const selectStyle = {
    fontFamily: tokens.font.mono,
    fontSize: 11,
    color: tokens.color.ink2,
    background: tokens.color.paper,
    border: `1px solid ${tokens.color.edge}`,
    borderRadius: tokens.radius.sm,
    padding: "4px 8px",
  };

  const allModels = Array.from(
    new Set([...availableModels, ...traces.map((t) => t.model).filter((m) => m !== "unknown")])
  ).sort();

  if (traces.length === 0 && !filterStatus && !filterModel && !filterDate) {
    return (
      <div
        style={{
          fontFamily: tokens.font.mono,
          fontSize: 12,
          color: tokens.color.ink3,
          padding: 16,
        }}
      >
        No traces recorded yet.
      </div>
    );
  }

  const totals = totalsRow(traces);

  return (
    <div>
      {/* Filter bar */}
      <form
        method="get"
        action="/traces"
        style={{
          display: "flex",
          gap: 10,
          padding: "8px 10px",
          borderBottom: `1px solid ${tokens.color.edge}`,
          background: tokens.color.paper,
          flexWrap: "wrap",
          alignItems: "center",
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
          Filter:
        </span>

        {/* Status filter */}
        <select name="status" style={selectStyle}>
          <option value="" selected={!filterStatus}>All status</option>
          <option value="OK" selected={filterStatus === "OK"}>✓ OK</option>
          <option value="ERROR" selected={filterStatus === "ERROR"}>✗ Error</option>
        </select>

        {/* Model filter */}
        <select name="model" style={selectStyle}>
          <option value="" selected={!filterModel}>All models</option>
          {allModels.map((m) => (
            <option key={m} value={m} selected={filterModel === m}>
              {fmtModel(m)}
            </option>
          ))}
        </select>

        {/* Date range filter */}
        <select name="date" style={selectStyle}>
          <option value="" selected={!filterDate}>Today</option>
          <option value="7d" selected={filterDate === "7d"}>Last 7 days</option>
          <option value="30d" selected={filterDate === "30d"}>Last 30 days</option>
        </select>

        <button
          type="submit"
          style={{
            fontFamily: tokens.font.mono,
            fontSize: 10,
            color: tokens.color.sky,
            background: "transparent",
            border: `1px solid ${tokens.color.sky}`,
            borderRadius: tokens.radius.sm,
            padding: "4px 10px",
            cursor: "pointer",
          }}
        >
          Apply
        </button>

        {(filterStatus || filterModel || filterDate) && (
          <a
            href="/traces"
            style={{
              fontFamily: tokens.font.mono,
              fontSize: 10,
              color: tokens.color.ink3,
              textDecoration: "none",
            }}
          >
            clear
          </a>
        )}
      </form>

      {/* Totals summary bar */}
      <div
        style={{
          fontFamily: tokens.font.mono,
          fontSize: 11,
          color: tokens.color.ink3,
          padding: "6px 10px 10px",
          borderBottom: `1px solid ${tokens.color.edge}`,
        }}
      >
        Total today:{" "}
        <span style={{ color: tokens.color.ink2 }}>{traces.length}</span> turn
        {traces.length !== 1 ? "s" : ""} ·{" "}
        <span style={{ color: tokens.color.ink2 }}>
          {fmtTokens(totals.input + totals.output)}
        </span>{" "}
        tokens ·{" "}
        <span style={{ color: tokens.color.ink2 }}>{fmtCost(totals.cost)}</span>
      </div>

      {traces.length === 0 ? (
        <div
          style={{
            fontFamily: tokens.font.mono,
            fontSize: 12,
            color: tokens.color.ink3,
            padding: 16,
          }}
        >
          No traces match the current filters.
        </div>
      ) : (
        <div style={{ overflowX: "auto" }}>
          <table style={{ width: "100%", borderCollapse: "collapse", tableLayout: "fixed" }}>
            <colgroup>
              <col style={{ width: "80px" }} />   {/* When */}
              <col style={{ width: "140px" }} />  {/* Critique */}
              <col style={{ width: "160px" }} />  {/* Root */}
              <col style={{ width: "60px" }} />   {/* Status */}
              <col style={{ width: "140px" }} />  {/* Models */}
              <col style={{ width: "56px" }} />   {/* Spans */}
              <col style={{ width: "72px" }} />   {/* Tokens */}
              <col style={{ width: "72px" }} />   {/* Cached % */}
              <col style={{ width: "72px" }} />   {/* Cost */}
            </colgroup>
            <thead>
              <tr>
                <th style={headerStyle}>When</th>
                <th style={headerStyle}>Review</th>
                <th style={headerStyle}>Root</th>
                <th style={headerStyle}>Status</th>
                <th style={{ ...headerStyle, textAlign: "left" }}>Models</th>
                <th style={{ ...headerStyle, textAlign: "right" }}>Spans</th>
                <th style={{ ...headerStyle, textAlign: "right" }}>Tokens</th>
                <th style={{ ...headerStyle, textAlign: "right" }}>Cached %</th>
                <th style={{ ...headerStyle, textAlign: "right" }}>Cost</th>
              </tr>
            </thead>
            <tbody>
              {traces.map((t) => {
                const isOk = t.status !== "ERROR";
                return (
                  <tr key={t.trace_id} style={{ background: tokens.color.cream }}>
                    <td style={cellStyle}>
                      <a
                        href={`/traces/${t.trace_id}${fromParam}`}
                        style={{ color: tokens.color.sky, textDecoration: "none" }}
                      >
                        {formatTime(t.start_unix_nano)}
                      </a>
                    </td>
                    <td
                      style={{
                        ...cellStyle,
                        color: t.critique_id ? tokens.color.ink2 : tokens.color.ink3,
                        whiteSpace: "nowrap",
                        overflow: "hidden",
                        textOverflow: "clip",
                      }}
                      title={t.critique_id ?? undefined}
                    >
                      {t.critique_id ?? "—"}
                    </td>
                    <td
                      style={{
                        ...cellStyle,
                        color: tokens.color.ink3,
                        maxWidth: 160,
                        overflow: "hidden",
                        textOverflow: "ellipsis",
                      }}
                      title={t.name}
                    >
                      {t.name}
                    </td>
                    <td style={cellStyle}>
                      <span
                        style={{
                          color: isOk ? tokens.color.moss : tokens.color.terra,
                          fontWeight: "bold",
                        }}
                      >
                        {t.status === "ERROR" ? "✗" : "✓"}
                      </span>
                    </td>
                    <td style={cellStyle}>
                      <ModelBadges models={t.models} primary={t.model} />
                    </td>
                    <td style={{ ...cellStyle, textAlign: "right", color: tokens.color.ink3 }}>
                      {t.span_count}
                    </td>
                    <td style={{ ...cellStyle, textAlign: "right" }}>
                      {fmtTokens(t.total_input_tokens + t.total_output_tokens)}
                    </td>
                    <td
                      style={{
                        ...cellStyle,
                        textAlign: "right",
                        color:
                          t.cache_hit_pct > 50
                            ? tokens.color.moss
                            : t.cache_hit_pct > 0
                            ? tokens.color.ink2
                            : tokens.color.ink3,
                      }}
                    >
                      {t.total_input_tokens > 0
                        ? `${t.cache_hit_pct.toFixed(0)}%`
                        : "—"}
                    </td>
                    <td
                      style={{
                        ...cellStyle,
                        textAlign: "right",
                        color: t.cost_usd > 0 ? tokens.color.ink2 : tokens.color.ink3,
                      }}
                    >
                      {fmtCost(t.cost_usd)}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
