// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Copyright (c) 2026 Jiaqi Duan
/** @jsxImportSource hono/jsx */
/**
 * Critic screen panels — GateCheckList, BudgetGauge, BudgetEditor,
 * BudgetField, SkipHistogram.
 *
 * Extracted from src/web/screens/Critic.tsx.
 */
import { tokens } from "../../tokens/tokens";
import type { CriticTelemetry } from "../../../state/api";
import { filterHref, STATUS_COLOR } from "./helpers";

export function GateCheckList({ telemetry }: { telemetry: CriticTelemetry }) {
  const { gateState } = telemetry;
  return (
    <div
      class="critic-gates"
      style={{
        border: `1px solid ${tokens.color.edge}`,
        borderRadius: tokens.radius.md,
        background: tokens.color.paper,
        padding: 16,
        display: "flex",
        flexDirection: "column",
        gap: 10,
      }}
    >
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
        <span
          style={{
            fontFamily: tokens.font.mono,
            fontSize: 10,
            letterSpacing: "0.08em",
            textTransform: "uppercase",
            color: tokens.color.ink3,
          }}
        >
          GATE DIAGNOSTIC
        </span>
        <span
          style={{
            fontFamily: tokens.font.body,
            fontSize: 11,
            color: gateState.blocking ? tokens.color.terra : tokens.color.moss,
            fontWeight: 600,
          }}
        >
          {gateState.blocking ? `Blocked at: ${gateState.blocking}` : "All gates open"}
        </span>
      </div>
      <div style={{ fontFamily: tokens.font.body, fontSize: 13, color: tokens.color.ink2 }}>
        {gateState.detail}
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: 4, marginTop: 4 }}>
        {gateState.checks
          // Hide passing rows to keep the panel signal-only. Budget when
          // passing is covered by the BUDGET card below; quiet-hours when
          // passing surfaces as a header pill on Home. Blocking rows always
          // show so the "why is critic silent" panel stays self-contained.
          .filter((c) => {
            if (c.pass && (c.name === "budget" || c.name === "quiet hours")) return false;
            return true;
          })
          .map((c) => (
            <div
              key={c.name}
              style={{
                display: "flex",
                alignItems: "center",
                gap: 8,
                fontFamily: tokens.font.mono,
                fontSize: 11,
                color: tokens.color.ink2,
              }}
            >
              <span
                style={{
                  width: 8,
                  height: 8,
                  borderRadius: "50%",
                  background: c.pass ? tokens.color.moss : tokens.color.terra,
                  flexShrink: 0,
                }}
              />
              <span style={{ minWidth: 96, color: tokens.color.ink }}>{c.name}</span>
              <span style={{ color: tokens.color.ink3 }}>{c.detail}</span>
            </div>
          ))}
      </div>
    </div>
  );
}

