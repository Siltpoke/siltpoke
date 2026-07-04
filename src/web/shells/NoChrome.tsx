// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
// Copyright (c) 2026 Jiaqi Duan
/** @jsxImportSource hono/jsx */
import type { Child } from "hono/jsx";
import { tokens } from "../tokens/tokens";

export interface NoChromeProps {
  children: Child;
  pad?: number;
  align?: "start" | "center";
}

export function NoChrome(props: NoChromeProps) {
  const { children, pad = 0, align = "start" } = props;

  return (
    <div
      style={{
        height: "100%",
        background: tokens.color.cream,
        display: "flex",
        flexDirection: "column",
        alignItems: align === "center" ? "center" : "stretch",
        justifyContent: align === "center" ? "center" : "flex-start",
        padding: pad,
      }}
    >
      {children}
    </div>
  );
}
