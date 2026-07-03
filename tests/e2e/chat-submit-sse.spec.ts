/**
 * chat-submit-sse.spec.ts — verifies that submitting a chat message triggers
 * the SSE pipeline and produces a visible assistant reply in the UI.
 *
 * Requires SILTPOKE_TEST_MOCK_STREAM=1 in the webServer env (set in
 * playwright.config.ts). The mock stream emits "Mock reply from test daemon."
 * deterministically so the assertion below is exact rather than permissive.
 */

import { test, expect } from "@playwright/test";

test("chat submit triggers POST /api/chat and renders assistant reply", async ({ page }) => {
  await page.goto("/chat");

  const textbox = page.getByRole("textbox");
  await expect(textbox).toBeVisible({ timeout: 10_000 });

  // Wait for Alpine to fully initialize the chatStream island.
  // Alpine evaluates x-bind:disabled="streaming || !input.trim()" —
  // once it has initialized, the button is disabled (empty input).
  const sendBtn = page.getByRole("button", { name: /send/i });
  await expect(sendBtn).toBeDisabled({ timeout: 10_000 });

  // Fill and explicitly dispatch an input event to ensure Alpine x-model picks up the value.
  await textbox.fill("hi");
  await page.evaluate(() => {
    const ta = document.querySelector<HTMLTextAreaElement>("textarea");
    if (ta) ta.dispatchEvent(new Event("input", { bubbles: true }));
  });

  // Alpine should now enable the Send button.
  await expect(sendBtn).toBeEnabled({ timeout: 5_000 });

  // Submit the form (triggers x-on:submit handler which calls send()).
  await page.locator(".chat-composer").evaluate((form: HTMLFormElement) => {
    form.dispatchEvent(new SubmitEvent("submit", { bubbles: true, cancelable: true }));
  });

  // After submit, the mock daemon streams "Mock reply from test daemon." via SSE.
  // Alpine's x-for renders it inside .chat-history once message_stop fires.
  // Fx-14: assert the specific assistant text, not just any word.
  const chatHistory = page.locator(".chat-history");
  await expect(chatHistory).toContainText("Mock reply from test daemon.", { timeout: 10_000 });
});
