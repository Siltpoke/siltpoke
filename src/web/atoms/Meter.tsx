// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Copyright (c) 2026 Jiaqi Duan
/** @jsxImportSource hono/jsx */
import { tokens } from "../tokens/tokens";

export interface MeterProps {
  value: number;
  max?: number;
  color?: string;
  track?: string;
  gap?: number;
  segH?: number;
  segW?: number;
}

export function Meter(props: MeterProps) {
  const {
    value,
    max = 10,
    color = tokens.color.terra,
    track = tokens.color.paperD,
    gap = 2,
    segH = 10,
    segW = 10,
  } = props;
  return (
    <div style={{ display: "flex", gap }}>
      {Array.from({ length: max }, (_, i) => (
        <i
          key={i}
          style={{
            width: segW,
            height: segH,
            background: i < value ? color : track,
            borderRadius: 1,
          }}
        />
      ))}
    </div>
  );
}
