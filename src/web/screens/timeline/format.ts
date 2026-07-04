// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
// Copyright (c) 2026 Jiaqi Duan
/**
 * Timeline formatting helpers — pure functions shared by the /timeline
 * screen (summary line, rail rows, detail panes).
 */
import type { CriticCall } from "../../../state/api";

/**
 * Stable per-row identity used for Alpine row-select state. Matches the
 * uniqueness key RecentTable already uses for React keys
 * (`timestamp` + `session_id`); rows never share both.
 */
export function turnKey(c: CriticCall): string {
  return `${c.timestamp}|${c.session_id}`;
}

/** 12873 → "12.9k" · 950 → "950". Raw sums come from TelemetryTotals. */
export function fmtTokens(n: number): string {
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
  return String(n);
}

/**
 * "$0.00" for zero, 2 decimals for >= $0.01, 4 decimals for sub-cent
 * non-zero (typical single Haiku call) so small real spend never rounds
 * to a dishonest $0.00.
 */
export function fmtCost(usd: number): string {
  if (usd === 0) return "$0.00";
  if (usd < 0.01) return `$${usd.toFixed(4)}`;
  return `$${usd.toFixed(2)}`;
}

/** Per-row token total (same 4-field sum buildTotals uses). null → null. */
export function rowTokens(c: CriticCall): number | null {
  if (!c.tokens) return null;
  return c.tokens.input + c.tokens.output + c.tokens.cache_read + c.tokens.cache_create;
}

/** "—" for no duration, ms below 1s, one-decimal seconds above. */
export function fmtDurationMs(ms: number): string {
  if (ms <= 0) return "—";
  if (ms >= 1000) return `${(ms / 1000).toFixed(1)}s`;
  return `${ms.toFixed(0)}ms`;
}

/** Cost formatter matching TraceDetail's precision (sub-cent stays honest). */
export function fmtTraceCost(usd: number): string {
  if (usd === 0) return "$0.00";
  if (usd < 0.001) return `$${(usd * 1000).toFixed(3)}m`;
  return `$${usd.toFixed(4)}`;
}

/** Numeric span attribute (number or numeric string), 0 when absent. */
export function numAttr(
  attrs: Record<string, string | number | boolean> | undefined,
  key: string,
): number {
  const v = attrs?.[key];
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string") {
    const n = Number(v);
    if (Number.isFinite(n)) return n;
  }
  return 0;
}

/** String span attribute, "" when absent or non-string. */
export function strAttr(
  attrs: Record<string, string | number | boolean> | undefined,
  key: string,
): string {
  const v = attrs?.[key];
  return typeof v === "string" ? v : "";
}
