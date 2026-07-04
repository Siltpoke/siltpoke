// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
// Copyright (c) 2026 Jiaqi Duan
/** @jsxImportSource hono/jsx */
/**
 * Shared sub-primitives used by every CritiqueAuditBlock (A–F).
 * Extracted from the original CritiqueAuditBlocks.tsx.
 */
import { tokens } from "../../tokens/tokens";

export const V2_MISSING_NOTE =
  "v2 audit data unavailable — this critique pre-dates pipeline wire OR ran on legacy path.";

export const TIER_LABEL: Record<number, string> = {
  1: "Tier 1 · deterministic",
  2: "Tier 2 · heuristic AST",
  3: "Tier 3 · semantic (not yet implemented)",
};

export function AuditSectionHead({ label, note }: { label: string; note?: string }) {
  return (
    <div
      style={{
        paddingBottom: 6,
        borderBottom: `1px dashed ${tokens.color.edge}`,
        display: "flex",
        justifyContent: "space-between",
        alignItems: "baseline",
      }}
    >
      <span
        style={{
          fontFamily: tokens.font.mono,
          fontSize: 10,
          letterSpacing: "0.08em",
          textTransform: "uppercase",
          color: tokens.color.ink2,
          fontWeight: 600,
        }}
      >
        {label}
      </span>
      {note && (
        <span
          style={{
            fontFamily: tokens.font.mono,
            fontSize: 9,
            color: tokens.color.ink3,
          }}
        >
          {note}
        </span>
      )}
    </div>
  );
}

export function AuditSection({
  id,
  label,
  note,
  children,
}: {
  id: string;
  label: string;
  note?: string;
  children: import("hono/jsx").Child;
}) {
  return (
    <div
      data-audit-block={id}
      style={{ display: "flex", flexDirection: "column", gap: 10, paddingTop: 10 }}
    >
      <AuditSectionHead label={label} note={note} />
      {children}
    </div>
  );
}

export function PlaceholderNote({ text }: { text: string }) {
  return (
    <div
      style={{
        fontFamily: tokens.font.body,
        fontSize: 11,
        color: tokens.color.ink3,
        fontStyle: "italic",
        lineHeight: 1.55,
      }}
    >
      {text}
    </div>
  );
}

export function MonoBlock({ children }: { children: import("hono/jsx").Child }) {
  return (
    <pre
      style={{
        fontFamily: tokens.font.mono,
        fontSize: 10,
        color: tokens.color.ink2,
        background: tokens.color.paper,
        border: `1px solid ${tokens.color.edge}`,
        borderRadius: tokens.radius.sm,
        padding: "6px 10px",
        margin: 0,
        whiteSpace: "pre-wrap",
        wordBreak: "break-word",
        lineHeight: 1.55,
      }}
    >
      {children}
    </pre>
  );
}
