/**
 * chat-stream-hardening-screenshots.spec.ts — full-page PNG captures of the
 * chat-stream hardening surfaces into test-screenshots/, numbered
 * by user flow. Runs ON GREEN: each test asserts its precondition really
 * holds before snapping, so a capture is evidence, never a decoration.
 *
 *   csh-01 — floating chat: persisted FAILED turn renders the pet-voice
 *            error card (fixed timeout copy, never the raw server error)
 *   csh-02 — /chat: Stop control (■) visible mid-stream. The in-flight turn
 *            is held open by stalling POST /api/chat at the network layer
 *            (Playwright route that never fulfills) — a controllable hanging
 *            backend, so this is a REAL mid-stream shot, not a substitution.
 *            After the capture the same test clicks Stop and asserts the
 *            live cancel path (quiet marker, no error copy).
 *   csh-03 — floating chat: persisted CANCELLED turn from history renders
 *            the quiet stopped marker; its partial content never displays
 *   csh-04 — Home: capped action-XP badge ("+100 today · capped")
 *   csh-05 — /timeline?range=7d with more range-passing rows than one
 *            window: active range filter + Load-older control
 *
 * Fixture data is seeded into the shared e2e SILTPOKE_HOME at spec start and
 * fully restored at the end (see _setup/chat-stream-hardening-fixtures.ts).
 * Expected copy is imported from the production reason→copy map so the
 * assertions can never drift from what ships.
 */

import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { expect, test, type Page, type Route } from "@playwright/test";
import {
  CHAT_ERROR_COPY,
  CHAT_STOPPED_MARKER,
} from "../../src/web/client/lib/chat-error-copy";
import { ACTION_XP_DAILY_CAP } from "../../src/state/progression";
import type { RestoreFn } from "./_setup/honesty-e2e-fixtures";
import {
  CSH_FAIL_OK_REPLY,
  CSH_FAIL_TITLE,
  CSH_STOP_PARTIAL,
  CSH_STOP_TITLE,
  CSH_TIMELINE_BUBBLE_PREFIX,
  CSH_TIMELINE_ROWS,
  seedChatStreamHardeningFixtures,
} from "./_setup/chat-stream-hardening-fixtures";

const OUT_DIR = join(process.cwd(), "test-screenshots");

let restore: RestoreFn | null = null;

test.beforeAll(async () => {
  await mkdir(OUT_DIR, { recursive: true });
  restore = await seedChatStreamHardeningFixtures();
});

test.afterAll(async () => {
  await restore?.();
  restore = null;
});

test.beforeEach(async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 820 });
});

// ── helpers ──────────────────────────────────────────────────────────────────

/** Open the floating chat panel from any dashboard page. */
async function openPanel(page: Page) {
  const launcher = page.getByRole("button", { name: "Open siltpoke chat" });
  await expect(launcher).toBeVisible({ timeout: 10_000 });
  await launcher.click();
  await expect(page.locator(".fc-panel")).toBeVisible({ timeout: 5_000 });
}

/** Open a seeded conversation from the floating chat's history dropdown. */
async function openFromHistory(page: Page, title: string) {
  await page.locator('.fc-panel button[title="Past chats"]').click();
  const row = page.locator(".fc-panel").getByText(title).first();
  await expect(row).toBeVisible({ timeout: 10_000 });
  await row.click();
}

/**
 * Fill + submit the /chat composer. Alpine's x-model requires an `input`
 * event; the form's x-on:submit handler calls send().
 */
