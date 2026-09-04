/**
 * timeline-review-unit.spec.ts — the ⏱ review-unit control, end to end.
 *
 * THIS IS THE ASSERTION THE PREVIOUS ROUND COULD NOT MAKE. #677 shipped a
 * `reviewUnit` `<select>` into `src/cli/report-artifacts.ts` — the retired
 * tamagotchi report page (`src/daemon/server.ts`: "its legacy GET /dashboard
 * report page is retired"; `buildReport` has no caller in `src/`). Four
 * golden fixtures asserted that select's HTML and passed, while no user
 * could reach the control and nothing wrote `reviewUnit` from a browser. The
 * obvious second home, `/settings`, is unmounted too (server.ts, 2026-08-06),
 * so this control now lives on `/timeline` — a path in the nav, which is the
 * only kind of "shipped" that this defect distinguishes from.
 *
 * So a markup assertion is explicitly NOT what this file does. It drives the
 * served page in a real browser and only believes the setting landed when a
 * FRESH page load — a new request, a new read of config.json — comes back
 * showing it. That is the only evidence a viewer's click reached disk
 * (memory `stubbed-writer-proves-nothing-about-disk`).
 *
 * Runs against the e2e daemon's own SILTPOKE_HOME (./.playwright-tmp/siltpoke),
 * so it writes a real config.json but never the developer's. It restores
 * `commit` at the end because the specs share one daemon and one config file.
 */

import { test, expect } from "@playwright/test";

const SELECT = "[data-review-unit-select]";
const SAVE = "[data-review-unit-save]";

async function selectedUnit(page: import("@playwright/test").Page): Promise<string> {
  return page.locator(SELECT).inputValue();
}

test.describe("Timeline — review unit", () => {
  test.beforeAll(async ({ browser }) => {
    // ESTABLISH the starting state; do not assume it. The three tests share
    // one daemon and one gitignored `./.playwright-tmp/siltpoke/config.json`
    // that PERSISTS between local runs, so an interrupted run (Ctrl-C, a
    // webServer timeout, a crash between the save and the teardown) leaves
    // `pr` on disk and the next run fails on a precondition rather than on
    // the code. The `commit`-is-unchanged assertion in the 401 test is only
    // evidence if `commit` was actually the starting value.
    const page = await browser.newPage();
    await page.goto("/timeline");
    if ((await page.locator(SELECT).inputValue()) !== "commit") {
      await page.selectOption(SELECT, "commit");
      await page.click(SAVE);
      await expect(page.locator(SAVE)).toContainText("Saved ✓");
    }
    await page.close();
  });

  test.afterEach(async ({ page }) => {
    // Leave the shared config on the default. Done through the UI on purpose:
    // if the control were broken, this teardown would fail too rather than
    // quietly papering over the state it left behind.
    await page.goto("/timeline");
    if ((await selectedUnit(page)) !== "commit") {
      await page.selectOption(SELECT, "commit");
      await page.click(SAVE);
      await expect(page.locator(SAVE)).toContainText("Saved ✓");
    }
  });

  test("the control is on the served page, not only in a fixture", async ({ page }) => {
    await page.goto("/timeline");
    const select = page.locator(SELECT);
    await expect(select).toBeVisible();
    // Exactly the two live units — the four dead trigger modes must not be
    // offered as choices anywhere a user can click.
    await expect(select.locator("option")).toHaveCount(2);
    await expect(select.locator("option")).toHaveText(["commit", "pr"]);
  });

  test("choosing pr and saving survives a fresh page load", async ({ page }) => {
    await page.goto("/timeline");
    await expect(page.locator(SELECT)).toHaveValue("commit");

    await page.selectOption(SELECT, "pr");
    await page.click(SAVE);
    await expect(page.locator(SAVE)).toContainText("Saved ✓");
    // `toHaveText("")`, not `toBeHidden()`: the span renders empty, so a page
    // with a DEAD bundle has a zero-size box that Playwright also calls
    // hidden — an assertion that cannot tell "no error" from "Alpine never
    // ran" carries no information.
    await expect(page.locator("[data-review-unit-error]")).toHaveText("");

    // The point of the whole spec: a NEW request re-reads config.json from
    // disk. An island that only updated its own state would pass every
    // assertion above and fail here.
    await page.reload();
    await expect(page.locator(SELECT)).toHaveValue("pr");
  });

  test("an unauthenticated POST cannot change the review unit", async ({ page }) => {
    // POST /api/config says "Fail CLOSED" in its own comment and nothing
    // asserted it — a blind cross-origin POST that could flip the review unit
    // to `pr` would silence reviews on every branch without a PR. The write
    // path this slice just opened is exactly why the gate now gets a test.
    const res = await page.request.post("/api/config", {
      headers: { "content-type": "application/json" },
      data: { reviewUnit: "pr" },
      failOnStatusCode: false,
    });
    expect(res.status()).toBe(401);

    // And it really did not land — the refusal is the fact, the unchanged
    // page is the evidence.
    await page.goto("/timeline");
    await expect(page.locator(SELECT)).toHaveValue("commit");
  });
});
