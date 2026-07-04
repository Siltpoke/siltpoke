// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
// Copyright (c) 2026 Jiaqi Duan
/** @jsxImportSource hono/jsx */
import type { PropsWithChildren } from "hono/jsx";
import type { CSSProperties } from "hono/jsx";
import { tokens } from "../tokens/tokens";

export interface CardProps {
  pad?: number;
  style?: CSSProperties;
}

export function Card(props: PropsWithChildren<CardProps>) {
  const { children, pad = 16, style } = props;
  return (
    <div
      style={{
        background: tokens.color.paper,
        border: `1px solid ${tokens.color.edge}`,
        borderRadius: 10,
        padding: pad,
        ...style,
      }}
    >
      {children}
    </div>
  );
}
