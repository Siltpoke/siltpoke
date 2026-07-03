// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Copyright (c) 2026 Jiaqi Duan
/** @jsxImportSource hono/jsx */
import type { Child } from "hono/jsx";
import { tokens } from "../tokens/tokens";

export interface SectionLabelProps {
  children: Child;
  xShow?: string;
}

/**
 * SectionLabel — muted uppercase group header for sectioned sidebar nav.
 *
 * Renders a compact uppercase label that visually separates nav sections
 * (e.g. "PET" / "WORK"). Hidden when the sidebar is collapsed via Alpine
 * x-show so only entry icons remain visible at 52px sidebar width.
 *
 * Typography: 10px mono, 500 weight, ~0.08em letter-spacing, ink3 muted color.
 * Kept separate from SectionHead which serves a distinct, larger display purpose.
 */
export function SectionLabel({ children, xShow }: SectionLabelProps) {
  return (
    <div
      {...(xShow !== undefined ? { "x-show": xShow } : {})}
      style={{
        fontFamily: tokens.font.mono,
        fontSize: 10,
        fontWeight: 500,
        letterSpacing: "0.08em",
        color: tokens.color.ink3,
        textTransform: "uppercase",
        padding: "8px 4px 2px",
      }}
    >
      {children}
    </div>
  );
}
