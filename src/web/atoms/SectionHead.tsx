// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Copyright (c) 2026 Jiaqi Duan
/** @jsxImportSource hono/jsx */
import type { CSSProperties } from "hono/jsx";
import { tokens } from "../tokens/tokens";

export interface SectionHeadProps {
  title: string;
  sub?: string;
  kicker?: string;
  style?: CSSProperties;
}

export function SectionHead(props: SectionHeadProps) {
  const { title, sub, kicker, style } = props;
  return (
    <div style={style}>
      {kicker && (
        <div
          style={{
            fontFamily: tokens.font.mono,
            fontSize: 11,
            letterSpacing: 1.4,
            color: tokens.color.ink3,
            textTransform: "uppercase",
            marginBottom: 6,
          }}
        >
          {kicker}
        </div>
      )}
      <div
        style={{
          fontFamily: tokens.font.display,
          fontSize: 26,
          fontWeight: 600,
          color: tokens.color.ink,
          lineHeight: 1.05,
          letterSpacing: -0.3,
        }}
      >
        {title}
      </div>
      {sub && (
        <div
          style={{
            fontSize: 13,
            color: tokens.color.ink2,
            marginTop: 6,
          }}
        >
          {sub}
        </div>
      )}
    </div>
  );
}
