// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Copyright (c) 2026 Jiaqi Duan
/** @jsxImportSource hono/jsx */
import { tokens } from "../tokens/tokens";

/**
 * Icon — inline SVG icons for sidebar nav + chip glyphs.
 *
 * 16×16 viewBox, 1.5px stroke, `currentColor` — color is inherited from the
 * parent so the same icon renders ink3 (idle) / ink (active) / terra (alert)
 * via CSS color. Stroke-based line art matches the retro pixel-mono palette.
 *
 * Unknown names fall through to the raw string (back-compat for previews
 * that still pass emoji glyphs).
 */

export type IconName =
  | "home"
  | "stats"
  | "critic"
  | "history"
  | "traces"
  | "memory"
  | "explain"
  | "repo-graph"
  | "chat"
;

const PATHS: Record<IconName, string> = {
  // House outline
  home: "M2 8 L8 2 L14 8 M4 7 L4 14 L12 14 L12 7 M6.5 14 L6.5 10 L9.5 10 L9.5 14",
  // Bar chart — 3 ascending bars
  stats: "M3 13 L3 9 M3 13 L3 13 M7 13 L7 6 M11 13 L11 3 M2 14 L14 14",
  // 2×2 grid
  // 2 person silhouettes (heads + shoulders)
  // Warning triangle w/ exclamation
  critic: "M8 2 L14 13 L2 13 Z M8 6 L8 10 M8 11.5 L8 12",
  // Clock face — circular outline + 12-o'clock + 4-o'clock hands.
  // Reads as "history / time series" without being literal numerals.
  history: "M8 1.5 A6.5 6.5 0 1 0 8 14.5 A6.5 6.5 0 1 0 8 1.5 M8 4 L8 8 L11 10",
  // Trace waterfall — three stacked horizontal bars of varying widths,
  // visually echoing the /traces phase-timing chart.
  traces: "M3 3 L12 3 L12 5 L3 5 Z M3 7 L14 7 L14 9 L3 9 Z M3 11 L8 11 L8 13 L3 13 Z",
  // Database cylinder (memory)
  memory: "M3 4 C3 2.5 5.5 2 8 2 C10.5 2 13 2.5 13 4 L13 12 C13 13.5 10.5 14 8 14 C5.5 14 3 13.5 3 12 Z M3 4 C3 5.5 5.5 6 8 6 C10.5 6 13 5.5 13 4 M3 8 C3 9.5 5.5 10 8 10 C10.5 10 13 9.5 13 8",
  // Lightbulb (matches CLI 💡 hint for /siltpoke-explain).
  // Bulb outline + 3 filament lines below.
  explain: "M5 6.5 A3 3 0 0 1 11 6.5 C11 8.5 10 9.5 10 11 L6 11 C6 9.5 5 8.5 5 6.5 Z M6.5 12.5 L9.5 12.5 M7 14 L9 14",
  // Node-link triangle — 3 small circles connected by edges,
  // matches the C4 architecture view's mental model.
  "repo-graph": "M7 3 A1 1 0 1 0 9 3 A1 1 0 1 0 7 3 M2 12 A1 1 0 1 0 4 12 A1 1 0 1 0 2 12 M12 12 A1 1 0 1 0 14 12 A1 1 0 1 0 12 12 M8 4 L4 11 M8 4 L12 11 M4 12 L12 12",
  // Speech bubble
  chat: "M2 4 L14 4 L14 11 L9 11 L6 14 L6 11 L2 11 Z",
  // Terminal prompt ›_
  // Gear
  // Question mark in circle
};

const KNOWN = new Set(Object.keys(PATHS));

export interface IconProps {
  /** Icon name (registry key) OR a raw glyph string for back-compat. */
  name: string;
  /** Display size in px (square). Default 16. */
  size?: number;
  /** ARIA-hidden when true (when the icon is decorative beside a label). Default true. */
  decorative?: boolean;
  /** Accessible label when not decorative. */
  ariaLabel?: string;
}

export function Icon(props: IconProps) {
  const { name, size = 16, decorative = true, ariaLabel } = props;

  if (!KNOWN.has(name)) {
    // Back-compat fallback: render the raw string (emoji / single char).
    return (
      <span
        aria-hidden={decorative ? "true" : undefined}
        aria-label={!decorative ? ariaLabel : undefined}
        style={{
          fontFamily: tokens.font.display,
          fontSize: 18,
          width: size,
          textAlign: "center",
          flexShrink: 0,
          display: "inline-block",
          lineHeight: 1,
        }}
      >
        {name}
      </span>
    );
  }

  const d = PATHS[name as IconName];
  return (
    <svg
      class={`icon icon--${name}`}
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      stroke-width="1.5"
      stroke-linecap="round"
      stroke-linejoin="round"
      aria-hidden={decorative ? "true" : undefined}
      aria-label={!decorative ? ariaLabel : undefined}
      role={!decorative ? "img" : undefined}
      style={{ flexShrink: 0, display: "inline-block" }}
    >
      <path d={d} />
    </svg>
  );
}
