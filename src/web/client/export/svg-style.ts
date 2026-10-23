// Fixed export palettes (spec §7.2, AC18). Values are read from the app's own
// palette module — the one place a color literal may live — but resolved to
// literal colors here, NOT to `var(--…)`: an SVG drawn through <img> has no
// access to the page's CSS variables, and the image must not change when the
// dashboard theme does.
import { palette, type ThemeName } from "../../tokens/palette";

/** The on-screen C4 view's roles (RepoGraph.tsx `.c4-*`), as literal colours. */
export interface SvgPalette {
  /** page and card background (`--cream`) */
  bg: string;
  /** outside-system box fill (`--paperD`) */
  ext: string;
  ink: string;
  muted: string;
  faint: string;
  /** hairline card border (`--edge`) */
  rule: string;
}

export function svgPalette(theme: ThemeName): SvgPalette {
  const p = palette[theme];
  return { bg: p.cream, ext: p.paperD, ink: p.ink, muted: p.ink2, faint: p.ink3, rule: p.edge };
}

export interface Resolved {
  color: string;
  opacity: number;
}

const VAR = /^var\(\s*--color-(\w+)\s*\)$/;
const MIX = /^color-mix\(\s*in srgb\s*,\s*(.+?)\s+(\d+(?:\.\d+)?)%\s*,\s*transparent\s*\)$/;
const HEX = /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i;

/**
 * Turn a model color string (a token reference, a `color-mix` tint of one, or a
 * plain hex) into a literal color + opacity. Anything unrecognised falls back
 * to the muted ink at `fallbackOpacity` — never passed through, so no `var(--`
 * and no attacker text can reach an attribute. A wash (band) passes a low
 * fallback opacity so an unknown colour cannot paint over what sits under it.
 */
export function resolveColor(value: string, theme: ThemeName, fallbackOpacity = 1): Resolved {
  const p = palette[theme] as Record<string, string>;
  const fallback = { color: p.ink3, opacity: fallbackOpacity };
  const v = value.trim();
  const mix = MIX.exec(v);
  if (mix) return { ...resolveColor(mix[1], theme, fallbackOpacity), opacity: Number(mix[2]) / 100 };
  const tok = VAR.exec(v);
  if (tok) return p[tok[1]] ? { color: p[tok[1]], opacity: 1 } : fallback;
  return HEX.test(v) ? { color: v, opacity: 1 } : fallback;
}
