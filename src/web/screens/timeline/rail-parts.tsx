// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
// Copyright (c) 2026 Jiaqi Duan
/** @jsxImportSource hono/jsx */
/** Small presentational pieces of the timeline rail, split out of rail.tsx (length ratchet). */
import type { CriticCall } from "../../../state/api";
import { tokens } from "../../tokens/tokens";
import { formatTimeAgo } from "../critic/helpers";
import { fmtCost, fmtTokens, rowTokens } from "./format";

export function QuotaCapNote({ text }: { text: string }) {
  return (
    <div
      data-quota-cap-note
      style={{ fontFamily: tokens.font.body, fontSize: 11, lineHeight: 1.45, color: tokens.color.ink2, marginTop: 4 }}
    >
      {text}
    </div>
  );
}

export function RailGuardGroupRow({ count, timestamp, now }: { count: number; timestamp: string; now: Date }) {
  return (
    <div
      style={{
        borderBottom: `1px solid ${tokens.color.edge}`,
        padding: "6px 14px",
        display: "flex",
        alignItems: "center",
        gap: 8,
        opacity: 0.45,
        fontFamily: tokens.font.mono,
        fontSize: 10,
        color: tokens.color.ink3,
      }}
    >
      <span style={{ minWidth: 40 }}>{formatTimeAgo(timestamp, now)} ago</span>
      <span>{count}× recursion_guard skipped</span>
    </div>
  );
}

export function RailRowCostLine({ c }: { c: CriticCall }) {
  const tokTotal = rowTokens(c);
  return (
    <div
      style={{
        display: "flex",
        gap: 9,
        marginTop: 4,
        fontFamily: tokens.font.mono,
        fontSize: 9,
        color: tokens.color.ink3,
      }}
    >
      <span>{c.cost_usd !== null ? fmtCost(c.cost_usd) : "$—"}</span>
      <span>{tokTotal !== null ? `${fmtTokens(tokTotal)} tok` : "— tok"}</span>
      {c.duration_ms !== null && <span>{(c.duration_ms / 1000).toFixed(1)}s</span>}
    </div>
  );
}
