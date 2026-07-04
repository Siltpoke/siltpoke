// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
// Copyright (c) 2026 Jiaqi Duan
/**
 * Canonical design tokens.
 *
 * Single source of truth for colors / fonts / spacing / radius / shadows
 * referenced by both:
 *   - JSX SSR (`style={{ background: tokens.color.cream }}`)
 *   - The generated `tokens.css` file (CSS custom properties on `:root`),
 *     produced by `scripts/build-tokens.ts`.
 *
 * Adding a new token:
 *   1. Add to the const map below.
 *   2. Run `bun scripts/build-tokens.ts` (auto-runs on daemon start).
 *   3. The CSS var is automatically exposed as `--<category>-<key>`.
 */
export const tokens = {
  color: {
    cream: "#faf6ec",
    paper: "#f4eedf",
    paperD: "#e8dec7",
    edge: "#d8cbab",
    ink: "#1f1b16",
    ink2: "#5a4f3f",
    ink3: "#8a7c64",
    terra: "#d96b6b",
    amber: "#e8a85c",
    moss: "#7a9a5e",
    sky: "#7fb0c8",
    violet: "#9d86c2",
    lcd: "#b8c2a4",
    lcdInk: "#2a3a26",
    egg: "#f6c8c8",
    egg2: "#e89c9c",
  },
  font: {
    display: '"Pixelify Sans", system-ui, sans-serif',
    mono: '"JetBrains Mono", ui-monospace, monospace',
    body: '"Geist", system-ui, sans-serif',
  },
  space: {
    "1": "4px",
    "1_5": "6px",
    "2": "8px",
    "3": "12px",
    "3_5": "14px",
    "4": "16px",
    "4_5": "18px",
    "5": "22px",
    "6": "24px",
  },
  radius: {
    sm: "4px",
    md: "8px",
    lg: "14px",
    pill: "999px",
  },
  shadow: {
    sm: "0 1px 2px rgba(31,27,22,0.06)",
    md: "0 2px 6px rgba(31,27,22,0.10)",
    lg: "0 8px 24px rgba(31,27,22,0.14)",
  },
} as const;

export type Tokens = typeof tokens;
export type ColorToken = keyof typeof tokens.color;
export type FontToken = keyof typeof tokens.font;
export type SpaceToken = keyof typeof tokens.space;
export type RadiusToken = keyof typeof tokens.radius;
export type ShadowToken = keyof typeof tokens.shadow;

/**
 * Render the tokens as a CSS custom-property block keyed by `--<cat>-<key>`.
 * Used by `scripts/build-tokens.ts` to emit `tokens.css`.
 */
export function tokensToCss(): string {
  const lines: string[] = [":root {"];
  for (const [cat, kv] of Object.entries(tokens) as [
    keyof Tokens,
    Record<string, string>,
  ][]) {
    for (const [key, value] of Object.entries(kv)) {
      lines.push(`  --${cat}-${key}: ${value};`);
    }
  }
  lines.push("}");
  return `${lines.join("\n")}\n`;
}
