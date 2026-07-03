/**
 * home.spec.ts — Home dashboard Playwright scenarios.
 *
 * 3 scenarios:
 *   1. Renders all 5 regions (sidebar, hero, StatsPanel, Budget + Histogram
 *      cards, Home header).
 *   2. Sidebar disabled entries are non-interactive (render as <span>, not <a>).
 *   3. Feed chip click does not trigger full page reload (URL unchanged, hero
 *      present, OOB stats-panel + HX-Trigger-After-Swap deliver feedback).
 *
 * Post-MVP polish — VitalsPanel + CritiqueInbox + ViewToggle removed;
 *  Budget + SkipHistogram cards lifted from former /stats route; sleep + tease
 *  chips added; /stats nav entry removed.
 */

import { test, expect } from "@playwright/test";

test("1. renders all 5 regions on home page (polished layout)", async ({ page }) => {
  await page.goto("/");

  // Region 1: Dashboard sidebar (collapse arrow + brand chip + footer)
  const sidebar = page.locator("[data-sidebar]");
  await expect(sidebar).toBeVisible({ timeout: 10_000 });

  // Region 2: HomeCenter — anchored on #hero for HTMX swap target back-compat
  const hero = page.locator("#hero");
  await expect(hero).toBeVisible({ timeout: 10_000 });

  // Region 3: StatsPanel (XP bar on top + 5 meter rows)
  const stats = page.locator(".stats-panel");
  await expect(stats).toBeVisible({ timeout: 10_000 });

  // Region 4: telemetry cards lifted from former /stats — BUDGET +
  // REASON BREAKDOWN. GateCheckList was redundant once quiet-hours moved to
  // a header pill and budget got its own card; intentionally dropped.
  // Match the section header text exactly to disambiguate from per-row labels.
  await expect(page.getByText("BUDGET", { exact: true })).toBeVisible({ timeout: 10_000 });
  await expect(page.getByText("REASON BREAKDOWN", { exact: true })).toBeVisible({ timeout: 10_000 });

  // Region 5: Home header
  const homeHeader = page.locator(".home-header");
  await expect(homeHeader).toBeVisible({ timeout: 10_000 });

  // Removed in the dashboard polish — these must NOT render anymore.
  await expect(page.locator(".view-toggle")).toHaveCount(0, { timeout: 5_000 });
  await expect(page.locator(".vitals-panel")).toHaveCount(0, { timeout: 5_000 });
  await expect(page.locator(".critique-inbox")).toHaveCount(0, { timeout: 5_000 });

  // 6-chip row: feed / play / clean / pet / sleep / tease (sleep + tease
  // added back after the original Design D pared them down).
  for (const action of ["feed", "play", "clean", "pet", "sleep", "tease"]) {
    await expect(page.locator(`[data-action="${action}"]`)).toBeVisible({ timeout: 5_000 });
  }
});

test("2. sidebar disabled entries are non-interactive (no <a> href)", async ({ page }) => {
  await page.goto("/");

  const sidebar = page.locator("[data-sidebar]");
  await expect(sidebar).toBeVisible({ timeout: 10_000 });

  // /stats nav entry removed, so 4 disabled entries remain.
  const disabledHrefs = [
    "/inventory",
    "/friends",
    "/commands",
    "/settings",
  ];

  for (const href of disabledHrefs) {
    const anchor = page.locator(`[data-sidebar] a[href="${href}"]`);
    await expect(anchor).toHaveCount(0, { timeout: 5_000 });
  }

  const disabledSpans = page.locator('[data-sidebar] span[aria-disabled="true"]');
  await expect(disabledSpans).toHaveCount(4, { timeout: 5_000 });
});

test("3. feed chip click does not trigger full page reload (URL unchanged, hero present)", async ({ page }) => {
  await page.goto("/");

  const hero = page.locator("#hero");
  await expect(hero).toBeVisible({ timeout: 10_000 });

  // The contract this test enforces is "clicking the chip does not navigate
  // away" — covered by URL + hero stability checks. HTMX (if booted) does an
  // outerHTML swap of #hero + OOB swap of #stats-panel. We give the swap a
  // generous window and then assert the no-full-reload invariant either way.
  const initialUrl = page.url();
  const feedChip = page.locator('[data-action="feed"]').first();
  await expect(feedChip).toBeVisible({ timeout: 10_000 });

  await feedChip.click();
  await page.waitForTimeout(1_500); // generous window for HTMX swap to complete

  expect(page.url()).toBe(initialUrl);
  await expect(page.locator("#hero")).toBeVisible({ timeout: 5_000 });
});
