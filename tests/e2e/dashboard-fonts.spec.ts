/**
 * dashboard-fonts.spec.ts — the dashboard's fonts come from Siltpoke itself.
 *
 * They used to come from fonts.googleapis.com, so every e2e page load waited
 * on Google: a /knowledge test went from ~0.45 s to 6–7 s per run when Google
 * answered slowly. This checks, in a real browser, that the three families
 * really load, and that no stylesheet or font is asked of another site.
 */
import { test, expect } from "@playwright/test";

// Fonts are CSS, not script — but reading document.fonts needs JS on.
test.use({ javaScriptEnabled: true });

test("the dashboard's fonts load from Siltpoke, none from another site", async ({ page, baseURL }) => {
  const origin = new URL(baseURL ?? "http://127.0.0.1:9877").origin;
  const fontish: string[] = [];
  page.on("request", (req) => {
    const type = req.resourceType();
    if (type === "font" || type === "stylesheet") fontish.push(req.url());
  });

  await page.goto("/");
  // Pixelify Sans (display), Geist (body) and JetBrains Mono (labels) all
  // appear on Home; load them explicitly so the check does not hinge on which
  // glyphs this page happens to draw first.
  const loaded = await page.evaluate(async () => {
    await Promise.all(
      ['600 16px "Pixelify Sans"', '400 16px "Geist"', '400 16px "JetBrains Mono"'].map((f) =>
        document.fonts.load(f, "Siltpoke"),
      ),
    );
    // forEach, not spread: the tsconfig lib has DOM but not DOM.Iterable.
    const families: string[] = [];
    document.fonts.forEach((f) => {
      if (f.status === "loaded") families.push(f.family.replace(/"/g, ""));
    });
    return families;
  });

  for (const family of ["Pixelify Sans", "Geist", "JetBrains Mono"]) {
    expect(loaded).toContain(family);
  }
  expect(fontish.some((u) => u.includes("/static/fonts/Dash-"))).toBe(true); // positive control
  expect(fontish.filter((u) => new URL(u).origin !== origin)).toEqual([]);
});
