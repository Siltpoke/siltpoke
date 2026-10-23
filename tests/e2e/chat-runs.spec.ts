/**
 * Chat Runs window in a real browser (spec 2026-10-13-agent-in-use-truth §10.1).
 *
 * The test daemon's mock stream (SILTPOKE_TEST_MOCK_STREAM=1) goes through the
 * real chat route, so a real record is written — with no CLI output, since the
 * mock prints none. Test 1 asserts that state. Test 2 stubs the records route
 * with a full claude record to check the steps a real call shows.
 */
import { expect, type Page, test } from "@playwright/test";

async function openNewChat(page: Page): Promise<void> {
  await page.goto("/");
  const launcher = page.getByRole("button", { name: "Open siltpoke chat" });
  await expect(launcher).toBeVisible({ timeout: 10_000 });
  await launcher.click();
  await expect(page.locator(".fc-panel")).toBeVisible({ timeout: 5_000 });
  await page.locator('.fc-panel button[title="New chat"]').click();
}

async function send(page: Page, text: string): Promise<void> {
  const input = page.locator(".fc-panel input[type=text]");
  await input.fill(text);
  await input.dispatchEvent("input");
  await expect(page.locator(".fc-panel button[type=submit]")).toBeEnabled({ timeout: 5_000 });
  // Take the conversation's id from the response headers, before waiting for
  // the reply: a test that fails while waiting still has its conversation
  // deleted (review round 3).
  const response = page.waitForResponse((r) => r.url().endsWith("/api/chat") && r.request().method() === "POST");
  await page.locator(".fc-panel form").evaluate((f: HTMLFormElement) => {
    f.dispatchEvent(new SubmitEvent("submit", { bubbles: true, cancelable: true }));
  });
  const id = (await response).headers()["x-siltpoke-session-id"];
  if (id) created.push(id);
  // The delete in afterEach needs the dashboard secret (#1064); the page carries it.
  secret = (await page.locator("[data-secret]").first().getAttribute("data-secret")) ?? "";
  await expect(page.locator(".fc-panel")).toContainText("Mock reply from test daemon.", { timeout: 10_000 });
}

// The test daemon's home is shared by every spec. Conversations made here
// would push memory-book.spec's seeded one out of the "Cross-chat recall · 5"
// rail (found by ci:local:linux, 2026-10-16), so each one is deleted after.
const created: string[] = [];
let secret = "";
test.afterEach(async ({ request }) => {
  for (const id of created.splice(0)) {
    const res = await request.delete(`/api/chat/sessions/${id}`, { headers: { "X-Siltpoke-Secret": secret } });
    expect(res.ok()).toBe(true);
  }
});

test("Runs opens beside the chat and lists this conversation's call; answer and row highlight each other", async ({ page }) => {
  await openNewChat(page);
  await send(page, "what is this page?");

  const answer = page.locator(".fc-chat [data-msg-id]", { hasText: "Mock reply from test daemon." });
  await expect(answer).toHaveCount(1);
  // Bubbles carry a time, not a model label.
  await expect(answer.locator(".fc-msg-at")).toHaveText(/^\d\d:\d\d:\d\d$/);

  // The corner chat is 530 wide, with Runs closed and open alike.
  expect(Math.round((await page.locator(".fc-chat").boundingBox())?.width ?? 0)).toBe(530);

  await page.getByTestId("chat-runs-button").click();
  const runs = page.locator("aside.fc-runs");
  await expect(runs).toBeVisible();
  await expect(runs.locator("[data-runs-sub]")).toHaveText("This conversation · 1 call");
  const row = runs.locator(".cr-run");
  await expect(row).toHaveCount(1);
  await expect(row.locator(".cr-l1")).toContainText("#1");

  // Same height, Runs at its 340 px default, the chat still 530.
  const [chatBox, runsBox] = await Promise.all([page.locator(".fc-chat").boundingBox(), runs.boundingBox()]);
  expect(Math.round(runsBox?.width ?? 0)).toBe(340);
  expect(Math.round(chatBox?.width ?? 0)).toBe(530);
  expect(Math.round(runsBox?.height ?? 0)).toBe(Math.round(chatBox?.height ?? -1));

  // The mock prints no CLI output: the record says so instead of showing nothing.
  await row.getByRole("button", { name: "Open all steps" }).click();
  await expect(row).toContainText("No output captured");

  // Answer → row, row → answer. Selecting must not close what is open.
  await answer.click();
  await expect(row).toHaveClass(/cr-sel/);
  await expect(answer).toHaveClass(/fc-msg-sel/);
  await expect(row.locator(".cr-evd[open]").first()).toBeVisible();

  // Maximized: the chat is 800 wide, Runs still 340 — and still 800 once Runs closes.
  await page.getByRole("button", { name: "Expand chat" }).click();
  await expect(page.locator(".fc-chat")).toHaveJSProperty("offsetWidth", 800);
  expect(Math.round((await runs.boundingBox())?.width ?? 0)).toBe(340);

  // No ✕ in the pane: the header's Runs button closes it.
  await expect(runs.locator(".fc-runs-head button")).toHaveCount(0);
  await page.getByTestId("chat-runs-button").click();
  await expect(runs).toBeHidden();
  await expect(page.locator(".fc-chat")).toHaveJSProperty("offsetWidth", 800);
});

