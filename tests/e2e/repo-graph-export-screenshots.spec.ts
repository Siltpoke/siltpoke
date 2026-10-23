/**
 * repo-graph-export-screenshots.spec.ts — visual evidence for the Code Map export.
 * Four full-page PNGs into tests/e2e/screenshots/code-map-export/ (gitignored, like the
 * other screenshot specs, so an e2e run never dirties tracked files; the copies attached to
 * the PR live in an internal design note). Runs on green; each test asserts its DOM preconditions before shooting, so a
 * capture is evidence of the state it names, not decoration.
 *
 *   01  the Generated view with the Export button and its notice row
 *   02  the preview, light, no appendix
 *   03  the preview, dark, appendix on
 *   04  the downloaded HTML, opened, with a box's panel showing
 */
import { expect, test } from "@playwright/test";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { cleanupExportFixtures, EXPORT_HASH, seedExportFixture } from "./_setup/export-fixture";
import { action, collectDownloads, dlg, gotoView, openPreview, waitForFiles } from "./_setup/export-helpers";

const OUT = join(process.cwd(), "tests", "e2e", "screenshots", "code-map-export");

test.beforeAll(async () => {
  mkdirSync(OUT, { recursive: true });
  await seedExportFixture();
});
test.afterAll(() => cleanupExportFixtures());
test.beforeEach(async ({ page }) => {
  page.setDefaultTimeout(20_000);
  await page.setViewportSize({ width: 1280, height: 820 });
});

test("01 — Generated view: Export button and the notice row", async ({ page }) => {
  await gotoView(page, EXPORT_HASH, "generated");
  await expect(page.locator("#rg-export")).toBeEnabled();
  await expect(page.locator("#rg-export-note")).toBeVisible();
  await expect.poll(() => page.locator(".c4-elab.inferred").count()).toBe(2); // dashes are the trust map's, not the legacy tier's
  await page.screenshot({ path: join(OUT, "01-page-with-export-button.png"), fullPage: true });
});

test("02 — preview, light, appendix off", async ({ page }) => {
  await gotoView(page, EXPORT_HASH, "generated");
  await openPreview(page);
  await expect(dlg(page).locator(".rg-export-scale")).toHaveText("Rendered at 2×");
  await expect(dlg(page).getByLabel("Include appendix")).not.toBeChecked();
  await expect(dlg(page).getByLabel("Dark background")).not.toBeChecked();
  await page.screenshot({ path: join(OUT, "02-preview-light.png"), fullPage: true });
});

test("03 — preview, dark background, appendix on", async ({ page }) => {
  await gotoView(page, EXPORT_HASH, "generated");
  await openPreview(page);
  await dlg(page).getByLabel("Dark background").check();
  await dlg(page).getByLabel("Include appendix").check();
  await expect(action(page, "Download PNG")).toBeEnabled();
  await expect(dlg(page).locator(".rg-export-img")).toBeVisible();
  await expect(dlg(page).getByLabel("Dark background")).toBeChecked();
  await expect(dlg(page).getByLabel("Include appendix")).toBeChecked();
  await page.screenshot({ path: join(OUT, "03-preview-dark-appendix.png"), fullPage: true });
});

test("04 — the downloaded HTML, opened, with a group's panel", async ({ page }, info) => {
  const files = collectDownloads(page, info);
  await gotoView(page, EXPORT_HASH, "generated");
  await openPreview(page);
  await action(page, "Download HTML").click();
  await waitForFiles(files, 1);
  const web = await page.context().newPage();
  await web.setViewportSize({ width: 1280, height: 820 });
  await web.goto(`file://${files[0].path}`);
  await web.locator('#map rect[data-id="c-delta"]').click({ position: { x: 8, y: 6 } }); // the card's padding: its middle is covered by its own text now
  await expect(web.locator("#panel")).toBeVisible();
  await expect(web.locator("#panel li", { hasText: "Delta Jobs → Beta Store — feeds" })).toContainText("Evidence: cited src/delta/d.ts:2");
  await web.screenshot({ path: join(OUT, "04-html-panel.png"), fullPage: true });
  await web.close();
});
