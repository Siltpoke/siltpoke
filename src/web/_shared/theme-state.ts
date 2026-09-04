// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
// Copyright (c) 2026 Jiaqi Duan
/**
 * The theme's shared vocabulary: the three states, the storage key, and the
 * glyph/label for each state.
 *
 * Deliberately PURE — no DOM, no listeners, no side effects — because both
 * sides need it and they run in different places:
 *
 *   - `src/web/shells/Dashboard.tsx` (SSR) renders the button's static
 *     `system` glyph and aria-label, so the control has an accessible name and
 *     visible content before the client bundle executes;
 *   - `src/web/client/islands/theme-toggle.ts` (browser) overwrites both on
 *     hydrate and owns everything stateful — reading/writing localStorage,
 *     stamping `data-theme`, and the document-level listeners.
 *
 * Keeping these here rather than importing them from the island is what stops
 * the SSR bundle pulling in a module whose top level registers window
 * listeners, and it is what stops the two sides drifting on the label text.
 */

export type ThemeState = "system" | "light" | "dark";

/**
 * localStorage key. Must match the pre-paint script — `THEME_BOOTSTRAP_SCRIPT`
 * in `theme-bootstrap.ts` (moved out of `layout.tsx` in 931b474f; it now
 * builds itself FROM this constant, see that file, so this is enforced by
 * construction rather than by comment alone).
 */
export const THEME_KEY = "siltpokeTheme";

/** Cycle order for the toggle: system -> light -> dark -> system. */
export const THEME_ORDER: readonly ThemeState[] = ["system", "light", "dark"] as const;

/**
 * Broadcast whenever the RESOLVED theme changes — a manual cycle, another tab
 * writing the key, or the OS flipping while we follow it. Consumers are values
 * JS reads once via `readColor()` and caches; CSS-driven colors need no event.
 */
export const THEME_CHANGED = "siltpoke:theme-changed";

/** Narrows an arbitrary stored value to a state. Anything unknown is `system`. */
export function normalizeTheme(value: string | null): ThemeState {
  return value === "light" || value === "dark" ? value : "system";
}

export function iconFor(state: ThemeState): string {
  return state === "light" ? "☀" : state === "dark" ? "☾" : "◐";
}

export function labelFor(state: ThemeState): string {
  return state === "light" ? "Light" : state === "dark" ? "Dark" : "System";
}
