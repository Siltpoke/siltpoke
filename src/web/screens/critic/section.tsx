// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Copyright (c) 2026 Jiaqi Duan
/** @jsxImportSource hono/jsx */
/**
 * Shared layout primitives for the critic page: Section + EmptySection.
 *
 * Extracted from src/web/screens/critic/recent-table.tsx to
 * kill the circular dependency:
 *   recent-table.tsx → recent-row.tsx → recent-table.tsx (Section + EmptySection)
 *   recent-table.tsx → recent-row.tsx → feedback-section.tsx → recent-table.tsx (Section)
 *
 * Both consumers now import these primitives from here, breaking the cycle.
 */
import { tokens } from "../../tokens/tokens";

export function EmptySection({ title, note }: { title: string; note: string }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 8, opacity: 0.7, paddingTop: 10 }}>
      <div style={{ paddingBottom: 6, borderBottom: `1px dashed ${tokens.color.edge}` }}>
        <span
          style={{
            fontFamily: tokens.font.mono,
            fontSize: 10,
            letterSpacing: "0.08em",
            textTransform: "uppercase",
            color: tokens.color.ink3,
            fontWeight: 600,
          }}
        >
          {title}
        </span>
      </div>
      <div
        style={{
          fontFamily: tokens.font.body,
          fontSize: 11,
          color: tokens.color.ink3,
          fontStyle: "italic",
          lineHeight: 1.55,
        }}
      >
        {note}
      </div>
    </div>
  );
}

export function Section({
  title,
  subtitle,
  accent,
  children,
}: {
  title: string;
  subtitle?: string;
  accent?: string;
  children: import("hono/jsx").Child;
}) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 10, paddingTop: 10 }}>
      <div style={{ paddingBottom: 6, borderBottom: `1px dashed ${tokens.color.edge}` }}>
        <span
          style={{
            fontFamily: tokens.font.mono,
            fontSize: 10,
            letterSpacing: "0.08em",
            textTransform: "uppercase",
            color: accent ?? tokens.color.ink2,
            fontWeight: 600,
          }}
        >
          {title}
        </span>
        {subtitle && (
          <span
            style={{
              fontFamily: tokens.font.mono,
              fontSize: 10,
              color: tokens.color.ink3,
              marginLeft: 6,
            }}
          >
            · {subtitle}
          </span>
        )}
      </div>
      {children}
    </div>
  );
}
