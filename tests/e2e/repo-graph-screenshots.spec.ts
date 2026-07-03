/**
 * repo-graph-screenshots.spec.ts — PR-comment visual
 * captures. Three frames embedded as Layer 4 of the PR comment per the
 * 9-layer narrative template:
 *
 *   1. cold-open (architecture or degraded panel)
 *   2. help popover open
 *   3. search dropdown active (input filled, results may be empty in
 *      e2e tmpdir mode — capture proves the surface renders)
 */
import { test } from "@playwright/test";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { FIXTURE_HASH } from "./_setup/seed-repo-graph";

const OUT_DIR = join(process.cwd(), "tests", "e2e", "screenshots", "repo-graph");
const FIXTURE_URL = `/repo-graph?repo=${FIXTURE_HASH}`;

test.beforeAll(async () => {
  await mkdir(OUT_DIR, { recursive: true });
});

test("screenshot — cold open (fixture architecture)", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 820 });
  await page.goto(FIXTURE_URL);
  await page.waitForSelector('[x-data="repoGraph"]', { timeout: 10_000 });
  // Let the C4 render mount + lay out the container cards before the snapshot.
  await page.waitForTimeout(1500);
  await page.screenshot({
    path: join(OUT_DIR, "01-cold-open.png"),
    fullPage: false,
  });
});

test("screenshot — help popover open", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 820 });
  // The "?" help popover explains import counts → it lives in the CODEMAP view's
  // toolbar and is CSS-hidden in the default C4 architecture view (RepoGraph.tsx
  // `.rg-arch-c4-derived .ctl .help-btn{display:none}`). Open the codemap view
  // explicitly (`?arch-mode=codemap`) so the help button is visible.
  await page.goto("/repo-graph?arch-mode=codemap");
  await page.waitForSelector('[x-data="repoGraph"]', { timeout: 10_000 });
  await page.locator("#rg-help-btn").click();
  await page.waitForSelector("#rg-help-pop", { state: "visible", timeout: 5_000 });
  await page.waitForTimeout(150);
  await page.screenshot({
    path: join(OUT_DIR, "02-help-popover.png"),
    fullPage: false,
  });
});

test("screenshot — search box active", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 820 });
  await page.goto("/repo-graph");
  await page.waitForSelector('[x-data="repoGraph"]', { timeout: 10_000 });
  const search = page.locator('input[placeholder*="Jump to symbol"]');
  await search.fill("run");
  await page.waitForTimeout(400); // let debounce + fetch settle
  await page.screenshot({
    path: join(OUT_DIR, "03-search-active.png"),
    fullPage: false,
  });
});
