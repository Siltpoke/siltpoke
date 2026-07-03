// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Copyright (c) 2026 Jiaqi Duan
/** @jsxImportSource hono/jsx */
import type { PropsWithChildren } from "hono/jsx";
import { tokens } from "../tokens/tokens";
import { Dot } from "./Dot";

export interface AppChromeProps {
  title?: string;
  subtitle?: string;
  accent?: string;
}

export function AppChrome(props: PropsWithChildren<AppChromeProps>) {
  // Top "siltpoked · 127.0.0.1:9876 / connected" bar dropped.
  // Daemon identity + status now live in the sidebar footer (Dashboard).
  // AppChrome stays a thin container so existing call sites compile.
  // Unused props retained for back-compat with screens that still pass them.
  void props.title;
  void props.subtitle;
  void props.accent;
  void Dot;
  void tokens;
  return (
    <div
      style={{
        height: "100%",
        display: "flex",
        flexDirection: "column",
        background: tokens.color.cream,
      }}
    >
      <div style={{ flex: 1, minHeight: 0, overflow: "hidden" }}>
        {props.children}
      </div>
    </div>
  );
}
