/**
 * chat-agent-chip.spec.ts — the chat panel says which agent answers chat, in a
 * real browser.
 *
 * Before this the panel named the agent only for the seconds another agent's
 * whole reply was pending, and never for claude: after changing agents on the
 * Settings page there was nothing in the panel to check the change against.
 *
 * The agent is set through the real Settings route (a chosen agent is used as
 * it stands, whether or not its command line is installed — so this is the same
 * on a machine with no agent at all).
 */
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test, type Page } from "@playwright/test";
import { E2E_HOME } from "./_setup/honesty-e2e-fixtures";

const CONFIG = join(E2E_HOME, "config.json");
const CHIP = "[data-chat-agent]";

async function choose(page: Page, family: string): Promise<void> {
  const secret = await page.locator("[data-secret]").first().getAttribute("data-secret");
  const res = await page.request.post(`/api/brain/roles/chat`, {
    headers: { "X-Siltpoke-Secret": secret ?? "" },
    data: { family },
  });
  expect(res.ok()).toBe(true);
}

async function openPanel(page: Page): Promise<void> {
  await page.getByRole("button", { name: "Open siltpoke chat" }).click();
  await expect(page.locator(".fc-panel")).toBeVisible();
}

test.describe("Chat panel — which agent answers", () => {
  // The e2e home is shared and the daemon reads config.json per request.
  let before: string | null = null;
  test.beforeAll(() => {
    before = existsSync(CONFIG) ? readFileSync(CONFIG, "utf8") : null;
  });
  test.afterAll(() => {
    if (before === null) rmSync(CONFIG, { force: true });
    else writeFileSync(CONFIG, before);
  });

  test("the chip names the chosen agent, says why, and leads to Settings", async ({ page }) => {
    await page.goto("/settings");
    await choose(page, "qoder");
    await page.goto("/memory");
    await openPanel(page);

    const chip = page.locator(CHIP);
    await expect(chip).toBeVisible();
    await expect(chip).toContainText("qoder");
    await expect(chip).toHaveAttribute("title", /you chose it on the Settings page/);
    await expect(chip).toHaveAttribute("href", "/settings");
  });

  test("a change made while the panel is closed shows the next time it opens — no reload", async ({ page }) => {
    await page.goto("/settings");
    await choose(page, "qoder");
    await page.goto("/memory");
    await openPanel(page);
    await expect(page.locator(CHIP)).toContainText("qoder");

    await page.locator(".fc-panel").getByRole("button", { name: /close/i }).first().click();
    await expect(page.locator(".fc-panel")).toBeHidden();
    await choose(page, "codebuddy");
    await openPanel(page);
    await expect(page.locator(CHIP)).toContainText("codebuddy");
    await expect(page.locator(CHIP)).not.toContainText("qoder");
  });

  test("a change made while the panel is open shows when the next reply ends", async ({ page }) => {
    await page.goto("/settings");
    await choose(page, "codex");
    await page.goto("/memory");
    await openPanel(page);
    await expect(page.locator(CHIP)).toContainText("codex");

    // Changed elsewhere (another tab, the command) with this panel left open.
    await choose(page, "agy");
    const input = page.locator('.fc-panel input[type="text"]');
    await input.fill("hello");
    await input.press("Enter");
    await expect(page.locator(CHIP)).toContainText("agy", { timeout: 10_000 });
    await expect(page.locator(CHIP)).not.toContainText("codex");
  });

  // Any in-app navigation collapses the panel to its launcher by design
  // (floating-chat.ts, `_collapsePanel`); what must survive is the panel's
  // state. A full page load — what this link was before it was boosted — would
  // throw the draft away.
  test("clicking the chip goes to Settings in-app: the draft is still there when the panel is reopened", async ({ page }) => {
    await page.goto("/settings");
    await choose(page, "qoder");
    await page.goto("/memory");
    await openPanel(page);
    const input = page.locator('.fc-panel input[type="text"]');
    await input.fill("half a thought");

    await page.locator(CHIP).click();
    await expect(page).toHaveURL(/\/settings$/);
    await expect(page.locator("[data-agents-bar]")).toBeVisible();
    await openPanel(page);
    await expect(input).toHaveValue("half a thought");
    await expect(page.locator(CHIP)).toContainText("qoder");
  });
});
