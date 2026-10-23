/**
 * The Timeline rail runs to the bottom of the master/detail box and its
 * pager (prev / next) is pinned under the scrolling list, so prev/next are
 * always in view. #1025 had made the rail end after its last row, which left
 * the box's frame running on empty below it;
 * the chosen layout is "12 a page + pager pinned at the bottom".
 */
import { expect, test, type Page } from "@playwright/test";
import type { RestoreFn } from "./_setup/honesty-e2e-fixtures";
import {
  CSH_TIMELINE_BUBBLE_PREFIX,
  CSH_TIMELINE_ROWS,
  seedChatStreamHardeningFixtures,
} from "./_setup/chat-stream-hardening-fixtures";

let restore: RestoreFn | null = null;

test.beforeAll(async () => {
  restore = await seedChatStreamHardeningFixtures();
});

test.afterAll(async () => {
  await restore?.();
  restore = null;
});

async function openTimeline(page: Page): Promise<void> {
  await page.goto("/timeline?range=7d");
  await expect(
    page.locator(".tl-rail").getByText(`${CSH_TIMELINE_BUBBLE_PREFIX} ${CSH_TIMELINE_ROWS}`).first(),
  ).toBeVisible({ timeout: 10_000 });
}

/** Rail box, its scroll area, the box that holds rail + dossier, and the scroll area's content height. */
async function measure(page: Page) {
  return page.evaluate(() => {
    const rail = document.querySelector(".tl-rail") as HTMLElement;
    const scroll = rail.querySelector(".tl-scroll") as HTMLElement;
    const box = rail.parentElement as HTMLElement;
    const r = rail.getBoundingClientRect();
    const b = box.getBoundingClientRect();
    return {
      railBottom: r.bottom,
      boxBottom: b.bottom,
      boxTop: b.top,
      scrollClient: scroll.clientHeight,
      scrollContent: scroll.scrollHeight,
    };
  });
}

test("timeline rail reaches the bottom of the box, pager pinned and in view", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 1600 });
  await openTimeline(page);
  const m = await measure(page);
  // Full height even though the page of 12 fits: no frame running on empty.
  expect(Math.abs(m.boxBottom - m.railBottom)).toBeLessThanOrEqual(2);
  const pager = page.locator(".tl-rail > .tl-pager");
  await expect(pager).toBeInViewport();
  // The pager is the rail's last child, outside the scrolling list.
  await expect(page.locator(".tl-rail .tl-scroll .tl-pager")).toHaveCount(0);
});

test("in a short window the list scrolls and the pager stays in view without scrolling", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 700 });
  await openTimeline(page);
  const m = await measure(page);
  expect(m.railBottom).toBeLessThanOrEqual(m.boxBottom + 1);
  expect(m.scrollContent).toBeGreaterThan(m.scrollClient);
  // No scrolling of the list needed to reach Next.
  await expect(page.locator(".tl-load-older")).toBeInViewport();
  const scrollTop = await page.evaluate(() => (document.querySelector(".tl-rail .tl-scroll") as HTMLElement).scrollTop);
  expect(scrollTop).toBe(0);
});
