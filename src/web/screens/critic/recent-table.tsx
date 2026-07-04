// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
// Copyright (c) 2026 Jiaqi Duan
/** @jsxImportSource hono/jsx */
/**
 * Critic table primitives — RecentTable (the main fired/skipped activity
 * list) + row-level helpers shared with RecentRow.
 *
 * Extracted from src/web/screens/Critic.tsx.
 */
import { tokens } from "../../tokens/tokens";
import type { CriticCall, CriticTelemetry } from "../../../state/api";
import { STATUS_COLOR, formatTimeAgo } from "./helpers";
import { RecentRow } from "./recent-row";

/**
 * Bug 4 fix: collapse consecutive recursion_guard skips into a single muted
 * summary row to reduce noise. Returns a mixed array of CriticCall entries and
 * synthetic { kind: "recursion_guard_group"; count: number; timestamp: string }
 * objects.
 */
type RecursionGuardGroup = { kind: "recursion_guard_group"; count: number; timestamp: string };
type RowItem = CriticCall | RecursionGuardGroup;

function isRecursionGuard(c: CriticCall): boolean {
  return c.status === "skipped" && c.skip_reason === "recursion_guard";
}

function countConsecutiveGuards(rows: CriticCall[], start: number): number {
  let count = 0;
  while (start + count < rows.length && isRecursionGuard(rows[start + count]!)) {
    count++;
  }
  return count;
}

export function groupRecursionGuards(rows: CriticCall[]): RowItem[] {
  const out: RowItem[] = [];
  let i = 0;
  while (i < rows.length) {
    const c = rows[i]!;
    if (!isRecursionGuard(c)) {
      out.push(c);
      i++;
      continue;
    }
    const count = countConsecutiveGuards(rows, i);
    out.push({ kind: "recursion_guard_group", count, timestamp: c.timestamp });
    i += count;
  }
  return out;
}

function RecursionGuardGroupRow({ item, now }: { item: RecursionGuardGroup; now: Date }) {
  return (
    <div
      style={{
        borderBottom: `1px solid ${tokens.color.edge}`,
        padding: "4px 4px",
        display: "flex",
        alignItems: "center",
        gap: 8,
        opacity: 0.45,
      }}
    >
      <span style={{ fontFamily: tokens.font.mono, fontSize: 10, color: tokens.color.ink3, minWidth: 60 }}>
        {formatTimeAgo(item.timestamp, now)} ago
      </span>
      <span style={{ fontFamily: tokens.font.mono, fontSize: 10, color: tokens.color.ink3 }}>
        {item.count}× recursion_guard skipped
      </span>
    </div>
  );
}

export function RecentTable({ telemetry, now }: { telemetry: CriticTelemetry; now: Date }) {
  const rows = telemetry.recent;
  const grouped = groupRecursionGuards(rows);
  return (
    <div
      class="critic-recent"
      style={{
        border: `1px solid ${tokens.color.edge}`,
        borderRadius: tokens.radius.md,
        background: tokens.color.paper,
        padding: 16,
        display: "flex",
        flexDirection: "column",
        gap: 10,
        minHeight: 0,
        overflow: "hidden",
      }}
    >
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 16, flexWrap: "wrap" }}>
        <span
          style={{
            fontFamily: tokens.font.mono,
            fontSize: 10,
            letterSpacing: "0.08em",
            textTransform: "uppercase",
            color: tokens.color.ink3,
          }}
        >
          RECENT ACTIVITY · click a FIRED row to expand
        </span>
        <span style={{ display: "flex", alignItems: "center", gap: 10, fontFamily: tokens.font.mono, fontSize: 10, color: tokens.color.ink3 }}>
          <span style={{ display: "flex", alignItems: "center", gap: 4 }}>
            <span style={{ width: 8, height: 8, borderRadius: "50%", background: tokens.color.moss, display: "inline-block" }} />
            comment
          </span>
          <span style={{ display: "flex", alignItems: "center", gap: 4 }}>
            <span style={{ width: 8, height: 8, borderRadius: "50%", background: tokens.color.amber, display: "inline-block" }} />
            warning
          </span>
          <span style={{ display: "flex", alignItems: "center", gap: 4 }}>
            <span style={{ width: 8, height: 8, borderRadius: "50%", background: tokens.color.terra, display: "inline-block" }} />
            critical
          </span>
          <span>· {rows.length} entries</span>
        </span>
      </div>
      {rows.length === 0 ? (
        <div
          style={{
            fontFamily: tokens.font.body,
            fontSize: 12,
            color: tokens.color.ink3,
            textAlign: "center",
            padding: 16,
          }}
        >
          no recent brain-call entries
        </div>
      ) : (
        <div
          class="critic-recent__scroll"
          style={{
            display: "flex",
            flexDirection: "column",
            gap: 0,
            flex: 1,
            minHeight: 0,
            overflowY: "auto",
            paddingRight: 4,
          }}
        >
          {grouped.map((item: RowItem) =>
            "kind" in item && item.kind === "recursion_guard_group"
              ? <RecursionGuardGroupRow key={`rg-${item.timestamp}`} item={item} now={now} />
              : <RecentRow
                  key={`${(item as CriticCall).timestamp}-${(item as CriticCall).session_id}`}
                  c={item as CriticCall}
                  now={now}
                  homeBasename={telemetry.homeBasename}
                  preferenceStats={telemetry.preferenceStats}
                />
          )}
        </div>
      )}
    </div>
  );
}

/**
 * Map raw project key (cwd basename) to a display label.
 * - homeBasename (e.g. "alice") → "home (~)"
 * - "(daemon)" passes through
 * - anything else → raw
 */
