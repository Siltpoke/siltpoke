// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
// Copyright (c) 2026 Jiaqi Duan
import { describe, expect, test } from "bun:test";
import { tokensToCss, tokensToTailwindTheme } from "../../../src/web/tokens/tokens";
import { palette, graphPalette, kindPalette } from "../../../src/web/tokens/palette";

describe("tokensToCss", () => {
  const css = tokensToCss();

  test("emits the four blocks", () => {
    expect(css).toContain(":root {");
    expect(css).toContain("@media (prefers-color-scheme: dark)");
    expect(css).toContain(':root:not([data-theme="light"])');
    expect(css).toContain(':root[data-theme="dark"]');
    expect(css).toContain(':root[data-theme="light"]');
  });

  // The plan's hardest-won constraint (final dark-mode branch review, Minor):
  // an UNLAYERED `:root` override beats Tailwind's layered `@theme` value
  // regardless of specificity or link order — that is the whole reason this
  // module emits plain `:root { ... }` blocks instead of participating in
  // Tailwind's cascade layers. Until now that invariant was pinned only by
  // an e2e negative control (tests/e2e/dark-mode.spec.ts:55, "an unlayered
  // :root override beats Tailwind's layered @theme value..."), which proves
  // the BROWSER'S cascade behavior but not that this generator keeps
  // producing unlayered output — a future edit could wrap the emission in
  // `@layer` and this e2e test alone wouldn't localize the regression to
  // tokens.ts. This one-line unit assertion pins the actual invariant at
  // its source.
  test("never wraps its output in a cascade layer — that's what makes it beat Tailwind's layered @theme unconditionally", () => {
    expect(css).not.toContain("@layer");
  });

  test("block ORDER is the invariant that makes forced-light-on-dark-OS work", () => {
    // The forced-light block must come AFTER the media block, or a user forcing
    // light on a dark OS gets dark values.
    const media = css.indexOf("@media (prefers-color-scheme: dark)");
    const forcedLight = css.indexOf(':root[data-theme="light"]');
    expect(media).toBeGreaterThan(-1);
    expect(forcedLight).toBeGreaterThan(media);
  });

  test("declares color-scheme in every block, not only the meta tag", () => {
    expect(css.match(/color-scheme:\s*light/g)?.length).toBeGreaterThanOrEqual(2);
    expect(css.match(/color-scheme:\s*dark/g)?.length).toBeGreaterThanOrEqual(2);
  });

  test("every color key appears with its light and its dark value", () => {
    for (const key of Object.keys(palette.light)) {
      expect(css).toContain(`--color-${key}: ${palette.light[key as never]}`);
      expect(css).toContain(`--color-${key}: ${palette.dark[key as never]}`);
    }
  });

  test("shadows get dark variants — light shadows derive from light ink", () => {
    expect(css).toContain("--shadow-sm");
    const darkBlock = css.slice(css.indexOf(':root[data-theme="dark"]'));
    expect(darkBlock).toContain("--shadow-sm");
  });

  // Review round 1 finding (Important 4b): RepoGraph.tsx's .rg-host block
  // aliases --resolved/--unresolved/--unresolvable to var(--graph-<key>) —
  // if this emission loop were ever deleted, every trace edge, node border,
  // and legend swatch would silently lose its color, and nothing in the
  // suite would fail, because nothing asserted --graph-* actually reaches
  // tokens.css. Driven RED once by deleting the emission loop in tokens.ts
  // (see the fix report for the failing output, then reverted).
  test("every graph key appears with its light and its dark value", () => {
    for (const key of Object.keys(graphPalette.light)) {
      expect(css).toContain(`--graph-${key}: ${graphPalette.light[key as never]}`);
      expect(css).toContain(`--graph-${key}: ${graphPalette.dark[key as never]}`);
    }
  });

  // Task 10b batch 2 — same risk as the graph-key test above, now for
  // TraceWaterfall's kindPalette: if the emission loop in tokens.ts's
  // themeVars() were ever deleted, every span-kind bar would silently lose
  // its color and nothing in the suite would fail without this assertion.
  test("every kind key appears with its light and its dark value", () => {
    for (const key of Object.keys(kindPalette.light)) {
      expect(css).toContain(`--kind-${key}: ${kindPalette.light[key as never]}`);
      expect(css).toContain(`--kind-${key}: ${kindPalette.dark[key as never]}`);
    }
  });
});

describe("tokensToTailwindTheme", () => {
  const theme = tokensToTailwindTheme();

  test("carries LITERAL light hex, never a var() (a var here would be circular)", () => {
    expect(theme).toContain(`--color-cream: ${palette.light.cream}`);
    expect(theme).not.toContain("var(--color-");
  });

  test("covers every token key — the hand-mirrored block had dropped violet", () => {
    for (const key of Object.keys(palette.light)) {
      expect(theme, `missing --color-${key}`).toContain(`--color-${key}:`);
    }
  });

  test("keeps the keyword colors utilities rely on", () => {
    expect(theme).toContain("--color-*: initial");
    expect(theme).toContain("--color-transparent: transparent");
    expect(theme).toContain("--color-white: #ffffff");
  });
});
