/**
 * repo-graph-export-layout.spec.ts — the parts of the Code Map export that live on the page
 * itself rather than in the preview: AC32 (on-screen edges use the export's solid/dashed
 * rule) and the Export button / notice layout at three widths. Same fixture as
 * repo-graph-export.spec.ts (tests/e2e/_setup/export-fixture.ts).
 */
import { expect, test, type Page } from "@playwright/test";
import { cleanupExportFixtures, EXPORT_HASH, seedExportFixture } from "./_setup/export-fixture";
import { gotoView, viewUrl } from "./_setup/export-helpers";

const TRUST = "**/api/repo-graph/arch/trust**";

test.beforeAll(seedExportFixture);
test.afterAll(() => cleanupExportFixtures());
test.beforeEach(({ page }) => {
  page.setDefaultTimeout(20_000);
});

// ── AC32: on-screen edges follow the export rule ─────────────────────────────────

async function edgeStyles(page: Page): Promise<{ dashed: string[]; solid: string[]; dashPaths: number }> {
  return page.evaluate(() => {
    const labels = Array.from(document.querySelectorAll<HTMLElement>(".c4-elab"));
    return {
      dashed: labels.filter((l) => l.classList.contains("inferred")).map((l) => l.textContent ?? "").sort(),
      solid: labels.filter((l) => !l.classList.contains("inferred")).map((l) => l.textContent ?? "").sort(),
      dashPaths: document.querySelectorAll("svg path[stroke-dasharray][marker-end]").length,
    };
  });
}

test("AC32 — on screen, an inferred-but-imported edge is solid; a blocked trust route falls back to the legacy dash with a note", async ({ page }) => {
  await gotoView(page, EXPORT_HASH, "generated");
  await expect.poll(() => edgeStyles(page).then((s) => s.dashed.join())).toBe("notifies,syncs");
  const ok = await edgeStyles(page);
  expect(ok.solid).toEqual(["calls", "feeds", "reads"]); // "reads" is tier inferred but has a real import
  expect(ok.dashPaths).toBe(2);
  await expect(page.getByText("Edge check unavailable")).toHaveCount(0);

  await page.route(TRUST, (route) => route.abort());
  await page.goto(viewUrl(EXPORT_HASH, "generated"));
  await expect(page.getByText(/Edge check unavailable — dashed here means the citation was not corroborated/)).toBeVisible();
  const legacy = await edgeStyles(page);
  expect(legacy.dashed).toEqual(["notifies", "reads"]); // the legacy rule: tier "inferred" = dashed
  expect(legacy.dashPaths).toBe(2);
});

// ── F3: the outside column sits level with the bands, on the page ───────────────

test("F3 — on screen, an outside box is centred on the bands' height, not pinned to the boundary's top", async ({ page }) => {
  await gotoView(page, EXPORT_HASH, "generated");
  const ext = page.locator(".c4-node.ext");
  await expect(ext).toHaveCount(1);
  const [e, bands] = await Promise.all([
    ext.boundingBox(),
    page.locator(".c4-band").evaluateAll((els) => els.map((b) => b.getBoundingClientRect()).map((r) => ({ top: r.top, bottom: r.bottom }))),
  ]);
  if (!e) throw new Error("no outside box on the page");
  const top = Math.min(...bands.map((b) => b.top));
  const bottom = Math.max(...bands.map((b) => b.bottom));
  expect(Math.abs(e.y + e.height / 2 - (top + bottom) / 2)).toBeLessThan(1.5); // the view may be zoomed: compare on screen
});

// ── layout ───────────────────────────────────────────────────────────────────────

interface Box {
  what: string;
  x: number;
  y: number;
  w: number;
  h: number;
}

async function measure(page: Page): Promise<{ note: Box; button: Box; others: Box[]; scrollW: number; innerW: number }> {
  return page.evaluate(() => {
    const box = (e: Element, what: string): Box => {
      const r = e.getBoundingClientRect();
      return { what, x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) };
    };
    const note = document.querySelector("#rg-export-note") as HTMLElement;
    const button = document.querySelector("#rg-export") as HTMLElement;
    const sel = 'button, a[href], input, select, textarea, [role="button"], [tabindex]:not([tabindex="-1"])';
    const others = Array.from(document.querySelectorAll(sel))
      .filter((e) => e !== note && e !== button && !note.contains(e) && !button.contains(e) && !e.closest("dialog"))
      .filter((e) => {
        const r = e.getBoundingClientRect();
        const cs = getComputedStyle(e);
        return r.width > 0 && r.height > 0 && cs.visibility !== "hidden" && cs.display !== "none";
      })
      .map((e) => box(e, `${e.tagName.toLowerCase()}#${e.id || "-"}.${(e as HTMLElement).className.toString().split(" ")[0] || "-"}`));
    return { note: box(note, "note"), button: box(button, "button"), others, scrollW: document.documentElement.scrollWidth, innerW: window.innerWidth };
  });
}

const overlaps = (a: Box, b: Box): boolean => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;

for (const width of [375, 768, 1280]) {
  test(`layout — notice and Export overlap no other control and cause no horizontal scroll at ${width}px`, async ({ page }, info) => {
    await page.setViewportSize({ width, height: 820 });
    await gotoView(page, EXPORT_HASH, "generated");
    await expect(page.locator("#rg-export-note")).toBeVisible();
    const m = await measure(page);
    // Not asserted (the page head's own narrow-width behaviour predates Export): where the
    // neighbouring controls sit, and whether the head scrolls, so Export's reach is on record.
    const head = await page.evaluate(() => {
      const h = document.querySelector<HTMLElement>(".pagehead") as HTMLElement;
      const at = (sel: string) => {
        const r = document.querySelector(sel)?.getBoundingClientRect();
        return r ? { x: Math.round(r.x), w: Math.round(r.width) } : null;
      };
      return { overflowX: getComputedStyle(h).overflowX, scrollWidth: h.scrollWidth, clientWidth: h.clientWidth, chip: at("#rg-src-chip"), regenerate: at("#rg-arch-gen") };
    });
    await info.attach(`layout-${width}.json`, { body: JSON.stringify({ ...m, head }, null, 2), contentType: "application/json" });
    expect(overlaps(m.note, m.button), "note vs Export").toBe(false);
    expect(m.others.filter((o) => overlaps(m.note, o)), "note overlaps").toEqual([]);
    expect(m.others.filter((o) => overlaps(m.button, o)), "Export overlaps").toEqual([]);
    expect(m.scrollW, "no horizontal page scroll").toBeLessThanOrEqual(m.innerW);
  });
}
