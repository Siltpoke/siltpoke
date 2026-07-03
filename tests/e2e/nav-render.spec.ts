/**
 * nav-render.spec.ts — verifies sidebar renders all CANONICAL_NAV entries.
 *
 * Uses /chat because GET / is still the legacy pet-dashboard (route conflict
 * between mountDashboardRoutes and mountHomeRoutes; first-match wins in Hono).
 * The Chat screen renders the Dashboard shell with full CANONICAL_NAV.
 *
 * Disabled Settings entry MUST have no href attribute.
 * The NavItem renders disabled entries as <span aria-disabled="true">, not <a>.
 */

import { test, expect } from "@playwright/test";

test("sidebar renders all CANONICAL_NAV entries (disabled Settings has no href)", async ({ page }) => {
  await page.goto("/chat");

  const nav = page.getByRole("navigation", { name: "Sidebar" });

  for (const label of ["Home", "Memory", "Settings"]) {
    await expect(nav.getByText(label, { exact: true }).first()).toBeVisible({ timeout: 10_000 });
  }

  // Disabled Settings entry has no <a href="/settings"> — it renders
  // as <span aria-disabled="true">, so no anchor links to it at all.
  const settingsLink = page.locator('[data-sidebar] a[href="/settings"]');
  await expect(settingsLink).toHaveCount(0);
});
