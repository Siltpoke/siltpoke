/**
 * Pick chat's agent from inside the chat (plan 2026-10-14
 * settings-real-and-chat-agent, Task 2; spec agent-in-use-truth §11.1).
 *
 * Two agents installed, none chosen: the first POST /api/chat answers
 * `choose_provider` with the agents found. The card shows one button per agent;
 * a click saves `brain.roles.chat` and sends the same message once more. Both
 * endpoints are stubbed with page.route — the island logic is unit-tested in
 * tests/web/client/islands/floating-chat-choose.test.ts; this proves the
 * buttons render and are wired.
 */
import { expect, type Page, type Request, type Route, test } from "@playwright/test";

async function openPanel(page: Page) {
  const launcher = page.getByRole("button", { name: "Open siltpoke chat" });
  await expect(launcher).toBeVisible({ timeout: 10_000 });
  await launcher.click();
  await expect(page.locator(".fc-panel")).toBeVisible({ timeout: 5_000 });
}

async function composerSend(page: Page, text: string) {
  const input = page.locator(".fc-panel input[type=text]");
  await input.fill(text);
  await page.evaluate(() => {
    const el = document.querySelector<HTMLInputElement>(".fc-panel input[type=text]");
    if (el) el.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await expect(page.locator(".fc-panel button[type=submit]")).toBeEnabled({ timeout: 5_000 });
  await page.locator(".fc-panel form").evaluate((f: HTMLFormElement) => {
    f.dispatchEvent(new SubmitEvent("submit", { bubbles: true, cancelable: true }));
  });
}

function sse(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

async function stubChat(page: Page, rolesStatus: number) {
  const chatBodies: string[] = [];
  const roleBodies: string[] = [];
  await page.route("**/api/chat", async (route: Route, req: Request) => {
    if (req.method() !== "POST") {
      await route.continue();
      return;
    }
    chatBodies.push(req.postData() ?? "");
    const body =
      chatBodies.length === 1
        ? sse("error", { reason: "choose_provider", error: "x", found: ["codex", "qoder"] })
        : sse("content_block_delta", { text: "hello from qoder" });
    await route.fulfill({ status: 200, contentType: "text/event-stream", body });
  });
  await page.route("**/api/brain/roles/chat", async (route: Route, req: Request) => {
    roleBodies.push(req.postData() ?? "");
    await route.fulfill({
      status: rolesStatus,
      contentType: "application/json",
      body: JSON.stringify(rolesStatus === 200 ? { ok: true } : { error: "boom" }),
    });
  });
  return { chatBodies, roleBodies };
}

test("two agents found → a button each; picking one saves it and resends once", async ({ page }) => {
  const { chatBodies, roleBodies } = await stubChat(page, 200);
  await page.goto("/");
  await openPanel(page);
  await composerSend(page, "what does this do?");

  const picker = page.locator("[data-testid=chat-pick-agent]:visible");
  await expect(picker).toBeVisible({ timeout: 10_000 });
  await expect(picker.getByRole("button")).toHaveText(["codex", "qoder"]);

  await picker.getByRole("button", { name: "qoder" }).click();

  await expect(page.locator(".fc-panel")).toContainText("hello from qoder", { timeout: 10_000 });
  expect(roleBodies.map((b) => JSON.parse(b))).toEqual([{ family: "qoder" }]);
  expect(chatBodies).toHaveLength(2);
  expect(JSON.parse(chatBodies[1]!).message).toBe("what does this do?");
  await expect(page.locator("[data-testid=chat-pick-agent]:visible")).toHaveCount(0);
  await expect(page.locator(".fc-panel").getByText("what does this do?", { exact: true }).filter({ visible: true })).toHaveCount(1);
});

test("saving the pick fails → card stays with the Settings-page sentence", async ({ page }) => {
  const { chatBodies } = await stubChat(page, 500);
  await page.goto("/");
  await openPanel(page);
  await composerSend(page, "what does this do?");

  const picker = page.locator("[data-testid=chat-pick-agent]:visible");
  await picker.getByRole("button", { name: "codex" }).click();

  await expect(page.locator(".fc-panel")).toContainText("could not save — set it on the Settings page");
  expect(chatBodies).toHaveLength(1);
});
