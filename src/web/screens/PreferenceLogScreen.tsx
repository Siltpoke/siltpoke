// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
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

/**
 * Each signal's fill AND its dedicated text-on-fill token, kept in ONE
 * table (not two parallel maps) for the same reason `signalChipColors`
 * below derives foreground from background instead of two independent
 * expressions — see that function's docstring.
 */
const SIGNAL_CHIP: Record<string, { background: string; color: string }> = {
  ack: { background: tokens.color.moss, color: tokens.color.onMoss },
  dismiss: { background: tokens.color.terra, color: tokens.color.onTerra },
  forward: { background: tokens.color.sky, color: tokens.color.onSky },
  feedback: { background: tokens.color.amber, color: tokens.color.onAmber },
};

/**
 * Chip background + foreground for one signal, derived TOGETHER.
 *
 * They used to be two independent expressions: the background fell back to
 * `paper` for an unknown signal, while the foreground ternary's else-arm still
 * returned `onAccent`. That pairing is `#151515` on `#1e1e1e` in dark — a
 * contrast of 1.06, i.e. invisible — and it is reachable: `signal` is typed as
 * a closed union but `src/preference-log/reader.ts` builds entries with an
 * unchecked `JSON.parse(line) as PreferenceLogEntry` over on-disk JSONL, so
 * any string in the file lands here. Deriving the foreground FROM the resolved
 * background makes the pair impossible to get wrong, including for whatever
 * fifth signal gets added later.
 *
 * FIXED (Task 10, decided item 2): `ink` on the three light accents scored
 * 1.66 (moss) / 1.83 (sky) / 1.56 (amber) in DARK against the 4.5:1 text
 * floor — the Task 7 review finding (its own quoted figures, 1.66/1.85/1.57,
 * were rounded slightly differently; recomputed here from the live palette,
 * matching RubricList.tsx's docstring for the same three accents). `dismiss`
 * (terra) used `onAccent` instead, which happened to clear dark (7.01:1) but
 * silently failed LIGHT (3.35:1, white-on-terra) — the same "white in light,
 * where these fills are also light" trap `onAccent` isn't safe for as a
 * drop-in. All four now use their dedicated per-accent `onX` token
 * (SIGNAL_CHIP above), each gated >=4.5:1 against its own accent, in both
 * themes, by tests/web/tokens/palette.test.ts "per-accent ink tokens".
 */
function signalChipColors(signal: string): { background: string; color: string } {
  const chip = SIGNAL_CHIP[signal];
  if (chip === undefined) {
    // Unknown signal: a plain surface chip, so the ordinary body color applies.
    return { background: tokens.color.paper, color: tokens.color.ink };
  }
  return chip;
}

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
                ...signalChipColors(signal),
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
            No preference signals yet — interact with reviews to build history.
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
              <span>Review</span>
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
                    ...signalChipColors(entry.signal),
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
