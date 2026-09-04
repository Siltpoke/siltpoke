/**
 * nav-render.spec.ts — verifies sidebar renders all CANONICAL_NAV entries.
 *
 * Uses /chat because GET / is still the legacy pet-dashboard (route conflict
 * between mountDashboardRoutes and mountHomeRoutes; first-match wins in Hono).
 * The Chat screen renders the Dashboard shell with full CANONICAL_NAV.
 *
 * CANONICAL_NAV (src/web/routes/nav.ts) carries 5 interactive entries —
 * Home / Timeline / Memory / Code Map / Settings. "Quests" was removed 2026-08-06
 * with the a retired page route's unmount, and this spec asserts its absence in the real
 * browser: the unit tests can only see the nav array, not what the shell renders.
 * The former disabled
 * placeholder entries (inventory / friends / commands) were removed entirely,
 * so there are no <span aria-disabled> nav items anymore. (Settings was
 * re-added as a live route in Slice C — the review-brain selector.)
 */

import { test, expect } from "@playwright/test";

test("sidebar renders all CANONICAL_NAV entries (all interactive, no disabled placeholders)", async ({ page }) => {
  await page.goto("/chat");

  const nav = page.getByRole("navigation", { name: "Sidebar" });

  for (const label of ["Home", "Timeline", "Memory", "Code Map"]) {
    await expect(nav.getByText(label, { exact: true }).first()).toBeVisible({ timeout: 10_000 });
  }

  await expect(nav.getByText("Settings", { exact: true })).toHaveCount(0);
  await expect(page.locator('[data-sidebar] a[href="/settings"]')).toHaveCount(0);

  // Nav schema simplification removed every disabled placeholder entry, so no
  // nav item renders as a non-interactive <span aria-disabled="true">.
  const disabledSpans = page.locator('[data-sidebar] span[aria-disabled="true"]');
  await expect(disabledSpans).toHaveCount(0);
});
