// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Copyright (c) 2026 Jiaqi Duan
/** @jsxImportSource hono/jsx */
/**
 * FewShotPanel — compact card showing few-shot index stats.
 *
 * Reads ~/.siltpoke/few-shot-index.json. Shows: entry count, embedding dim,
 * and embedder type (fastembed local or stub).
 */
import { tokens } from "../tokens/tokens";

export interface FewShotStats {
  entries: number;
  dim: number;
  embedder: "fastembed" | "stub";
}

export interface FewShotPanelProps {
  fewShotStats: FewShotStats | null;
}

export function FewShotPanel({ fewShotStats }: FewShotPanelProps) {
  return (
    <div
      class="few-shot-panel"
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
          FEW-SHOT
        </span>
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
      </div>

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
          <div
            style={{
              display: "flex",
              justifyContent: "space-between",
              fontFamily: tokens.font.mono,
              fontSize: 10,
            }}
          >
            <span style={{ color: tokens.color.ink3 }}>entries</span>
            <span style={{ color: tokens.color.ink2 }}>{fewShotStats.entries}</span>
          </div>
          <div
            style={{
              display: "flex",
              justifyContent: "space-between",
              fontFamily: tokens.font.mono,
              fontSize: 10,
            }}
          >
            <span style={{ color: tokens.color.ink3 }}>dim</span>
            <span style={{ color: tokens.color.ink2 }}>{fewShotStats.dim}</span>
          </div>

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
