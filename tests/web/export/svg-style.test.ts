import { describe, expect, test } from "bun:test";
import { buildExportSvg } from "../../../src/web/client/export/build-svg";
import { resolveColor } from "../../../src/web/client/export/svg-style";
import { type BandSeed, layoutC4Bands } from "../../../src/web/client/islands/repo-graph-c4-derive";
import { type C4Accent, type C4Node, GROUP_ACCENT } from "../../../src/web/client/islands/repo-graph-c4-model";
import { palette, type ThemeName } from "../../../src/web/tokens/palette";
import { attrs, model, STAMP, tags, trust } from "./fixtures";

const THEMES: ThemeName[] = ["light", "dark"];
const ACCENTS = ["sky", "terra", "moss", "amber"] as const satisfies readonly C4Accent[];
const pal = (t: ThemeName) => palette[t] as Record<string, string>;

// Every colour string the C4 model can emit: the four GROUP_ACCENT tokens (box
// stroke), and per accent the band wash (`color-mix` of the accent) + label ink
// (`bandLabelInk*`), which the generated, subset and authored paths all reach
// through layoutC4Bands / GROUP_ACCENT.
function emittedBands() {
  const seeds: BandSeed[] = ACCENTS.map((accent) => ({ id: accent, label: accent, accent, note: "", memberIds: [] }));
  return { accents: ACCENTS, bands: layoutC4Bands(seeds, {} as Record<string, C4Node>, "b").bands };
}

describe("resolveColor covers every colour the model emits", () => {
  for (const theme of THEMES) {
    test(`${theme}: accents resolve to their own palette token, not the fallback`, () => {
      for (const a of ACCENTS) {
        const r = resolveColor(GROUP_ACCENT[a], theme);
        expect(r.color).toBe(pal(theme)[a]);
        expect(r.color).not.toBe(pal(theme).ink3);
        expect(r.opacity).toBe(1);
      }
    });
    test(`${theme}: band washes and label inks resolve to real palette colours`, () => {
      const { bands } = emittedBands();
      expect(bands.length).toBe(4);
      bands.forEach((b, i) => {
        const a = ACCENTS[i];
        const wash = resolveColor(b.color, theme, 0.123);
        expect(wash.color).toBe(pal(theme)[a]);
        expect(wash.opacity).not.toBe(0.123); // came from the mix percentage, not the fallback
        expect(wash.opacity).toBeGreaterThan(0);
        expect(wash.opacity).toBeLessThan(0.2);
        const ink = resolveColor(b.lc, theme, 0.123);
        expect(ink.color).toBe(pal(theme)[`bandLabelInk${a[0].toUpperCase()}${a.slice(1)}`]);
        expect(ink.opacity).toBe(1);
      });
    });
  }
  test("unrecognised strings fall back to ink3 at the caller's opacity, never passed through", () => {
    for (const bad of ["", "red", "var(--nope)", "var(--color-nope)", "url(x)", "color-mix(in srgb, red 9%, transparent)"]) {
      const r = resolveColor(bad, "light", 0.1);
      expect(r.color).toBe(pal("light").ink3);
      expect(r.color).not.toContain("var(");
    }
    expect(resolveColor("nope", "light").opacity).toBe(1);
    expect(resolveColor("nope", "light", 0.1).opacity).toBe(0.1);
  });
});

describe("colours in the built svg", () => {
  const build = (m = model(), theme: ThemeName = "light") =>
    buildExportSvg(m, trust(), { theme, fontCss: "", stampLine: STAMP }).svg;
  for (const theme of THEMES) {
    test(`${theme}: CORE band is a faint terra wash, box a is a hairline card with a sky left bar`, () => {
      const svg = build(model(), theme);
      const band = tags(svg, "rect").find((r) => r.includes('rx="11"'));
      expect(band).toBeDefined();
      expect(attrs(band as string).fill).toBe(pal(theme).terra);
      expect(Number(attrs(band as string)["fill-opacity"])).toBe(0.09);
      const boxA = tags(svg, "rect").find((r) => r.includes('data-id="a"'));
      expect(attrs(boxA as string).stroke).toBe(pal(theme).edge);
      expect(attrs(boxA as string).fill).toBe(pal(theme).cream);
      const bar = tags(svg, "rect").find((r) => r.includes('data-role="bar"') && r.includes('data-for="a"'));
      expect(attrs(bar as string).fill).toBe(pal(theme).sky);
      expect(attrs(bar as string).width).toBe("4");
    });
  }
  test("an unknown band colour is a faint wash, not an opaque slab", () => {
    const m = model();
    m.BANDS[0] = { ...m.BANDS[0], color: "mystery" };
    const band = tags(build(m), "rect").find((r) => r.includes('rx="11"')) as string;
    expect(attrs(band).fill).toBe(pal("light").ink3);
    expect(Number(attrs(band)["fill-opacity"])).toBeLessThanOrEqual(0.15);
  });
});
