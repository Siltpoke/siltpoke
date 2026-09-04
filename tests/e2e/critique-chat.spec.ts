/**
 * Playwright spec for the critique-anchored floating chat (critique-chat
 * S1, Task 6). Mirrors `tests/e2e/floating-chat.spec.ts`'s daemon/fixture
 * setup (mocked SSE stream via `SILTPOKE_TEST_MOCK_STREAM=1`, same
 * `.fc-panel` selectors) but drives the FULL journey through a real page:
 *
 *   seed a fired critique (tests/e2e/_setup/timeline-e2e-fixtures.ts, the
 *   same seeder trace-history-merge-screenshots.spec.ts uses for /timeline)
 *   → navigate to /timeline → select the review card in the rail
 *   → click "chat about this review" → the floating chat opens ANCHORED
 *     (pin bar shows the critique label) → send a question → a streamed
 *     assistant reply appears.
 *
 * The mock stream flag replaces only the `claude -p` subprocess (same as
 * every other e2e spec against this daemon) — the critique RESOLVE chain
 * (resolveCritiqueAnchorImpl → resolveCritiqueContext → readCriticTelemetry
 * against the real seeded brain-calls.jsonl → writeAnchorContext →
 * readAnchorContext → composeBaseSystemPrompt) is the REAL production path,
 * exercised through the browser via the real daemon. The acceptance test
 * (tests/acceptance/critique-chat.acceptance.test.ts) proves that chain at
 * the HTTP layer with an assertion on the injected systemPrompt; this spec
 * proves the DOM+async layer on top of it (button visibility, panel open,
 * pin-bar label, composer→SSE→render) that unit/acceptance tests cannot
 * reach (a missing data attribute, an Alpine x-show race, a click-delegation
 * miss on a boosted /timeline navigation).
 */

import { expect, test } from "@playwright/test";
import { seedTimelineFixtures, TL_BUBBLE, TL_CRITIQUE_ID } from "./_setup/timeline-e2e-fixtures";

let restoreFixtures: (() => Promise<void>) | null = null;

test.beforeAll(async () => {
  restoreFixtures = await seedTimelineFixtures();
});

test.afterAll(async () => {
  if (restoreFixtures) await restoreFixtures();
});

test(
  // what this guarantees: opening a fired review in the Timeline and
  // clicking "chat about this review" opens a floating chat ANCHORED to
  // that critique (pin bar shows the critique label), and a sent question
  // gets a streamed reply — the full click-path journey a user takes.
  "Timeline: select a review, chat about it, get a grounded streamed reply",
  async ({ page }) => {
    await page.goto("/timeline");

    // The seeded newest fired turn (critique_id=TL_CRITIQUE_ID) is the
    // default-sorted (newest-first) first row — its detail pane is
    // server-rendered pre-selected. Still explicitly click the rail row to
    // exercise the real selection path (mirrors a user who scrolled/filtered
    // before landing on this review).
    const railRow = page.locator(".tl-row", { hasText: TL_BUBBLE });
    await expect(railRow).toBeVisible({ timeout: 10_000 });
    await railRow.click();

    // The detail pane's "chat about this review" trigger — rendered only
    // when the row carries a critique_id (data-critique-id on the button).
    const chatButton = page.locator(
      `[data-siltpoke-critique-chat][data-critique-id="${TL_CRITIQUE_ID}"]`,
    );
    await expect(chatButton).toBeVisible({ timeout: 10_000 });
    await chatButton.click();

    // The floating chat panel opens directly (openCritiqueChat sets
    // open=true) — no launcher click needed for this trigger path.
    const panel = page.locator(".fc-panel");
    await expect(panel).toBeVisible({ timeout: 5_000 });

    // Anchored: the pin bar (x-show="active()") shows the critique label
    // ("review · <critique_id>") — proves the conversation is pinned to
    // THIS critique, not a generic/unanchored chat.
    const pinBar = page.locator(".fc-panel [x-show='active()']").first();
    await expect(pinBar).toBeVisible({ timeout: 5_000 });
    await expect(pinBar).toContainText(`review · ${TL_CRITIQUE_ID}`);

    // Send a question about the review.
    const input = page.locator(".fc-panel input[type=text]");
    await input.fill("why did you flag this?");
    await page.evaluate(() => {
      const el = document.querySelector<HTMLInputElement>(".fc-panel input[type=text]");
      if (el) el.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await expect(page.locator(".fc-panel button[type=submit]")).toBeEnabled({ timeout: 5_000 });
    const form = page.locator(".fc-panel form");
    await form.evaluate((f: HTMLFormElement) => {
      f.dispatchEvent(new SubmitEvent("submit", { bubbles: true, cancelable: true }));
    });

    // A streamed assistant reply appears (mock daemon streams "Mock reply
    // from test daemon." — SILTPOKE_TEST_MOCK_STREAM=1 replaces only the
    // `claude -p` subprocess; the critique resolve→freeze→inject chain
    // upstream of it is the real production path against the seeded
    // brain-calls.jsonl).
    const msgBody = page.locator(".fc-panel .min-h-0.overflow-y-auto");
    await expect(msgBody).toContainText("Mock reply from test daemon.", { timeout: 10_000 });

    // No terminal/blocked signal — a broken resolve chain would have
    // returned {blocked:"critique_gone"} instead of streaming.
    await expect(page.locator(".fc-panel [x-show='terminalCta != null']")).toBeHidden();
    await expect(page.locator(".fc-panel [x-show='blockedCta !== null']")).toBeHidden();
  },
);
