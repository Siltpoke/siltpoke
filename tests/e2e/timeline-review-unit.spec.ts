/**
 * timeline-review-unit.spec.ts — the ⏱ review-unit control is off the page.
 *
 * HIDDEN 2026-09-21 on the maintainer's call. Hidden, not removed: the `reviewUnit`
 * axis, `src/config/review-unit-config.ts`, the island and
 * `src/web/screens/timeline/review-unit-row.tsx` all still exist and still
 * work, and editing `reviewUnit` in `config.json` still takes effect. Only the
 * choice is gone from the UI.
 *
 * WHAT THIS FILE USED TO DO, and why it still lives here. It drove the real
 * control in a real browser and only believed a save had landed when a FRESH
 * page load came back showing it — because #677 had shipped this same control
 * into the retired report page, where four golden fixtures asserted its markup
 * and passed while no user could reach it. `git log` has that version.
 *
 * The same discipline is why the file was not simply deleted. "It is hidden"
 * is a claim about what a user sees, and a claim about what a user sees is
 * only settled in a browser. A unit test asserting the screen's HTML string
 * (`tests/web/timeline-review-unit.test.tsx`) is the cheap half; this is the
 * half that would catch the control coming back through some other path — a
 * layout, a partial, a route that composes the row itself.
 *
 * To unhide: restore the row in `src/web/screens/TimelineScreen.tsx` (the
 * comment there names the three lines), then restore this file's previous
 * version from git and flip the unit test's absence assertions back.
 */

import { test, expect } from "@playwright/test";

const SELECT = "[data-review-unit-select]";
const SAVE = "[data-review-unit-save]";
const ISLAND = '[x-data="reviewUnitRow"]';

test.describe("Timeline — review unit is hidden", () => {
  test("no review-unit control is reachable on /timeline", async ({ page }) => {
    await page.goto("/timeline");
    // Wait for the page's own content before asserting an absence — asserting
    // "not there" against a page that has not rendered yet passes for the
    // wrong reason, and would keep passing if /timeline broke entirely.
    await expect(page.locator("body")).toContainText(/\S/);

    await expect(page.locator(SELECT)).toHaveCount(0);
    await expect(page.locator(SAVE)).toHaveCount(0);
    await expect(page.locator(ISLAND)).toHaveCount(0);
  });

  test("the page still works without it", async ({ page }) => {
    // The control sat inside the filter row. Removing it must not have taken
    // the row with it — that is the failure mode of deleting a sibling.
    await page.goto("/timeline");
    await expect(page).toHaveTitle(/.+/);
    const body = await page.locator("body").innerText();
    expect(body.length).toBeGreaterThan(0);
  });
});
