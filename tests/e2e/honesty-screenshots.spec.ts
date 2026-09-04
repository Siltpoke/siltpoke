/**
 * honesty-screenshots.spec.ts — full-page PNG captures of user-visible
 * surfaces into test-screenshots/, numbered by user flow. These run ON
 * GREEN (not only-on-failure): each test asserts its precondition really
 * holds before snapping, so a capture is evidence, never a decoration.
 *
 *   healthy home: NO brain-health strip (fresh-install state)
 *   home with the ⚠ brain-health strip showing (seeded ×2 failure)
 *   history view free of empty "(no bubble)" rows (doctor output
 *     is CLI, not UI — this is the other history surface)
 *   repo-graph Generate affordance with the recalibrated ≈$ figure
 *     (big seeded fixture, deterministic, no Brain call)
 */
import { expect, test } from "@playwright/test";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import {
  BIG_FIXTURE_HASH,
  cleanupBigEstimateFixture,
  removeBrainHealth,
  type RestoreFn,
  seedBigEstimateFixture,
  seedLegacyBrainCalls,
  seedUnhealthyBrainHealth,
  VISIBLE_BUBBLE,
} from "./_setup/honesty-e2e-fixtures";

const OUT_DIR = join(process.cwd(), "test-screenshots");

test.beforeAll(async () => {
  await mkdir(OUT_DIR, { recursive: true });
});

test.beforeEach(async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 820 });
});

test("healthy home, no brain-health strip", async ({ page }) => {
  await removeBrainHealth();
  await page.goto("/");
  await expect(page.locator(".home-header")).toBeVisible({ timeout: 10_000 });
  await expect(page.locator("#brain-health-strip")).toHaveCount(0);
  await page.screenshot({
    path: join(OUT_DIR, "honesty-01-home-healthy-no-strip.png"),
    fullPage: true,
  });
});

test("home with brain-health strip showing", async ({ page }) => {
  let restore: RestoreFn | null = null;
  try {
    restore = await seedUnhealthyBrainHealth();
    await page.goto("/");
    const strip = page.locator("#brain-health-strip");
    await expect(strip).toBeVisible({ timeout: 10_000 });
    await expect(strip).toContainText("2 resource failures");
    await page.screenshot({
      path: join(OUT_DIR, "honesty-02-home-brain-health-strip.png"),
      fullPage: true,
    });
  } finally {
    await restore?.();
    await removeBrainHealth();
  }
});

test("history view free of empty rows", async ({ page }) => {
  let restore: RestoreFn | null = null;
  try {
    restore = await seedLegacyBrainCalls();
    // /history 302s to /timeline (rail + detail both
    // show the bubble → .first()); the capture now evidences the merged page.
    await page.goto("/history");
    await expect(page.getByText(VISIBLE_BUBBLE).first()).toBeVisible({ timeout: 10_000 });
    expect(await page.content()).not.toContain("(no bubble)");
    await page.screenshot({
      path: join(OUT_DIR, "honesty-03-history-no-empty-rows.png"),
      fullPage: true,
    });
  } finally {
    await restore?.();
  }
});

test("repo-graph Generate button with recalibrated ≈$ figure", async ({
  page,
}) => {
  try {
    await seedBigEstimateFixture();
    await page.goto(`/repo-graph?repo=${BIG_FIXTURE_HASH}`);
    await page.waitForSelector('[x-data="repoGraph"]', { timeout: 10_000 });
    await expect(page.locator("#rg-arch-gen")).toBeVisible({ timeout: 10_000 });
    await expect(page.locator("#rg-arch-gen-cost")).toContainText("≈$", {
      timeout: 10_000,
    });
    await page.waitForTimeout(800); // let the C4 layout settle for the capture
    await page.screenshot({
      path: join(OUT_DIR, "honesty-04-repo-graph-estimate.png"),
      fullPage: true,
    });
  } finally {
    await cleanupBigEstimateFixture();
  }
});
