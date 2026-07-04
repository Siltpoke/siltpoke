// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
// Copyright (c) 2026 Jiaqi Duan
/** @jsxImportSource hono/jsx */
/**
 * BiasAuditPanel — compact card showing 7-day Haiku vs Ollama disagreement rate.
 *
 * Reads delta from computeBiasAuditDelta. Renders only when biasAudit.enabled.
 * Displays severity and category disagreement percentages with a status indicator.
 */
import { tokens } from "../tokens/tokens";

export interface BiasAuditConfig {
  enabled: boolean;
}

export interface BiasAuditDelta {
  sampleSize: number;
  severityDisagreementPct: number;
  categoryDisagreementPct: number;
  alert: boolean;
}

export interface BiasAuditPanelProps {
  config: BiasAuditConfig;
  delta: BiasAuditDelta;
}

export function BiasAuditPanel({ config, delta }: BiasAuditPanelProps) {
  if (!config.enabled) return null;

  const statusDot = delta.alert ? "🟡" : "🟢";
  const statusLabel = delta.alert ? "WARN" : "OK";
  const statusColor = delta.alert ? tokens.color.amber : tokens.color.moss;

  return (
    <div
      class="bias-audit-panel"
      style={{
        border: `1px solid ${tokens.color.edge}`,
        borderRadius: tokens.radius.sm,
        background: tokens.color.paper,
        padding: "10px 12px",
        display: "flex",
        flexDirection: "column",
        gap: 6,
      }}
    >
      {/* Header row */}
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
        }}
      >
        <span
          style={{
            fontFamily: tokens.font.mono,
            fontSize: 10,
            color: tokens.color.ink3,
            letterSpacing: "0.08em",
            textTransform: "uppercase",
            fontWeight: 500,
          }}
        >
          BIAS AUDIT
        </span>
        <span
          class="bias-audit-panel__status"
          style={{
            fontFamily: tokens.font.mono,
            fontSize: 10,
            color: statusColor,
          }}
        >
          {statusDot} {statusLabel}
        </span>
      </div>

      {/* Sample size */}
      <div
        style={{
          fontFamily: tokens.font.mono,
          fontSize: 10,
          color: tokens.color.ink3,
        }}
      >
        7d sample: {delta.sampleSize}
      </div>

      {/* Disagreement rows */}
      <div
        style={{
          display: "flex",
          flexDirection: "column",
          gap: 3,
        }}
      >
        <div
          class="bias-audit-panel__severity"
          style={{
            display: "flex",
            justifyContent: "space-between",
            fontFamily: tokens.font.mono,
            fontSize: 10,
          }}
        >
          <span style={{ color: tokens.color.ink3 }}>severity disagree</span>
          <span
            style={{
              color: delta.severityDisagreementPct > 15 ? tokens.color.amber : tokens.color.ink2,
            }}
          >
            {delta.severityDisagreementPct.toFixed(1)}%
          </span>
        </div>
        <div
          class="bias-audit-panel__category"
          style={{
            display: "flex",
            justifyContent: "space-between",
            fontFamily: tokens.font.mono,
            fontSize: 10,
          }}
        >
          <span style={{ color: tokens.color.ink3 }}>category disagree</span>
          <span
            style={{
              color: delta.categoryDisagreementPct > 15 ? tokens.color.amber : tokens.color.ink2,
            }}
          >
            {delta.categoryDisagreementPct.toFixed(1)}%
          </span>
        </div>
      </div>
    </div>
  );
}
