// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
// Copyright (c) 2026 Jiaqi Duan
/** @jsxImportSource hono/jsx */
/**
 * ModelsPanel — dual-model compact card showing primary critic + bias audit LLMs.
 *
 * Primary critic: Claude Haiku 4.5 (Anthropic) — used by Brain via `claude -p`.
 * Bias audit:     Qwen2.5-Coder-7B-Q4 (local Ollama) — optional, gated by config.
 */
import { tokens } from "../tokens/tokens";

export interface ModelsInfo {
  primary: { name: string; provider: string };
  biasAudit: { name: string; provider: string; enabled: boolean };
  verifierMode: "off" | "conditional" | "always";
}

export interface ModelsPanelProps {
  modelsInfo: ModelsInfo;
}

function ProviderBadge({ provider }: { provider: string }) {
  return (
    <span
      style={{
        fontFamily: tokens.font.mono,
        fontSize: 9,
        color: tokens.color.ink3,
        background: tokens.color.paperD,
        border: `1px solid ${tokens.color.edge}`,
        borderRadius: tokens.radius.sm,
        padding: "1px 5px",
        letterSpacing: "0.04em",
        textTransform: "uppercase",
      }}
    >
      {provider}
    </span>
  );
}

function StatusPill({
  label,
  active,
}: {
  label: string;
  active: boolean;
}) {
  const color = active ? tokens.color.moss : tokens.color.ink3;
  const bg = active
    ? `color-mix(in srgb, ${tokens.color.moss} 13%, transparent)`
    : `color-mix(in srgb, ${tokens.color.ink3} 9%, transparent)`;
  return (
    <span
      style={{
        fontFamily: tokens.font.mono,
        fontSize: 9,
        color,
        background: bg,
        border: `1px solid ${color}`,
        borderRadius: tokens.radius.pill,
        padding: "1px 6px",
        letterSpacing: "0.04em",
      }}
    >
      {label}
    </span>
  );
}

function ModelRow({
  name,
  provider,
  statusLabel,
  active,
}: {
  name: string;
  provider: string;
  statusLabel: string;
  active: boolean;
}) {
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        gap: 6,
        padding: "4px 0",
        borderBottom: `1px solid ${tokens.color.edge}`,
      }}
    >
      <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
        <span
          style={{
            fontFamily: tokens.font.mono,
            fontSize: 10,
            color: tokens.color.ink2,
            fontWeight: 500,
          }}
        >
          {name}
        </span>
        <ProviderBadge provider={provider} />
      </div>
      <StatusPill label={statusLabel} active={active} />
    </div>
  );
}

export function ModelsPanel({ modelsInfo }: ModelsPanelProps) {
  const biasActive = modelsInfo.biasAudit.enabled;
  const biasStatusLabel = biasActive ? "enabled" : "disabled";

  return (
    <div
      class="models-panel"
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
      {/* Header */}
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          marginBottom: 2,
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
          MODELS
        </span>
        <span
          style={{
            fontFamily: tokens.font.mono,
            fontSize: 9,
            color: tokens.color.ink3,
          }}
        >
          verifier: {modelsInfo.verifierMode}
        </span>
      </div>

      {/* Primary critic row */}
      <ModelRow
        name={modelsInfo.primary.name}
        provider={modelsInfo.primary.provider}
        statusLabel="primary reviewer"
        active={true}
      />

      {/* Bias audit row — last item, no bottom border override needed */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: 6,
          paddingTop: 4,
        }}
      >
        <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
          <span
            style={{
              fontFamily: tokens.font.mono,
              fontSize: 10,
              color: tokens.color.ink2,
              fontWeight: 500,
            }}
          >
            {modelsInfo.biasAudit.name}
          </span>
          <ProviderBadge provider={modelsInfo.biasAudit.provider} />
        </div>
        <StatusPill label={biasStatusLabel} active={biasActive} />
      </div>
    </div>
  );
}