export function BudgetGauge({ telemetry }: { telemetry: CriticTelemetry }) {
  const { budget } = telemetry;
  const pct = Math.min(100, Math.max(0, budget.used_pct));
  const softPct = budget.config.softWarnAtPercent;
  const hardPct = budget.config.hardStopAtPercent;
  const barColor =
    budget.stage === "hard"
      ? tokens.color.terra
      : budget.stage === "soft"
        ? tokens.color.amber
        : tokens.color.moss;
  const rollup = budget.rollup;

  return (
    <div
      class="critic-budget"
      style={{
        border: `1px solid ${tokens.color.edge}`,
        borderRadius: tokens.radius.md,
        background: tokens.color.paper,
        padding: 16,
        display: "flex",
        flexDirection: "column",
        gap: 10,
      }}
    >
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
        <span
          style={{
            fontFamily: tokens.font.mono,
            fontSize: 10,
            letterSpacing: "0.08em",
            textTransform: "uppercase",
            color: tokens.color.ink3,
          }}
        >
          BUDGET
        </span>
        <span
          style={{
            fontFamily: tokens.font.mono,
            fontSize: 11,
            color: tokens.color.ink2,
          }}
        >
          today · {budget.stage.toUpperCase()}
        </span>
      </div>

      {/* Bar w/ soft + hard markers */}
      <div
        style={{
          position: "relative",
          height: 14,
          background: tokens.color.cream,
          border: `1px solid ${tokens.color.edge}`,
          borderRadius: 4,
          overflow: "hidden",
        }}
      >
        <div style={{ width: `${pct}%`, height: "100%", background: barColor }} />
        <div
          aria-label="soft threshold"
          style={{
            position: "absolute",
            left: `${softPct}%`,
            top: 0,
            bottom: 0,
            width: 1,
            background: tokens.color.amber,
          }}
        />
        <div
          aria-label="hard threshold"
          style={{
            position: "absolute",
            left: `${hardPct}%`,
            top: 0,
            bottom: 0,
            width: 1,
            background: tokens.color.terra,
          }}
        />
      </div>
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          fontFamily: tokens.font.mono,
          fontSize: 11,
          color: tokens.color.ink3,
        }}
      >
        <span>{budget.used_pct.toFixed(1)}% used</span>
        <span>{budget.remaining_tokens.toLocaleString()} remaining</span>
      </div>

      {/* Token breakdown */}
      {rollup && (
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "1fr 1fr",
            gap: 6,
            fontFamily: tokens.font.mono,
            fontSize: 10,
            color: tokens.color.ink2,
            marginTop: 4,
          }}
        >
          <span>input: {rollup.total_input_tokens.toLocaleString()}</span>
          <span>output: {rollup.total_output_tokens.toLocaleString()}</span>
          <span>cache (raw): {rollup.total_cache_tokens.toLocaleString()}</span>
          <span>cache (10%): {Math.round(rollup.total_cache_tokens * 0.1).toLocaleString()}</span>
          <span>brain calls: {rollup.brain_calls}</span>
          <span>$ today: ${rollup.total_cost_usd.toFixed(4)}</span>
        </div>
      )}

      <BudgetEditor config={budget.config} />
    </div>
  );
}

function BudgetEditor({ config }: { config: { dailyTokenLimit: number; softWarnAtPercent: number; hardStopAtPercent: number } }) {
  // Submit handler: skip any field the user left blank so we don't
  // overwrite a real value with 0 (which is what Number("") returns).
  // Server-side merge keeps unchanged fields at their current setting.
  const submit =
    `event.preventDefault();` +
    `const f=event.target;` +
    `const body={};` +
    `for(const k of ['dailyTokenLimit','softWarnAtPercent','hardStopAtPercent']){` +
    `const v=f[k].value.trim();` +
    `if(v.length>0){const n=Number(v);if(!Number.isFinite(n)){alert(k+' must be a number');return;}body[k]=n;}` +
    `}` +
    `if(Object.keys(body).length===0){alert('no fields changed');return;}` +
    `fetch('/api/critic/budget',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)})` +
    `.then(r=>r.ok?location.reload():alert('save failed'))`;
  return (
    <div x-data="{open:false}" style={{ marginTop: 6, borderTop: `1px solid ${tokens.color.edge}`, paddingTop: 8 }}>
      <button
        type="button"
        x-on:click="open=!open"
        style={{
          background: "transparent",
          border: "none",
          padding: 0,
          fontFamily: tokens.font.mono,
          fontSize: 10,
          textTransform: "uppercase",
          letterSpacing: "0.08em",
          color: tokens.color.ink3,
          cursor: "pointer",
          textDecoration: "underline dotted",
        }}
        x-text="open ? 'edit budget · hide' : 'edit budget'"
      >
        edit budget
      </button>
      <div
        x-show="open"
        x-cloak
        style={{
          marginTop: 10,
          display: "flex",
          flexDirection: "column",
          gap: 8,
        }}
      >
        <div
          style={{
            fontFamily: tokens.font.mono,
            fontSize: 10,
            color: tokens.color.ink3,
            lineHeight: 1.5,
          }}
        >
          leave a field blank to keep its current value. defaults: daily 500,000 · soft 80% · hard 100%.
        </div>
        <form
          x-on:submit={submit}
          style={{
            display: "grid",
            gridTemplateColumns: "1fr 1fr 1fr auto",
            gap: 8,
            alignItems: "end",
          }}
        >
          <BudgetField name="dailyTokenLimit" label={`daily limit · current ${config.dailyTokenLimit.toLocaleString()}`} value={config.dailyTokenLimit} step="1000" />
          <BudgetField name="softWarnAtPercent" label={`soft warn · current ${config.softWarnAtPercent}%`} value={config.softWarnAtPercent} step="1" />
          <BudgetField name="hardStopAtPercent" label={`hard stop · current ${config.hardStopAtPercent}%`} value={config.hardStopAtPercent} step="1" />
          <button
            type="submit"
            style={{
              fontFamily: tokens.font.mono,
              fontSize: 10,
              textTransform: "uppercase",
              letterSpacing: "0.06em",
              padding: "5px 12px",
              background: tokens.color.ink,
              color: tokens.color.cream,
              border: `1px solid ${tokens.color.ink}`,
              borderRadius: tokens.radius.pill,
              cursor: "pointer",
            }}
          >
            save
          </button>
        </form>
      </div>
    </div>
  );
}

