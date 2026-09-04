// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
// Copyright (c) 2026 Jiaqi Duan
/** @jsxImportSource hono/jsx */
/**
 * FewShotPanel — compact card showing few-shot index stats.
 *
 * Reads ~/.siltpoke/few-shot-index.json. Shows: entry count, embedding dim,
 * and embedder type (fastembed local or stub).
 */
import { tokens } from "../tokens/tokens";
import { PanelHeader, panelCardStyle } from "./panel-card";

export interface FewShotStats {
  entries: number;
  dim: number;
  embedder: "fastembed" | "stub";
}

export interface FewShotPanelProps {
  fewShotStats: FewShotStats | null;
}

function StatKV({ label, value }: { label: string; value: string | number }) {
  return (
    <div
      style={{
        display: "flex",
        justifyContent: "space-between",
        fontFamily: tokens.font.mono,
        fontSize: 10,
      }}
    >
      <span style={{ color: tokens.color.ink3 }}>{label}</span>
      <span style={{ color: tokens.color.ink2 }}>{value}</span>
    </div>
  );
}

export function FewShotPanel({ fewShotStats }: FewShotPanelProps) {
  return (
    <div class="few-shot-panel" style={{ ...panelCardStyle, gap: 6 }}>
      <PanelHeader
        label="FEW-SHOT"
        right={
          <a
            href="/few-shot"
            style={{
              fontFamily: tokens.font.mono,
              fontSize: 9,
              color: tokens.color.sky,
              textDecoration: "none",
            }}
          >
            explore →
          </a>
        }
      />

      {fewShotStats === null ? (
        <div
          style={{
            fontFamily: tokens.font.mono,
            fontSize: 10,
            color: tokens.color.ink3,
          }}
        >
          no index found
        </div>
      ) : (
        <>
          {/* Entry count + dim */}
          <StatKV label="entries" value={fewShotStats.entries} />
          <StatKV label="dim" value={fewShotStats.dim} />

          {/* Embedder status */}
          <div
            style={{
              fontFamily: tokens.font.mono,
              fontSize: 9,
              color: tokens.color.ink3,
              paddingTop: 2,
            }}
          >
            embedder:{" "}
            {fewShotStats.embedder === "fastembed"
              ? "fastembed (local)"
              : "stub"}
          </div>
        </>
      )}
    </div>
  );
}
