// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
// Copyright (c) 2026 Jiaqi Duan
/** @jsxImportSource hono/jsx */
import type { Child } from "hono/jsx";
import { tokens } from "../tokens/tokens";

export interface EmptyPlaceholderProps {
  art?: Child;
  headline: string;
  sub: string;
  action?: Child;
}

export function EmptyPlaceholder(props: EmptyPlaceholderProps) {
  const { art, headline, sub, action } = props;

  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        padding: 18,
        gap: 10,
      }}
    >
      {art}
      <div
        style={{
          fontFamily: tokens.font.display,
          fontSize: 14,
          fontWeight: 600,
          color: tokens.color.ink,
          textAlign: "center",
        }}
      >
        {headline}
      </div>
      <div
        style={{
          fontFamily: tokens.font.body,
          fontSize: 11,
          color: tokens.color.ink2,
          textAlign: "center",
          lineHeight: 1.4,
        }}
      >
        {sub}
      </div>
      {action}
    </div>
  );
}