async function chatPageSend(page: Page, text: string) {
  const textarea = page.locator(".chat-composer textarea");
  await expect(textarea).toBeVisible({ timeout: 10_000 });
  await textarea.fill(text);
  await page.evaluate(() => {
    const ta = document.querySelector<HTMLTextAreaElement>(".chat-composer textarea");
    if (ta) ta.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await expect(page.locator('.chat-composer button[type="submit"]')).toBeEnabled({
    timeout: 5_000,
  });
  await page.locator(".chat-composer").evaluate((form: HTMLFormElement) => {
    form.dispatchEvent(new SubmitEvent("submit", { bubbles: true, cancelable: true }));
  });
}

// ── captures ─────────────────────────────────────────────────────────────────

test("csh-01 — failed turn renders the pet-voice error card", async ({ page }) => {
  await page.goto("/");
  await openPanel(page);
  await openFromHistory(page, CSH_FAIL_TITLE);
  const panel = page.locator(".fc-panel");
  // The persisted failed row (content "", error_reason "timeout") renders the
  // FIXED timeout copy — never a blank bubble, never the raw server string.
  // filter({visible:true}): the row template keeps every entry-kind branch in
  // the DOM (x-show), so match the on-screen one.
  await expect(
    panel.getByText(CHAT_ERROR_COPY.timeout).filter({ visible: true }).first(),
  ).toBeVisible({ timeout: 10_000 });
  // The preceding ok turn renders as a normal bubble (card vs bubble contrast).
  await expect(
    panel.getByText(CSH_FAIL_OK_REPLY).filter({ visible: true }).first(),
  ).toBeVisible();
  await page.screenshot({
    path: join(OUT_DIR, "csh-01-chat-error-card.png"),
    fullPage: true,
  });
});

test("csh-02 — Stop control visible mid-stream; stop yields the quiet marker", async ({
  page,
}) => {
  // Hold the turn open: POST /api/chat is stalled at the network layer (the
  // route never fulfills), so `streaming` stays true for a real mid-stream
  // capture. GETs pass through untouched.
  const stalledRoutes: Route[] = [];
  await page.route("**/api/chat", async (route) => {
    if (route.request().method() === "POST") {
      stalledRoutes.push(route); // deliberately never fulfilled
      return;
    }
    await route.continue();
  });

  await page.goto("/chat");
  await chatPageSend(page, "tell me about the retry helper");

  const stopBtn = page.getByRole("button", { name: "■ Stop" });
  await expect(stopBtn).toBeVisible({ timeout: 10_000 });
  await expect(
    page.locator(".chat-history").getByText("tell me about the retry helper"),
  ).toBeVisible();
  await page.screenshot({
    path: join(OUT_DIR, "csh-02-stop-button-midstream.png"),
    fullPage: true,
  });

  // Live cancel path (assertion-only; the persisted render is csh-03): the
  // stop is a user action, not a failure — quiet marker, no error copy.
  await stopBtn.click();
  await expect(
    page.locator(".chat-history").getByText(CHAT_STOPPED_MARKER, { exact: true }),
  ).toBeVisible({ timeout: 5_000 });
  await expect(stopBtn).toBeHidden();
  await expect(page.locator(".chat-error")).toBeHidden();
  // Cleanup the stalled route (the client already aborted its fetch).
  for (const route of stalledRoutes) await route.abort().catch(() => {});
});

test("csh-03 — cancelled turn from history renders the quiet stopped marker", async ({
  page,
}) => {
  await page.goto("/");
  await openPanel(page);
  await openFromHistory(page, CSH_STOP_TITLE);
  const panel = page.locator(".fc-panel");
  // filter({visible:true}): the hidden entry-kind branches (x-show) also carry
  // m.text — assert on the on-screen cancelled marker.
  await expect(
    panel.getByText(CHAT_STOPPED_MARKER, { exact: true }).filter({ visible: true }).first(),
  ).toBeVisible({ timeout: 10_000 });
  // Honesty: the partial content persisted on the cancelled row is never shown.
  await expect(panel.getByText(CSH_STOP_PARTIAL)).toHaveCount(0);
  await page.screenshot({
    path: join(OUT_DIR, "csh-03-stopped-marker-history.png"),
    fullPage: true,
  });
});

test("csh-04 — Home capped action-XP badge", async ({ page }) => {
  await page.goto("/");
  const badge = page.locator(".stats-panel__xp-today");
  await badge.scrollIntoViewIfNeeded();
  // The badge reads the awarded ledger (action_xp), seeded exactly at the cap.
  await expect(badge).toHaveText(`+${ACTION_XP_DAILY_CAP} today · capped`);
  await page.screenshot({
    path: join(OUT_DIR, "csh-04-home-xp-capped.png"),
    fullPage: true,
  });
});

test("csh-05 — /timeline range=7d with Load-older control", async ({ page }) => {
  await page.goto("/timeline?range=7d");
  // Newest seeded row really rendered under the active 7d range.
  await expect(
    page
      .locator(".tl-rail")
      .getByText(`${CSH_TIMELINE_BUBBLE_PREFIX} ${CSH_TIMELINE_ROWS}`)
      .first(),
  ).toBeVisible({ timeout: 10_000 });
  // Load-older control present because the window (limit 20) has more
  // range-passing rows behind it; its href carries the active range AND the
  // exclusive `before` anchor.
  const older = page.locator(".tl-load-older");
  await expect(older).toHaveAttribute("href", /range=7d/);
  await expect(older).toHaveAttribute("href", /before=/);
  await older.scrollIntoViewIfNeeded();
  await expect(older).toBeVisible();
  await page.screenshot({
    path: join(OUT_DIR, "csh-05-timeline-7d-load-older.png"),
    fullPage: true,
  });
});