function BudgetField({ name, label, value, step }: { name: string; label: string; value: number; step: string }) {
  return (
    <label style={{ display: "flex", flexDirection: "column", gap: 3 }}>
      <span style={{ fontFamily: tokens.font.mono, fontSize: 9, color: tokens.color.ink3, textTransform: "uppercase", letterSpacing: "0.06em" }}>{label}</span>
      <input
        type="number"
        name={name}
        value={String(value)}
        placeholder={String(value)}
        step={step}
        min="0"
        style={{
          fontFamily: tokens.font.mono,
          fontSize: 11,
          padding: "4px 8px",
          border: `1px solid ${tokens.color.edge}`,
          borderRadius: tokens.radius.sm,
          background: tokens.color.cream,
          color: tokens.color.ink,
          width: "100%",
          boxSizing: "border-box",
        }}
      />
    </label>
  );
}

export function SkipHistogram({ telemetry }: { telemetry: CriticTelemetry }) {
  const { breakdown } = telemetry;
  const entries = Object.entries(breakdown.counts).sort((a, b) => b[1] - a[1]);
  const max = entries.length > 0 ? Math.max(...entries.map(([, n]) => n)) : 1;

  return (
    <div
      class="critic-histogram"
      style={{
        border: `1px solid ${tokens.color.edge}`,
        borderRadius: tokens.radius.md,
        background: tokens.color.paper,
        padding: 16,
        display: "flex",
        flexDirection: "column",
        gap: 10,
      }}
    >
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
        <span
          style={{
            fontFamily: tokens.font.mono,
            fontSize: 10,
            letterSpacing: "0.08em",
            textTransform: "uppercase",
            color: tokens.color.ink3,
          }}
        >
          REASON BREAKDOWN
        </span>
        <span
          style={{
            fontFamily: tokens.font.mono,
            fontSize: 10,
            color: tokens.color.ink3,
          }}
        >
          last {breakdown.total} entries
        </span>
      </div>
      {entries.length === 0 ? (
        <div
          style={{
            fontFamily: tokens.font.body,
            fontSize: 12,
            color: tokens.color.ink3,
            textAlign: "center",
            padding: "12px 0",
          }}
        >
          no recent activity
        </div>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
          {entries.map(([reason, count]) => {
            const pct = (count / breakdown.total) * 100;
            const barWidth = (count / max) * 100;
            const color = STATUS_COLOR[reason] ?? tokens.color.ink3;
            return (
              <div
                key={reason}
                style={{ display: "grid", gridTemplateColumns: "150px 1fr 60px", gap: 8, alignItems: "center" }}
              >
                <span
                  style={{
                    fontFamily: tokens.font.mono,
                    fontSize: 11,
                    color: tokens.color.ink2,
                  }}
                >
                  {reason}
                </span>
                <div
                  style={{
                    height: 10,
                    background: tokens.color.cream,
                    border: `1px solid ${tokens.color.edge}`,
                    borderRadius: 3,
                    overflow: "hidden",
                  }}
                >
                  <div style={{ width: `${barWidth}%`, height: "100%", background: color }} />
                </div>
                <span
                  style={{
                    fontFamily: tokens.font.mono,
                    fontSize: 10,
                    color: tokens.color.ink3,
                    textAlign: "right",
                  }}
                >
                  {count} · {pct.toFixed(0)}%
                </span>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
