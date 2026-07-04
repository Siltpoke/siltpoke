// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
// Copyright (c) 2026 Jiaqi Duan
/** @jsxImportSource hono/jsx */
import type { PropsWithChildren } from "hono/jsx";
import type { CSSProperties } from "hono/jsx";
import { tokens } from "../tokens/tokens";

export interface PillProps {
  color?: string;
  bg?: string;
  border?: string;
  style?: CSSProperties;
}

export function Pill(props: PropsWithChildren<PillProps>) {
  const {
    children,
    color = tokens.color.ink,
    bg = "transparent",
    border = tokens.color.edge,
    style,
  } = props;
  return (
    <span
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 4,
        padding: "2px 7px",
        borderRadius: 999,
        border: `1px solid ${border}`,
        background: bg,
        color,
        fontFamily: tokens.font.mono,
        fontSize: 10.5,
        fontWeight: 500,
        letterSpacing: 0.2,
        ...style,
      }}
    >
      {children}
    </span>
  );
}
