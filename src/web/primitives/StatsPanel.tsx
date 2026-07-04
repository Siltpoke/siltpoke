// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
// Copyright (c) 2026 Jiaqi Duan
/** @jsxImportSource hono/jsx */
/**
 * StatsPanel primitive.
 *
 * Renders 5 stat meter rows (hp / hunger / energy / mood / bond), each
 * with a 10-block pixel meter bar, plus an XP progress bar below.
 *
 * Each stat is 0–10. Meter fill is proportional: Math.round(value) filled
 * blocks, remainder grayed.
 */
import { tokens } from "../tokens/tokens";

export interface StatsPanelStats {
  hp: number;
  hunger: number;
  energy: number;
  mood: number;
  bond: number;
}

export interface StatsPanelXp {
  level: number;
  nextLevel: number;
  xp: number;
  xpToNext: number;
  /** Action XP awarded today, read from the awarded ledger (never exceeds the daily cap). */
  xpToday: number;
  /** True when the daily action-XP cap is reached — badge shows the capped suffix. */
  xpTodayCapped: boolean;
}

export interface StatsPanelProps {
  /** Real hp/hunger/energy/mood/bond stats — always present. */
  stats: StatsPanelStats;
  xp: StatsPanelXp;
}

interface StatRow {
  key: keyof StatsPanelStats;
  icon: string;
  label: string;
  color: string;
}

const STAT_ROWS: readonly StatRow[] = [
  { key: "hp",     icon: "♥", label: "hp",     color: tokens.color.terra },
  { key: "hunger", icon: "⊙", label: "hunger", color: tokens.color.amber },
  { key: "energy", icon: "✦", label: "energy", color: tokens.color.moss  },
  { key: "mood",   icon: "✱", label: "mood",   color: tokens.color.terra },
  { key: "bond",   icon: "◆", label: "bond",   color: tokens.color.sky   },
];

const METER_BLOCKS = 10;

/**
 * Stat values decay as floats. Meter shows whole blocks via Math.round, so
 * the numeric label rounds to the same integer for visual consistency.
 */
function formatStat(n: number): string {
  return `${Math.round(n)}`;
}

function MeterBar({ value, color }: { value: number; color: string }) {
  const filled = Math.max(0, Math.min(METER_BLOCKS, Math.round(value)));
  return (
    <div
      style={{
        display: "flex",
        gap: 2,
        alignItems: "center",
      }}
    >
      {Array.from({ length: METER_BLOCKS }, (_, i) => (
        <div
          key={i}
          style={{
            width: 8,
            height: 8,
            borderRadius: 1,
            background: i < filled ? color : tokens.color.edge,
            flexShrink: 0,
          }}
        />
      ))}
    </div>
  );
}

export function StatsPanel(props: StatsPanelProps) {
  const { stats, xp } = props;
  const xpFraction = xp.xpToNext > 0 ? Math.min(1, xp.xp / xp.xpToNext) : 0;
  const xpPercent = Math.round(xpFraction * 100);

  return (
    <div
      class="stats-panel"
      style={{
        border: `1px solid ${tokens.color.edge}`,
        borderRadius: tokens.radius.sm,
        background: tokens.color.paper,
        padding: "10px 12px",
        display: "flex",
        flexDirection: "column",
        gap: 8,
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
          STATS
        </span>
        <span
          class="stats-panel__now"
          style={{
            fontFamily: tokens.font.mono,
            fontSize: 10,
            color: tokens.color.ink3,
          }}
        >
          now
        </span>
      </div>

      {/* XP bar — moved above stat rows so level progress is the first thing
          the eye lands on after the STATS header. */}
      <div
        class="stats-panel__xp"
        style={{
          display: "flex",
          flexDirection: "column",
          gap: 3,
          paddingBottom: 8,
          borderBottom: `1px solid ${tokens.color.edge}`,
        }}
      >
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
            }}
          >
            {`XP · L${xp.level} → L${xp.nextLevel}`}
          </span>
          {xp.xpToday > 0 && (
            <span
              class="stats-panel__xp-today"
              style={{
                fontFamily: tokens.font.mono,
                fontSize: 11,
                color: tokens.color.terra,
              }}
            >
              {`+${xp.xpToday} today${xp.xpTodayCapped ? " · capped" : ""}`}
            </span>
          )}
        </div>
        <div
          style={{
            height: 6,
            background: tokens.color.edge,
            borderRadius: tokens.radius.sm,
            overflow: "hidden",
          }}
        >
          <div
            style={{
              height: "100%",
              width: `${xpPercent}%`,
              background: tokens.color.terra,
              borderRadius: tokens.radius.sm,
            }}
          />
        </div>
        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            fontFamily: tokens.font.mono,
            fontSize: 10,
            color: tokens.color.ink3,
          }}
        >
          <span>{xp.xp.toLocaleString()} / {xp.xpToNext.toLocaleString()}</span>
          <span>{(xp.xpToNext - xp.xp).toLocaleString()} to go</span>
        </div>
      </div>

      {/* Stat rows — always rendered (stats is always present) */}
      {STAT_ROWS.map((row) => {
        const val = Math.max(0, Math.min(10, stats[row.key]));
        return (
          <div
            key={row.key}
            class="stats-panel__row"
            data-stat={row.key}
            style={{
              display: "flex",
              alignItems: "center",
              gap: 6,
            }}
          >
            <span
              style={{
                fontFamily: tokens.font.mono,
                fontSize: 11,
                color: row.color,
                width: 14,
                textAlign: "center",
                flexShrink: 0,
              }}
            >
              {row.icon}
            </span>
            <span
              style={{
                fontFamily: tokens.font.mono,
                fontSize: 11,
                color: tokens.color.ink3,
                width: 40,
                flexShrink: 0,
              }}
            >
              {row.label}
            </span>
            <MeterBar value={val} color={row.color} />
            <span
              style={{
                fontFamily: tokens.font.mono,
                fontSize: 10,
                color: tokens.color.ink3,
                marginLeft: "auto",
                flexShrink: 0,
              }}
            >
              {formatStat(val)}/10
            </span>
          </div>
        );
      })}
    </div>
  );
}
