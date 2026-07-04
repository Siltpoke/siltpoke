// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
// Copyright (c) 2026 Jiaqi Duan
/** @jsxImportSource hono/jsx */
/**
 * VitalsPanel.
 *
 * 2x2 mini-sparkline grid: mood / hunger / energy / bond.
 * Each tile shows a label, current display value (right-aligned),
 * and a filled-area sparkline (full tile width, ~50px tall).
 *
 * Header: "VITALS" left + "last 7d" right-aligned ink3 mono 10px.
 */
import { tokens } from "../tokens/tokens";
import { sparkline } from "../charts/sparkline";

export interface VitalsData {
  mood: number[];
  hunger: number[];
  energy: number[];
  bond: number[];
}

export interface VitalsValues {
  mood: string;
  hunger: string;
  energy: string;
  bond: string;
}

export interface VitalsPanelProps {
  vitals: VitalsData;
  values: VitalsValues;
}

interface TileSpec {
  key: keyof VitalsData;
  label: string;
  stroke: string;
  fill: string;
}

const TILES: readonly TileSpec[] = [
  { key: "mood",   label: "mood",   stroke: tokens.color.terra, fill: `${tokens.color.terra}33` },
  { key: "hunger", label: "hunger", stroke: tokens.color.amber, fill: `${tokens.color.amber}33` },
  { key: "energy", label: "energy", stroke: tokens.color.moss,  fill: `${tokens.color.moss}33`  },
  { key: "bond",   label: "bond",   stroke: tokens.color.sky,   fill: `${tokens.color.sky}33`   },
];

export function VitalsPanel(props: VitalsPanelProps) {
  const { vitals, values } = props;
  return (
    <div
      class="vitals-panel"
      style={{
        border: `1px solid ${tokens.color.edge}`,
        borderRadius: tokens.radius.sm,
        background: tokens.color.paper,
        padding: "10px 12px",
        display: "flex",
        flexDirection: "column",
        gap: 10,
      }}
    >
      {/* Header */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
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
          VITALS
        </span>
        <span
          style={{
            fontFamily: tokens.font.mono,
            fontSize: 10,
            color: tokens.color.ink3,
          }}
        >
          last 7d
        </span>
      </div>

      {/* 2x2 grid */}
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "1fr 1fr",
          gap: 8,
        }}
      >
        {TILES.map((tile) => {
          const series = vitals[tile.key];
          const displayValue = values[tile.key];
          return (
            <div
              key={tile.key}
              class="vitals-tile"
              data-vital={tile.key}
              style={{
                border: `1px solid ${tokens.color.edge}`,
                borderRadius: tokens.radius.sm,
                overflow: "hidden",
                background: tokens.color.cream,
              }}
            >
              {/* Tile header: label + value */}
              <div
                style={{
                  display: "flex",
                  justifyContent: "space-between",
                  alignItems: "center",
                  padding: "4px 6px",
                }}
              >
                <span
                  style={{
                    fontFamily: tokens.font.mono,
                    fontSize: 10,
                    color: tokens.color.ink3,
                  }}
                >
                  {tile.label}
                </span>
                <span
                  style={{
                    fontFamily: tokens.font.mono,
                    fontSize: 10,
                    color: tokens.color.ink2,
                    fontWeight: 500,
                  }}
                >
                  {displayValue}
                </span>
              </div>
              {/* Sparkline: full tile width */}
              <div style={{ color: tile.stroke, lineHeight: 0 }}>
                {sparkline(series, {
                  width: 120,
                  height: 50,
                  stroke: tile.stroke,
                  fill: tile.fill,
                  ariaLabel: `${tile.label} last 7 days`,
                })}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
