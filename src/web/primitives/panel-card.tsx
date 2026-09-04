// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
// Copyright (c) 2026 Jiaqi Duan
/** @jsxImportSource hono/jsx */
/**
 * Shared "sidebar panel" chrome: the bordered/padded card + the uppercase
 * eyebrow header row (label left, arbitrary content right). Several
 * dashboard panels (StatsPanel, FewShotPanel, ...) each repeated this exact
 * border/radius/padding container and header-row shape — extracted here so
 * they only supply their own body content and header-right slot.
 *
 * `panelCardStyle` deliberately omits `gap` — panels use slightly different
 * internal spacing (6px vs 8px), so callers spread this and add their own.
 */
import { tokens } from "../tokens/tokens";

export const panelCardStyle = {
  border: `1px solid ${tokens.color.edge}`,
  borderRadius: tokens.radius.sm,
  background: tokens.color.paper,
  padding: "10px 12px",
  display: "flex",
  flexDirection: "column",
} as const;

export const panelEyebrowStyle = {
  fontFamily: tokens.font.mono,
  fontSize: 10,
  color: tokens.color.ink3,
  letterSpacing: "0.08em",
  textTransform: "uppercase",
  fontWeight: 500,
} as const;

export function PanelHeader({
  label,
  right,
}: {
  label: string;
  right?: import("hono/jsx").Child;
}) {
  return (
    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
      <span style={panelEyebrowStyle}>{label}</span>
      {right}
    </div>
  );
}
