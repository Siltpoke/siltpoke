/**
 * repo-graph-export-html-panel.spec.ts — in the downloaded HTML, the box-detail panel follows the
 * clicked box (found in a hands-on test): level with the box, wholly inside the window, and
 * still there after the page scrolls. A tall map at 1440×900, a box at the top and one at the bottom.
 */
import { expect, type Page, test } from "@playwright/test";
import { cleanupExportFixtures, seedExportFixture, seedTallFixture, TALL_HASH } from "./_setup/export-fixture";
import { action, collectDownloads, gotoView, openPreview, waitForFiles } from "./_setup/export-helpers";

test.beforeAll(async () => {
  await seedExportFixture();
  await seedTallFixture();
});
test.afterAll(() => cleanupExportFixtures());

const MARGIN = 12; // panel-place.ts

async function geometry(web: Page, id: string) {
  return web.evaluate((boxId) => {
    const box = document.querySelector(`#map rect[data-id="${boxId}"]`)!.getBoundingClientRect();
    const p = document.getElementById("panel")!.getBoundingClientRect();
    const map = document.getElementById("map")!.getBoundingClientRect();
    return { boxTop: box.top, top: p.top, bottom: p.bottom, h: p.height, view: window.innerHeight, gap: p.left - map.right, y: window.scrollY };
  }, id);
}
/** Where the panel should be for a box at `boxTop`: level with it, clamped into the window. */
const expected = (g: { boxTop: number; h: number; view: number }): number => Math.max(MARGIN, Math.min(g.boxTop, g.view - MARGIN - g.h));
/** Scroll the page itself (not a wheel over #map), then let the rAF re-placement run. */
async function scrollPage(web: Page, dy: number): Promise<void> {
  await web.evaluate((d) => window.scrollBy(0, d), dy);
  await web.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
}

async function openExportedHtml(page: Page, files: Awaited<ReturnType<typeof collectDownloads>>): Promise<Page> {
  await page.setViewportSize({ width: 1440, height: 900 });
  await gotoView(page, TALL_HASH, "generated");
  await openPreview(page);
  await action(page, "Download HTML").click();
  await waitForFiles(files, 1);
  const web = await page.context().newPage();
  await web.setViewportSize({ width: 1440, height: 900 });
  await web.goto(`file://${files[0].path}`);
  // The fixture must overflow, or "it stays beside the box while scrolling" proves nothing.
  expect(await web.evaluate(() => document.documentElement.scrollHeight - window.innerHeight)).toBeGreaterThan(300);
  return web;
}

test("the panel opens level with the clicked box, tracks it as the page scrolls, and clamps at the edge", async ({ page }, info) => {
  test.setTimeout(60_000);
  const web = await openExportedHtml(page, collectDownloads(page, info));
  const panel = web.locator("#panel");
  for (const [id, shot] of [["c-0-0", "top"], ["c-5-0", "bottom"]] as const) {
    await web.locator(`#map rect[data-id="${id}"]`).click({ position: { x: 8, y: 6 } });
    await expect(panel).toBeVisible();
    const g = await geometry(web, id);
    expect(Math.abs(g.top - expected(g)), `${id}: panel top vs box top ${g.boxTop}`).toBeLessThanOrEqual(2);
    expect(g.top).toBeGreaterThanOrEqual(0);
    expect(g.bottom).toBeLessThanOrEqual(g.view);
    expect(Math.abs(g.gap - 16), "beside the map, not at the window's far edge").toBeLessThanOrEqual(1);
    await web.screenshot({ path: `/tmp/code-map-html-panel-${shot}-box.png` });
  }
  // Scroll to the top box, open it, then scroll the page down 300px: the page really moved, the box
  // moved up with it, and the panel followed the box (not the page) and stayed inside the window.
  await web.evaluate(() => window.scrollTo(0, 0));
  await web.locator('#map rect[data-id="c-0-0"]').click({ position: { x: 8, y: 6 } });
  const before = await geometry(web, "c-0-0");
  await scrollPage(web, 150);
  const after = await geometry(web, "c-0-0");
  expect(after.y - before.y).toBeGreaterThan(100);
  expect(before.boxTop - after.boxTop).toBeCloseTo(after.y - before.y, 0);
  expect(Math.abs(after.top - expected(after)), "tracks the box").toBeLessThanOrEqual(2);
  // The box scrolled off the top: the panel stops at the window's top edge, still wholly visible.
  await scrollPage(web, 800);
  const gone = await geometry(web, "c-0-0");
  expect(gone.boxTop).toBeLessThan(0);
  expect(gone.top).toBeCloseTo(MARGIN, 0);
  expect(gone.bottom).toBeLessThanOrEqual(gone.view);
  await web.close();
});

test("narrow window: crossing into the stacked layout scrolls the panel in once; resizing within it does not move the page", async ({ page }, info) => {
  test.setTimeout(60_000);
  const web = await openExportedHtml(page, collectDownloads(page, info));
  await web.locator('#map rect[data-id="c-0-0"]').click({ position: { x: 8, y: 6 } });
  const panel = web.locator("#panel");
  await web.setViewportSize({ width: 700, height: 900 }); // wide → narrow
  await expect.poll(() => panel.evaluate((p) => {
    const r = p.getBoundingClientRect();
    return r.top < window.innerHeight && r.bottom > 0;
  })).toBe(true);
  await web.evaluate(() => window.scrollTo(0, 0));
  await web.setViewportSize({ width: 690, height: 840 }); // narrow → narrow (a phone's address bar)
  await web.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
  expect(await web.evaluate(() => window.scrollY)).toBe(0);
  await web.close();
});
