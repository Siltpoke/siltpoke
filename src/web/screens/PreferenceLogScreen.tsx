// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Copyright (c) 2026 Jiaqi Duan
/** @jsxImportSource hono/jsx */
/**
 * PreferenceLogScreen — /preference-log
 *
 * Shows countBySignal summary + last 50 preference-log entries.
 */
import { Dashboard } from "../shells/Dashboard";
import { CANONICAL_NAV } from "../routes/nav";
import { tokens } from "../tokens/tokens";
import type { PreferenceLogEntry } from "../../preference-log/types";

const SIGNAL_COLORS: Record<string, string> = {
  ack: tokens.color.moss,
  dismiss: tokens.color.terra,
  forward: tokens.color.sky,
  feedback: tokens.color.amber,
};

function relativeTs(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  if (diff < 0) return "just now";
  const secs = Math.floor(diff / 1000);
  if (secs < 60) return `${secs}s ago`;
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  return `${days}d ago`;
}

export interface PreferenceLogScreenProps {
  entries: PreferenceLogEntry[];
  counts: Record<string, number>;
}

export function PreferenceLogScreen({ entries, counts }: PreferenceLogScreenProps) {
  const total = Object.values(counts).reduce((a, b) => a + b, 0);

  return (
    <Dashboard navSections={CANONICAL_NAV} activeSection="preference-log">
      <div style={{ padding: 16 }}>
        <div style={{ marginBottom: 16 }}>
          <span
            style={{
              fontFamily: tokens.font.mono,
              fontSize: 10,
              color: tokens.color.ink3,
              letterSpacing: "0.08em",
              textTransform: "uppercase",
              display: "block",
              marginBottom: 4,
            }}
          >
            PREFERENCE LOG · {total} signals
          </span>
          <h1
            style={{
              margin: "0 0 4px",
              fontFamily: tokens.font.display,
              fontSize: 28,
              fontWeight: 400,
              color: tokens.color.ink,
              lineHeight: 1,
            }}
          >
            Signal Feed
          </h1>
          <div style={{ fontFamily: tokens.font.body, fontSize: 13, color: tokens.color.ink3 }}>
            Ack / dismiss / forward / feedback — last 50
          </div>
        </div>

        {/* Summary chips */}
        <div style={{ display: "flex", gap: 8, marginBottom: 20, flexWrap: "wrap" }}>
          {(["ack", "dismiss", "forward", "feedback"] as const).map((signal) => (
            <div
              key={signal}
              style={{
                padding: "4px 12px",
                borderRadius: tokens.radius.pill,
                background: SIGNAL_COLORS[signal] ?? tokens.color.paper,
                color: signal === "ack" || signal === "forward" || signal === "feedback"
                  ? tokens.color.ink
                  : "#fff",
                fontFamily: tokens.font.mono,
                fontSize: 11,
                fontWeight: 600,
              }}
            >
              {signal} {counts[signal] ?? 0}
            </div>
          ))}
        </div>

        {entries.length === 0 ? (
          <div
            style={{
              padding: 24,
              textAlign: "center",
              fontFamily: tokens.font.mono,
              fontSize: 12,
              color: tokens.color.ink3,
              border: `1px dashed ${tokens.color.edge}`,
              borderRadius: tokens.radius.md,
            }}
          >
            No preference signals yet — interact with critiques to build history.
          </div>
        ) : (
          <div>
            {/* Column headers */}
            <div
              style={{
                display: "grid",
                gridTemplateColumns: "80px 80px 140px 1fr",
                gap: 8,
                padding: "4px 0",
                borderBottom: `1px solid ${tokens.color.edge}`,
                fontFamily: tokens.font.mono,
                fontSize: 10,
                color: tokens.color.ink3,
                letterSpacing: "0.06em",
                textTransform: "uppercase",
              }}
            >
              <span>Time</span>
              <span>Signal</span>
              <span>Critique</span>
              <span>Reason</span>
            </div>
            {entries.map((entry, i) => (
              <div
                key={`${entry.ts}-${i}`}
                style={{
                  display: "grid",
                  gridTemplateColumns: "80px 80px 140px 1fr",
                  gap: 8,
                  padding: "6px 0",
                  borderBottom: `1px solid ${tokens.color.paperD}`,
                  alignItems: "start",
                }}
              >
                <span
                  style={{
                    fontFamily: tokens.font.mono,
                    fontSize: 11,
                    color: tokens.color.ink3,
                  }}
                >
                  {relativeTs(entry.ts)}
                </span>
                <span
                  style={{
                    display: "inline-block",
                    padding: "1px 8px",
                    borderRadius: tokens.radius.pill,
                    background: SIGNAL_COLORS[entry.signal] ?? tokens.color.paper,
                    color: entry.signal === "ack" || entry.signal === "forward" || entry.signal === "feedback"
                      ? tokens.color.ink
                      : "#fff",
                    fontFamily: tokens.font.mono,
                    fontSize: 10,
                    fontWeight: 600,
                    width: "fit-content",
                  }}
                >
                  {entry.signal}
                </span>
                <a
                  href={`/critique/${entry.critique_id}`}
                  style={{
                    fontFamily: tokens.font.mono,
                    fontSize: 11,
                    color: tokens.color.sky,
                    textDecoration: "none",
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    whiteSpace: "nowrap",
                    display: "block",
                  }}
                >
                  {entry.critique_id}
                </a>
                <span
                  style={{
                    fontFamily: tokens.font.body,
                    fontSize: 12,
                    color: tokens.color.ink2,
                  }}
                >
                  {entry.reason_text
                    ? entry.reason_text.slice(0, 100)
                    : "—"}
                </span>
              </div>
            ))}
          </div>
        )}
      </div>
    </Dashboard>
  );
}
