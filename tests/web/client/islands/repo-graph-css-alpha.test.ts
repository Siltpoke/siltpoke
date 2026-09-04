// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
// Copyright (c) 2026 Jiaqi Duan
/**
 * `cssAlpha` — the replacement for `hexA`, the hex-PARSING helper Task 8 deleted.
 *
 * hexA took a hex literal, split it into channels with parseInt/bit-shifts, and
 * returned `rgba(...)`. That is why its result could never follow a theme: the
 * numeric value was frozen at whatever hex was compiled in. cssAlpha never
 * parses anything — it composes a `color-mix()` string that the browser
 * re-resolves on every repaint, so a `var()` input follows the theme.
 *
 * hexA shipped with no test at all, and its replacement is the only new
 * behaviour-carrying function in Task 8, so the conversion is pinned here:
 * `color-mix(in srgb, C p%, transparent)` is equivalent to `rgba(r,g,b,p/100)`
 * for an opaque sRGB C (mixing with `transparent` = `rgb(0 0 0 / 0)` under
 * premultiplied interpolation yields alpha p/100 and the source channels
 * unchanged), which is what makes it a faithful drop-in.
 */
import { describe, expect, test } from "bun:test";
import { cssAlpha } from "../../../../src/web/client/islands/repo-graph";

describe("cssAlpha", () => {
  test("composes a color-mix over the given color at the given percent", () => {
    expect(cssAlpha("var(--ink3)", 60)).toBe("color-mix(in srgb, var(--ink3) 60%, transparent)");
  });

  test("takes a percent (0-100), not a 0-1 alpha — the hexA call sites converted 0.6 -> 60", () => {
    // Regression pin for the conversion itself. Passing 0.6 through unconverted
    // would silently produce a 0.6%-opacity border: visible in code review only
    // as a plausible-looking number.
    expect(cssAlpha("var(--terra)", 60)).toContain(" 60%");
    expect(cssAlpha("var(--terra)", 60)).not.toContain(" 0.6%");
  });

  test("passes a var() reference through UNPARSED, which is what makes it theme-following", () => {
    // The whole point vs hexA: no channel extraction, so the browser resolves
    // the variable at paint time.
    const out = cssAlpha("var(--resolved)", 50);
    expect(out).toContain("var(--resolved)");
    expect(out).not.toMatch(/\d{1,3}\s*,\s*\d{1,3}\s*,\s*\d{1,3}/); // no rgb triple
  });

  test("accepts a raw color value too — the server's group accents are not tokens", () => {
    expect(cssAlpha("#d96b6b", 50)).toBe("color-mix(in srgb, #d96b6b 50%, transparent)");
  });

  test("0% and 100% are the transparent / opaque ends", () => {
    expect(cssAlpha("var(--x)", 0)).toBe("color-mix(in srgb, var(--x) 0%, transparent)");
    expect(cssAlpha("var(--x)", 100)).toBe("color-mix(in srgb, var(--x) 100%, transparent)");
  });
});
