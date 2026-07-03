/**
 * sidebar-collapse.spec.ts — verifies the sidebar collapse toggle works.
 *
 * The sidebar uses Alpine.js x-bind:style to toggle width between 220px
 * and 52px. Playwright waits for Alpine to hydrate before assertions.
 *
 * Note: collapse persistence across page reloads is punted to Wave 2 (F1).
 * This spec only tests the in-session toggle, which IS in Wave 1 scope.
 */

import { test, expect } from "@playwright/test";

test("sidebar collapse toggles width + label visibility", async ({ page }) => {
  await page.goto("/chat");

  const sidebar = page.locator("[data-sidebar]").first();

  // Collapse button — find by aria-label inside the sidebar.
  const toggle = page.getByRole("button", { name: /toggle sidebar/i }).first();

  // Expanded: sidebar is 220px wide and the textual label "Home" is visible.
  // NavItem renders TWO spans per <a>: a single-letter icon span (always
  // visible) + the label span gated by x-show="!collapsed". Match by text
  // so we hit the label span specifically, not the icon.
  await expect(sidebar).toHaveCSS("width", "220px");
  const homeLabel = page
    .locator('[data-sidebar] a[href="/"]')
    .getByText("Home", { exact: true });
  await expect(homeLabel).toBeVisible();

  await toggle.click();
  // Wait for Alpine width binding to settle (no fixed timeout — poll CSS).
  await expect(sidebar).toHaveCSS("width", "52px", { timeout: 5_000 });
  // Labels hidden via x-show="!collapsed".
  await expect(homeLabel).toBeHidden();

  await toggle.click();
  // Re-expand: width returns to 220px, labels reappear.
  await expect(sidebar).toHaveCSS("width", "220px", { timeout: 5_000 });
  await expect(homeLabel).toBeVisible();
});
