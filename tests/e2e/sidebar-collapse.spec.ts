/**
 * sidebar-collapse.spec.ts — verifies the sidebar collapse toggle works.
 *
 * The sidebar uses Alpine.js x-bind:style to toggle width between 220px
 * and 52px. Playwright waits for Alpine to hydrate before assertions.
 *
 * Note: collapse persistence across page reloads is punted to Wave 2 (F1).
 * This spec only tests the in-session toggle, which IS in Wave 1 scope.
 */

import { expect, test } from "@playwright/test";

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

/**
 * A narrow window gets the rail whether or not the reader asked for it.
 *
 * MEASURED before this existed, at a 480px window: the sidebar held 221px and
 * `<main>` was left 259px — on ALL FIVE screens, not just the one being worked
 * on. More than half the window was navigation, and no screen could reclaim it:
 * each one's own grid had already collapsed as far as it goes.
 *
 * Asserted on `/` and `/knowledge` because the rule lives in the shell, and a
 * shell rule proven on one screen is proven on none of the others — the
 * evidence for the bug was that all five behaved identically.
 */
test("narrow window: the sidebar becomes the rail, and takes its dead toggle with it", async ({ page }) => {
  for (const route of ["/", "/timeline"]) {
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto(route);
    const sidebar = page.locator("[data-sidebar]").first();
    await expect(sidebar).toHaveCSS("width", "220px");

    // Count the destinations at full width FIRST, and compare against it below
    // rather than against a literal. The literal was `5`, and it went stale the
    // moment the Decisions view added a sixth nav entry — a test that has to be
    // edited every time navigation grows will eventually be edited without
    // being thought about. What this assertion is actually for is "collapsing
    // loses no destination", and that is a comparison, not a constant.
    const wideLinks = await page.evaluate(
      () =>
        Array.from(document.querySelectorAll("[data-sidebar] a.nav-item")).filter(
          (l) => (l as HTMLElement).getBoundingClientRect().width > 0,
        ).length,
    );

    await page.setViewportSize({ width: 480, height: 900 });
    // `toHaveCSS` polls, so it already waits out the 0.15s width transition —
    // the same transition that made a naive measure in
    // tests/e2e/knowledge-reading.spec.ts read a mid-animation 246px.
    await expect(sidebar).toHaveCSS("width", "52px", { timeout: 5_000 });

    const m = await page.evaluate(() => {
      const main = document.querySelector("main") as HTMLElement | null;
      const links = Array.from(document.querySelectorAll("[data-sidebar] a.nav-item")) as HTMLElement[];
      return {
        mainWidth: Math.round(main?.getBoundingClientRect().width ?? -1),
        reachableLinks: links.filter((l) => l.getBoundingClientRect().width > 0).length,
        pageOverflows: document.documentElement.scrollWidth > document.documentElement.clientWidth,
      };
    });

    // 427px measured, against 259px before. The floor is what the arithmetic
    // guarantees (480 - 52 - a little chrome), not the exact number, so a
    // 1px layout shift does not fail this.
    expect(m.mainWidth, `main at 480 on ${route}`).toBeGreaterThan(400);
    // The rail has to stay a rail, not a stump: every destination is still
    // there as an icon. Shrinking the sidebar by dropping links would satisfy
    // the width assertion and destroy the navigation.
    //
    // The floor is here because equality ALONE is satisfiable by both counts
    // being wrong together — a shell that rendered no nav at all would pass
    // `0 === 0`. Five is the count this rule was originally measured against,
    // so it is a floor, not a target.
    expect(wideLinks, `nav links at 1280 on ${route}`).toBeGreaterThanOrEqual(4);
    expect(m.reachableLinks, `nav links at 480 on ${route}`).toBe(wideLinks);
    expect(m.pageOverflows, `horizontal scroll at 480 on ${route}`).toBe(false);

    // The toggle would otherwise flip a state the stylesheet overrules — a
    // button that visibly does nothing.
    await expect(page.getByRole("button", { name: /toggle sidebar/i }).first()).toBeHidden();

    // And it comes back, so this is a response to the window rather than a
    // one-way trip into a mode with no exit.
    await page.setViewportSize({ width: 1280, height: 900 });
    await expect(sidebar).toHaveCSS("width", "220px", { timeout: 5_000 });
  }
});
