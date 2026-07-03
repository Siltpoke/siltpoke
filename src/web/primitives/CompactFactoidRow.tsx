// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Copyright (c) 2026 Jiaqi Duan
/** @jsxImportSource hono/jsx */
import { tokens } from "../tokens/tokens";
import { Pill } from "../atoms/Pill";
import type { Fact } from "../../memory/memory";

export interface CompactFactoidRowProps {
  fact: Fact;
  /** Injectable clock for deterministic tests. Defaults to Date.now(). */
  now?: Date;
}

interface StatusStyle {
  label: string;
  color: string;
  bg: string;
}

const STATUS_STYLES: Record<Fact["status"], StatusStyle> = {
  active: { label: "active", color: tokens.color.moss, bg: tokens.color.cream },
  pending: { label: "pending", color: tokens.color.amber, bg: tokens.color.cream },
  retired: { label: "retired", color: tokens.color.ink3, bg: tokens.color.cream },
  // Treat retire_proposed the same as retired visually (decay UI is a later task)
  retire_proposed: { label: "retiring", color: tokens.color.ink3, bg: tokens.color.cream },
};

/**
 * Format an ISO timestamp as a compact relative string against `now`.
 *
 *   <1m   → "just now"
 *   <60m  → "{n}m ago"
 *   <24h  → "{n}h ago"
 *   <7d   → "{n}d ago"
 *   else  → "{n}w ago" (capped at 99w)
 */
export function relativeAgo(isoTs: string, now: Date): string {
  const then = new Date(isoTs).getTime();
  const diffMs = now.getTime() - then;
  if (Number.isNaN(diffMs) || diffMs < 0) return "now";
  const sec = Math.floor(diffMs / 1000);
  if (sec < 60) return "just now";
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const day = Math.floor(hr / 24);
  if (day < 7) return `${day}d ago`;
  const week = Math.min(99, Math.floor(day / 7));
  return `${week}w ago`;
}

export function CompactFactoidRow(props: CompactFactoidRowProps) {
  const { fact, now = new Date() } = props;
  const style = STATUS_STYLES[fact.status];
  const ts = relativeAgo(fact.last_seen_at, now);

  return (
    <div
      class="compact-factoid-row"
      data-fact-id={fact.id}
      data-fact-status={fact.status}
      style={{
        display: "flex",
        alignItems: "center",
        gap: 8,
        padding: "6px 8px",
        borderBottom: `1px solid ${tokens.color.edge}`,
        minHeight: 28,
      }}
    >
      <span
        class="compact-factoid-row__text"
        style={{
          flex: 1,
          minWidth: 0,
          fontFamily: tokens.font.body,
          fontSize: 12,
          color: tokens.color.ink,
          whiteSpace: "nowrap",
          overflow: "hidden",
          textOverflow: "ellipsis",
        }}
      >
        {fact.text}
      </span>
      <Pill color={style.color} bg={style.bg}>
        {style.label}
      </Pill>
      <span
        class="compact-factoid-row__ts"
        style={{
          fontFamily: tokens.font.mono,
          fontSize: 10,
          color: tokens.color.ink3,
          minWidth: 56,
          textAlign: "right",
        }}
      >
        {ts}
      </span>
    </div>
  );
}
