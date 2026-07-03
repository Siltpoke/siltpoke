// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Copyright (c) 2026 Jiaqi Duan
/** @jsxImportSource hono/jsx */
/**
 * Block F — COST
 *
 * Shows tokens (input / output / cache read+create), cache hit %, $ cost,
 * and per-stage timing for the critique. Sources from CriticCall fields;
 * v2 doesn't add cost data yet.
 *
 * Extracted from CritiqueAuditBlocks.tsx.
 */
import { tokens } from "../../tokens/tokens";
import type { V2SidecarData } from "../../../state/api";
import type { CriticCall } from "../../../state/api";
import { AuditSection, PlaceholderNote } from "./shared";

export interface BlockFProps {
  v2: V2SidecarData | null;
  c: CriticCall;
}

export function BlockF({ v2, c }: BlockFProps) {
  const tokens_ = c.tokens;
  const costUsd = c.cost_usd;
  const timing = c.timing;

  let cacheHitPct: number | null = null;
  if (tokens_) {
    const total = tokens_.input + tokens_.output + tokens_.cache_read + tokens_.cache_create;
    cacheHitPct = total > 0 ? (tokens_.cache_read / total) * 100 : 0;
  }

  void v2;

  return (
    <AuditSection id="F" label="F · COST">
      {tokens_ ? (
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "1fr 1fr",
            gap: 6,
            fontFamily: tokens.font.mono,
            fontSize: 10,
            color: tokens.color.ink2,
          }}
        >
          <span>input: {tokens_.input.toLocaleString()}</span>
          <span>output: {tokens_.output.toLocaleString()}</span>
          <span>cache read: {tokens_.cache_read.toLocaleString()}</span>
          <span>cache create: {tokens_.cache_create.toLocaleString()}</span>
          {cacheHitPct !== null && (
            <span>cache hit: {cacheHitPct.toFixed(1)}%</span>
          )}
          {costUsd != null && (
            <span style={{ color: tokens.color.ink, fontWeight: 500 }}>
              $ {costUsd.toFixed(4)}
            </span>
          )}
        </div>
      ) : costUsd != null ? (
        <div
          style={{ fontFamily: tokens.font.mono, fontSize: 10, color: tokens.color.ink2 }}
        >
          $ {costUsd.toFixed(4)} (no token breakdown available)
        </div>
      ) : (
        <PlaceholderNote text="no cost data — older entry or skipped call" />
      )}

      {timing && (
        <div
          style={{
            fontFamily: tokens.font.mono,
            fontSize: 10,
            color: tokens.color.ink3,
            display: "flex",
            gap: 14,
            flexWrap: "wrap",
          }}
        >
          <span>summary {Math.round(timing.summary_ms / 100) / 10}s</span>
          <span>critic {Math.round(timing.critic_ms / 100) / 10}s</span>
          <span>total {Math.round(timing.wall_ms / 100) / 10}s</span>
        </div>
      )}
    </AuditSection>
  );
}
