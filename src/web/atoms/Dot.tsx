// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Copyright (c) 2026 Jiaqi Duan
/** @jsxImportSource hono/jsx */
import type { CSSProperties } from "hono/jsx";
import { tokens } from "../tokens/tokens";

export interface DotProps {
  color?: string;
  size?: number;
  style?: CSSProperties;
}

export function Dot(props: DotProps) {
  const { color = tokens.color.terra, size = 8, style } = props;
  return (
    <i
      style={{
        display: "inline-block",
        width: size,
        height: size,
        borderRadius: "50%",
        background: color,
        ...style,
      }}
    />
  );
}
