// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
// Copyright (c) 2026 Jiaqi Duan
/** @jsxImportSource hono/jsx */
/**
 * ActionChip atom.
 *
 * Renders a pixel-style HTMX action button. When clicked it POSTs to
 * /api/action, targets #hero for outerHTML swap, and uses Alpine to
 * surface a "busy" class while the request is in-flight.
 *
 * Notable details:
 *   - `keyCap` prop: renders a small darker key-cap pill to the right of label.
 *   - `tone` prop: drives per-action background color (feed=amber, play=moss,
 *     clean=sky, sleep=ink-dark). Derived from `action` when not provided.
 *   - `ActionType` union includes "tease" | "clean" | "sleep"
 *
 * Security surface: hx-vals is a JSON literal embedded in the HTML
 * attribute. Values are validated server-side in /api/action; the
 * client only passes the action name.
 */
import { tokens } from "../tokens/tokens";

export type ActionType = "feed" | "play" | "pet" | "tease" | "clean" | "sleep";

export type ActionTone = "amber" | "moss" | "sky" | "dark" | "terra" | "default";

/** Map each action to its default tone. */
const ACTION_TONE_MAP: Record<ActionType, ActionTone> = {
  feed: "amber",
  play: "moss",
  pet: "terra",
  tease: "default",
  clean: "sky",
  sleep: "dark",
};

interface ToneStyle {
  background: string;
  color: string;
  border: string;
}

function toneStyles(tone: ActionTone): ToneStyle {
  switch (tone) {
    case "amber":
      return {
        background: tokens.color.amber,
        color: tokens.color.cream,
        border: `1px solid ${tokens.color.amber}`,
      };
    case "moss":
      return {
        background: tokens.color.moss,
        color: tokens.color.cream,
        border: `1px solid ${tokens.color.moss}`,
      };
    case "sky":
      return {
        background: tokens.color.sky,
        color: tokens.color.cream,
        border: `1px solid ${tokens.color.sky}`,
      };
    case "dark":
      return {
        background: tokens.color.ink,
        color: tokens.color.cream,
        border: `1px solid ${tokens.color.ink}`,
      };
    case "terra":
      return {
        background: tokens.color.terra,
        color: tokens.color.cream,
        border: `1px solid ${tokens.color.terra}`,
      };
    default:
      return {
        background: tokens.color.paper,
        color: tokens.color.ink,
        border: `1px solid ${tokens.color.edge}`,
      };
  }
}

export interface ActionChipProps {
  action: ActionType;
  label: string;
  icon?: string;
  /**
   * Optional key-cap hint (e.g. "F" / "P" / "C" / "Z"). When provided,
   * renders a small darker pill to the right of the label text.
   */
  keyCap?: string;
  /**
   * Tone variant controlling background + border color.
   * When omitted, derived from the `action` value via ACTION_TONE_MAP.
   */
  tone?: ActionTone;
}

/**
 * Pixel-style action button wired for HTMX + Alpine busy state.
 *
 * HTMX attributes:
 *   hx-post="/api/action"   — POST on click
 *   hx-vals                 — JSON body `{"action":"<action>"}`
 *   hx-target="#hero"       — replace the hero section
 *   hx-swap="outerHTML"     — full section replacement
 *
 * Alpine x-data scopes `busy` to this element. The busy class is toggled
 * via htmx:before-request / htmx:after-request event listeners so the
 * chip visually dims while the network round-trip is pending.
 */
export function ActionChip(props: ActionChipProps) {
  const { action, label, icon, keyCap, tone } = props;
  const resolvedTone: ActionTone = tone ?? ACTION_TONE_MAP[action] ?? "default";
  const { background, color, border } = toneStyles(resolvedTone);

  return (
    <button
      class="action-chip"
      data-action={action}
      hx-post="/api/action"
      hx-vals={JSON.stringify({ action })}
      hx-target="#hero"
      hx-swap="outerHTML"
      x-data="{busy:false}"
      {...{
        "x-on:htmx:before-request": "busy=true",
        "x-on:htmx:after-request": "busy=false",
        ":class": "busy ? 'action-chip--busy' : ''",
      }}
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 8,
        padding: "8px 14px",
        background,
        color,
        border,
        borderRadius: 10,
        fontFamily: tokens.font.mono,
        fontSize: 13,
        fontWeight: 600,
        cursor: "pointer",
        userSelect: "none",
        // Outer drop shadow -> tokens.shadow.md (fix round 1: `md`'s own
        // "0 2px 6px …0.10" is closer than `sm`'s "0 1px 2px …0.06" on
        // BOTH offset and alpha to the original "0 2px 4px …0.12" — `sm`
        // visibly flattened this in light mode). Ink-colored but NOT
        // ink-derived — the ink-polarity rule: a box-shadow simulates
        // fixed physical depth, must stay near-black in both themes,
        // unlike a border/hover tint that should track ink/paper. The
        // inset bevel (offset-only, no blur) has no matching shadowPalette
        // geometry and is a fixed physical press-bevel, not page ink —
        // stays literal.
        boxShadow: `${tokens.shadow.md}, inset 0 -2px 0 rgba(0,0,0,0.10)`,
      }}
    >
      {icon && <span class="action-chip__icon">{icon}</span>}
      <span class="action-chip__label">{label}</span>
      {keyCap && (
        <span
          class="action-chip__keycap"
          style={{
            fontFamily: tokens.font.mono,
            fontSize: 10,
            fontWeight: 700,
            color: tokens.color.ink,
            background: tokens.color.cream,
            border: `1px solid rgba(0,0,0,0.12)`,
            borderRadius: 4,
            padding: "1px 6px",
            lineHeight: "14px",
            minWidth: 14,
            textAlign: "center",
            boxShadow: "inset 0 -1px 0 rgba(0,0,0,0.08)",
          }}
        >
          {keyCap}
        </span>
      )}
    </button>
  );
}
