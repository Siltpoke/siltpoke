// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Copyright (c) 2026 Jiaqi Duan
/** @jsxImportSource hono/jsx */
/**
 * ViewToggle atom.
 *
 * Segmented control switching between `dashboard` and `toy` Home views.
 * Each pill is a real <a> link with a configurable href so the parent
 * route can swap the URL query (e.g. `?view=dashboard` / `?view=toy`).
 * Active state is purely SSR — no Alpine; URL drives state.
 */
import { tokens } from "../tokens/tokens";

export interface ViewToggleProps {
  active: "dashboard" | "toy";
  /** Link target when clicking dashboard pill. Default `?view=dashboard`. */
  dashboardHref?: string;
  /** Link target when clicking toy pill. Default `?view=toy`. */
  toyHref?: string;
}

export function ViewToggle({
  active,
  dashboardHref = "?view=dashboard",
  toyHref = "?view=toy",
}: ViewToggleProps) {
  const dashActive = active === "dashboard";
  const toyActive = active === "toy";

  const activeSegment = {
    background: tokens.color.ink,
    color: tokens.color.cream,
    border: `1px solid ${tokens.color.ink}`,
    borderRadius: tokens.radius.pill,
    fontFamily: tokens.font.mono,
    fontSize: 10,
    padding: "2px 8px",
    cursor: "pointer",
    textDecoration: "none",
  } as const;

  const inactiveSegment = {
    background: tokens.color.cream,
    color: tokens.color.ink2,
    border: `1px solid ${tokens.color.edge}`,
    borderRadius: tokens.radius.pill,
    fontFamily: tokens.font.mono,
    fontSize: 10,
    padding: "2px 8px",
    cursor: "pointer",
    textDecoration: "none",
  } as const;

  return (
    <div
      class="view-toggle"
      data-active={active}
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 4,
      }}
    >
      <span
        style={{
          fontFamily: tokens.font.mono,
          fontSize: 10,
          color: tokens.color.ink3,
          letterSpacing: "0.06em",
          textTransform: "uppercase",
          marginRight: 4,
        }}
      >
        view
      </span>
      <a
        class="view-toggle__dashboard"
        href={dashboardHref}
        style={dashActive ? activeSegment : inactiveSegment}
      >
        dashboard
      </a>
      <a
        class="view-toggle__toy"
        href={toyHref}
        style={toyActive ? activeSegment : inactiveSegment}
      >
        toy
      </a>
    </div>
  );
}