test("history opens as a pane left of the chat, from the clock button only", async ({ page }) => {
  await openNewChat(page);
  await send(page, "first history question");
  await page.locator('.fc-panel button[title="New chat"]').click();
  await send(page, "second history question");

  const clock = page.locator('.fc-panel button[title="Past chats"]');
  const pane = page.getByTestId("chat-history-pane");
  await expect(pane).toBeHidden();
  await clock.click();
  await expect(pane).toBeVisible();
  await expect(clock).toHaveAttribute("aria-expanded", "true");
  await expect(clock).toHaveCSS("border-left-color", await page.evaluate(() => {
    const probe = document.createElement("div");
    probe.style.color = "var(--color-sky)";
    document.body.append(probe);
    const c = getComputedStyle(probe).color;
    probe.remove();
    return c;
  }));

  // Left of the chat, 240 wide, and the chat keeps its 530.
  const [paneBox, chatBox] = await Promise.all([pane.boundingBox(), page.locator(".fc-chat").boundingBox()]);
  expect(Math.round(paneBox?.width ?? 0)).toBe(241); // 240 + the 1 px line
  expect(Math.round(chatBox?.width ?? 0)).toBe(530);
  expect((paneBox?.x ?? 0) + (paneBox?.width ?? 0)).toBeLessThanOrEqual((chatBox?.x ?? 0) + 0.5);

  // Both conversations are listed under Today; picking one keeps the pane open.
  await expect(pane.locator(".fc-hist-g").first()).toHaveText("Today");
  const first = pane.getByRole("button", { name: /first history question/ });
  await first.click();
  await expect(pane).toBeVisible();
  await expect(pane.locator(".fc-hist-on")).toContainText("first history question");
  await expect(page.locator(".fc-chat")).toContainText("first history question");

  // The clock closes it; the chat stays 530.
  await clock.click();
  await expect(pane).toBeHidden();
  await expect(clock).toHaveAttribute("aria-expanded", "false");
  await expect(page.locator(".fc-chat")).toHaveJSProperty("offsetWidth", 530);
});

test("a full claude record shows the trace, the tool call with what it got back, and the raw line", async ({ page }) => {
  await openNewChat(page);
  await send(page, "why is readConfig slow?");
  const messageId = await page.locator(".fc-chat [data-msg-id]").last().getAttribute("data-msg-id");
  expect(messageId).toBeTruthy();

  const j = (o: unknown) => JSON.stringify(o);
  const record = {
    v: 1,
    run_id: "r-e2e",
    session_id: "s-e2e",
    message_id: messageId,
    started_at: new Date().toISOString(),
    total_ms: 4200,
    first_token_ms: 2300,
    family: "claude",
    source: "chosen",
    model_requested: "claude-haiku-5-5",
    model_reported: "claude-haiku-5-5",
    outcome: "ok",
    failure_reason: null,
    failure_message: null,
    tokens: { input: 1052, output: 248, cache_read: 0, cache_write: 0, thinking: 38 },
    cost: { kind: "usd", usd: 0.0023 },
    command: ["claude", "-p"],
    cli_version: "2.1.301",
    exit_code: 0,
    permitted_tools: ["Read"],
    prompt_blocks: [
      { name: "page context", chars: 9, text: "Home page" },
      { name: "conversation", chars: 30, text: "[user] why is readConfig slow?" },
    ],
    prompt_omitted: ["past episodes"],
    output: [
      { t_ms: 900, line: j({ type: "system", subtype: "init", tools: ["Read"], model: "claude-haiku-5-5" }) },
      { t_ms: 1100, line: j({ type: "assistant", message: { content: [{ type: "tool_use", id: "t1", name: "Read", input: { file_path: "src/config/load.ts" } }] } }) },
      { t_ms: 1200, line: j({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "t1", content: "export function readConfig()" }] } }) },
      { t_ms: 2300, line: j({ type: "assistant", message: { content: [{ type: "text", text: "It re-reads the file." }] } }) },
      { t_ms: 4200, line: j({ type: "result", subtype: "success", usage: { input_tokens: 1052, output_tokens: 248 } }) },
    ],
    output_truncated: false,
  };
  await page.route("**/api/chat/sessions/*/runs", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ runs: [record] }) }),
  );

  await page.getByTestId("chat-runs-button").click();
  const row = page.locator("aside.fc-runs .cr-run");
  await expect(row.locator(".cr-l1")).toContainText("claude · haiku 5.5");
  await expect(row.locator(".cr-pick")).toHaveText("from settings");
  await expect(row).toContainText("4.2 s (first words after 2.3 s)");
  await expect(row).toContainText("what it looked up itself: Read src/config/load.ts");

  await row.getByRole("button", { name: "Open all steps" }).click();
  await expect(row.locator(".cr-trace")).toBeVisible();
  const tool = row.locator(".cr-ev-tool");
  await expect(tool.locator(".cr-toolname")).toHaveText("Read");
  await expect(tool.locator(".cr-toolr pre")).toHaveText("export function readConfig()");

  const raw = tool.locator(".cr-rawbtn");
  await raw.click();
  await expect(raw).toHaveAttribute("aria-expanded", "true");
  await expect(tool.locator(".cr-json")).toContainText('"tool_use_id": "t1"');
});
