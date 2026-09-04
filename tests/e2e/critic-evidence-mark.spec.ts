/**
 * critic-evidence-mark.spec.ts — the "unconfirmed" strip on a review whose
 * citations could not be checked actually reaches a browser.
 *
 * Why this file exists. On 2026-08-19 the evidence guard stopped deleting
 * reviews it could not verify and started showing them. That trade is only
 * safe while the reader can see WHICH reviews were checked; a review shown
 * without its caveat is worse than the review that used to be deleted,
 * because it looks confirmed.
 *
 * Every other test for the mark is structurally blind to the failure that
 * would cause that. The component test drives the function directly; the
 * detail-pane test asserts a substring of an SSR string. Both pass against a
 * page where the strip is present in the DOM and invisible — the exact way a
 * marker in this repo shipped before (`display:none` + an island that never
 * registered, three green layers, caught only by a real browser).
 *
 * So the load-bearing assertion here is `toBeVisible`, and the second one is
 * that the count on screen equals the count the fixture seeded — "some text is
 * present" would pass against a hardcoded string.
 */
import { expect, test } from "@playwright/test";
import type { RestoreFn } from "./_setup/honesty-e2e-fixtures";
import {
  seedTimelineFixtures,
  TL_BUBBLE,
  TL_CRITIQUE_TEXT,
  TL_UNVERIFIED_COUNT,
} from "./_setup/timeline-e2e-fixtures";

let restore: RestoreFn | null = null;

test.beforeAll(async () => {
  restore = await seedTimelineFixtures();
});

test.afterAll(async () => {
  await restore?.();
  restore = null;
});

test("a review with dropped citations shows the unconfirmed strip, above the review", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto("/timeline?q=E2E-TL");

  // Precondition: the seeded turn really is on screen. Without this the
  // assertions below could be passing against an empty page.
  await expect(page.getByText(TL_BUBBLE).first()).toBeVisible({ timeout: 10_000 });

  const mark = page.locator('[data-evidence-mark="partly_unverified"]').first();

  // THE assertion. A present-but-hidden strip fails here and nowhere else.
  await expect(mark).toBeVisible({ timeout: 10_000 });

  // It says what happened, with the seeded count — not a hardcoded number.
  await expect(mark).toContainText("unconfirmed");
  await expect(mark).toContainText(`${TL_UNVERIFIED_COUNT} quotes`);
  await expect(mark).toHaveAttribute("data-unverified-count", String(TL_UNVERIFIED_COUNT));

  // And the review it is marking is visible too — the whole point of the
  // change is that this text is no longer thrown away.
  const review = page.getByText(TL_CRITIQUE_TEXT).first();
  await expect(review).toBeVisible({ timeout: 10_000 });

  // The caveat is above the review, in real laid-out geometry rather than in
  // source order — a reader who stops after the first paragraph must have met
  // it. Source-order was already checked in the SSR test; CSS can undo that.
  const markBox = await mark.boundingBox();
  const reviewBox = await review.boundingBox();
  expect(markBox, "mark has no layout box").not.toBeNull();
  expect(reviewBox, "review has no layout box").not.toBeNull();
  expect(markBox!.y).toBeLessThan(reviewBox!.y);
});

test("a review with no caveat renders no strip at all", async ({ page }) => {
  // Negative control on a REAL page. Without it, a mark that rendered on every
  // row would satisfy the test above while making the caveat meaningless.
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto("/timeline?q=config%20verifier");

  await expect(page.getByText("config verifier misses").first()).toBeVisible({ timeout: 10_000 });
  await expect(page.locator("[data-evidence-mark]")).toHaveCount(0);
});
