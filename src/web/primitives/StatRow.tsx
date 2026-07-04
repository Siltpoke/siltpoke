// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
// Copyright (c) 2026 Jiaqi Duan
/** @jsxImportSource hono/jsx */
import { tokens } from "../tokens/tokens";
import { Meter } from "../atoms/Meter";

export interface StatRowProps {
  icon?: string;
  label: string;
  value: number;
  max?: number;
  color?: string;
}

export function StatRow(props: StatRowProps) {
  const { icon, label, value, max = 10, color = tokens.color.terra } = props;

  return (
    <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
      {icon && (
        <span
          style={{
            width: 14,
            textAlign: "center",
            fontFamily: tokens.font.display,
            fontSize: 14,
          }}
        >
          {icon}
        </span>
      )}
      <span
        style={{
          fontFamily: tokens.font.mono,
          fontSize: 11,
          color: tokens.color.ink2,
          width: 56,
        }}
      >
        {label}
      </span>
      <Meter value={value} max={max} color={color} segW={8} segH={8} />
      <span
        style={{
          fontFamily: tokens.font.mono,
          fontSize: 10.5,
          color: tokens.color.ink3,
          marginLeft: "auto",
        }}
      >
        {value}/{max}
      </span>
    </div>
  );
}
