/**
 * settings-agents.spec.ts — the Agents page in a real browser, mock F's shape
 * (spec agent-in-use-truth §12; plan 2026-10-14 settings-agents-page-v2
 * Tasks 6–7): the agents-on-this-machine line, one row per role with its cap
 * field and Change model, the Change-model window's open / Use / close
 * behaviour, and no horizontal scroll at 1280 or 640 px.
 *
 * The window's lists and every write are stubbed with page.route: no CLI is
 * run, models.dev is not fetched, and the e2e home's config is not changed.
 */
import { expect, type Page, test } from "@playwright/test";

const ROLES = ["chat", "review", "extract"] as const;

async function noSideScroll(page: Page): Promise<void> {
  const over = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(over).toBeLessThanOrEqual(0);
}

const row = (family: string, id: string, input: number | null, tier = false) => ({
  id,
  family,
  description: null,
  tier,
  input,
  output: input === null ? null : input * 5,
  tags: input === null ? [] : ["reasoning"],
  choosable: true,
});

const VIEW = {
  savedOn: "2026-10-14",
  sources: [
    { name: "models.dev", ok: true, text: "models.dev — prices updated" },
    { name: "codex", ok: false, text: "codex — no answer in 10s; showing saved list" },
  ],
  rows: [
    {
      ...row("claude", "claude-sonnet-4-6", 3),
      guide: {
        text: "Claude Sonnet 4.6 is Anthropic's workhorse for coding agents.",
        tags: ["coding", "agents"],
        short: "Anthropic's workhorse for coding agents.",
        knowsUpTo: "2025-08",
        retiresOn: null,
        url: "https://openrouter.ai/anthropic/claude-sonnet-4.6",
      },
    },
    row("claude", "claude-haiku-4-5", 1),
    row("qoder", "Qwen3.8-Max", 2),
    row("qoder", "Auto", null, true),
    { ...row("codex", "", null), description: "gpt-5.6-sol, from codex's config" },
    { ...row("codex", "gpt-6-luna", 0.5), description: "Fast and affordable" },
  ],
};

/** Stub the window's reads and the role write; collect what was posted. */
async function stubWindow(page: Page): Promise<{ posts: Array<{ url: string; body: unknown }> }> {
  const posts: Array<{ url: string; body: unknown }> = [];
  await page.route("**/api/brain/models**", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(VIEW) }),
  );
  await page.route("**/api/brain/roles/**", (route) => {
    posts.push({ url: route.request().url(), body: route.request().postDataJSON() });
    return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ok: true }) });
  });
  return { posts };
}

for (const width of [1280, 640]) {
  test(`at ${width}px: agents line, three rows, every cap field and Change model reachable, no side scroll`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 900 });
    await page.goto("/settings");
    await expect(page.getByRole("heading", { name: "Agents", exact: true })).toBeVisible();
    await expect(page.locator("[data-agents-bar]")).toContainText("Coding agents on this machine");
    await expect(page.locator("[data-agent-chip]")).toHaveCount(5);
    await expect(page.locator("select")).toHaveCount(0);
    await expect(page.getByText("Daily call caps")).toHaveCount(0);

    for (const role of ROLES) {
      const r = page.locator(`[data-role-row="${role}"]`);
      await expect(r.locator(`[data-last-call="${role}"]`)).toBeVisible();
      const cap = r.locator(`input[name="${role}-cap"]`);
      await cap.scrollIntoViewIfNeeded();
      await expect(cap).toBeInViewport();
      const change = r.getByRole("button", { name: "Change model" });
      await change.scrollIntoViewIfNeeded();
      await expect(change).toBeInViewport();
    }
    await noSideScroll(page);
  });
}

test("Change model opens the window for that role; Use saves, keeps it open and moves the row first", async ({
  page,
}) => {
  const { posts } = await stubWindow(page);
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto("/settings");
  await page.locator('[data-role-row="review"]').getByRole("button", { name: "Change model" }).click();

  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole("heading")).toHaveText("Choose Critic's agent and model");
  await expect(dialog.locator("[data-model-sources]")).toContainText("codex — no answer in 10s; showing saved list");

  // The e2e home never chose a critic: it follows the agent you build with, so
  // no single row is in use (review 3, [1]).
  const marks = dialog.locator('[aria-label="in use"]:visible');
  await expect(marks).toHaveCount(0);
  await expect(dialog.locator("[data-model-now]")).toContainText("the agent you build with");

  const sonnet = dialog.locator("tr[data-model-row]", { hasText: "claude-sonnet-4-6" });
  await sonnet.getByRole("button", { name: "Use" }).click();
  await expect(dialog).toBeVisible();
  await expect(dialog.locator("[data-model-now]")).toContainText("✓ Saved");
  await expect(dialog.locator("tr[data-model-row]").first()).toContainText("claude-sonnet-4-6");
  await expect(dialog.locator("tr[data-model-row]").first().locator('[aria-label="in use"]')).toBeVisible();
  // Exactly one in-use mark now, a ✓ with no words.
  await expect(marks).toHaveCount(1);
  await expect(marks.first()).toHaveText("✓");
  expect(posts).toHaveLength(1);
  expect(posts[0]?.url).toContain("/api/brain/roles/review");
  expect(posts[0]?.body).toEqual({ family: "claude", model: "claude-sonnet-4-6" });
});

test("the window closes on the dimmed area, on Esc and on Done — not on a click inside", async ({ page }) => {
  await stubWindow(page);
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto("/settings");
  const open = () => page.locator('[data-role-row="chat"]').getByRole("button", { name: "Change model" }).click();
  const dialog = page.getByRole("dialog");

  await open();
  await expect(dialog).toBeVisible();
  // Review 2, [1]: a string style binding once replaced the whole style, so the
  // open window lost its overlay. It must stay a fixed layer over the page.
  const backdrop = page.locator("[data-model-backdrop]");
  await expect(backdrop).toHaveCSS("position", "fixed");
  await expect(backdrop).toHaveCSS("display", "flex");
  await dialog.getByRole("heading").click();
  await expect(dialog).toBeVisible();
  // The dimmed area: a point outside the dialog box.
  await page.mouse.click(10, 10);
  await expect(dialog).toBeHidden();

  await open();
  await expect(dialog).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();

  await open();
  await dialog.getByRole("button", { name: "Done" }).click();
  await expect(dialog).toBeHidden();
});

// Small item [7] (chat mainline): the window's name is read out and the keyboard
// works inside it — focus moves in on open, Tab stays in, focus comes back on close.
test("keyboard and screen reader: each opener is named by its role; focus enters, stays, returns", async ({ page }) => {
  await stubWindow(page);
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto("/settings");
  for (const name of ["Chat", "Critic", "Summarizer"]) {
    await expect(page.getByRole("button", { name: `Change model for ${name}`, exact: true })).toHaveCount(1);
  }
  const opener = page.getByRole("button", { name: "Change model for Chat", exact: true });
  await opener.focus();
  await page.keyboard.press("Enter");
  const dialog = page.getByRole("dialog", { name: "Choose Chat's agent and model" });
  await expect(dialog).toBeVisible();
  await expect(dialog).toBeFocused();
  // 40 presses each way: more than the window has stops, so a leak would show.
  for (let i = 0; i < 40; i++) {
    await page.keyboard.press("Tab");
    expect(await dialog.evaluate((d) => d.contains(document.activeElement))).toBe(true);
  }
  for (let i = 0; i < 40; i++) {
    await page.keyboard.press("Shift+Tab");
    expect(await dialog.evaluate((d) => d.contains(document.activeElement))).toBe(true);
  }
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
  await expect(opener).toBeFocused();

  // The ends wrap: Tab on the last stop goes to the first, Shift+Tab on the first to the last.
  await opener.click();
  await expect(dialog).toBeFocused();
  const stops = dialog.locator("button:visible, a[href]:visible");
  const n = await stops.count();
  expect(n).toBeGreaterThan(3);
  expect(n).toBeLessThan(40); // the loops above went round at least once
  await stops.last().focus();
  await page.keyboard.press("Tab");
  await expect(stops.first()).toBeFocused();
  await page.keyboard.press("Shift+Tab");
  await expect(stops.last()).toBeFocused();

  // Done and × hand focus back too.
  await dialog.getByRole("button", { name: "Done" }).click();
  await expect(dialog).toBeHidden();
  await expect(opener).toBeFocused();
  await opener.click();
  await dialog.getByRole("button", { name: "Close" }).click();
  await expect(opener).toBeFocused();
});

test("after Use, focus stays in the window (the pressed button is replaced by ✓)", async ({ page }) => {
  await stubWindow(page);
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto("/settings");
  await page.getByRole("button", { name: "Change model for Critic", exact: true }).click();
  const dialog = page.getByRole("dialog");
  const use = dialog.getByRole("button", { name: "Use" }).first();
  await use.focus();
  await page.keyboard.press("Enter");
  await expect(dialog.getByText("✓ Saved")).toBeVisible();
  await expect(dialog).toBeFocused();
});

// Review 3, [2]: the cap field in a real browser — it opens on the page's
// number, saves when left, sends all three caps and says ✓ saved.
test("a cap field saves when left: all three caps sent, ✓ saved shown; an unchanged field sends nothing", async ({
  page,
}) => {
  const posts: unknown[] = [];
  await page.route("**/api/brain/daily-caps", (route) => {
    posts.push(route.request().postDataJSON());
    return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ok: true }) });
  });
  await page.goto("/settings");
  const row = page.locator('[data-role-row="chat"]');
  const field = row.locator('input[name="chat-cap"]');
  const start = await field.inputValue();
  expect(start).toMatch(/^\d+$/);
  const others = {
    review: Number(await page.locator('input[name="review-cap"]').inputValue()),
    extract: Number(await page.locator('input[name="extract-cap"]').inputValue()),
  };

  await field.focus();
  await page.keyboard.press("Tab");
  expect(posts).toHaveLength(0);

  await field.fill("7");
  await page.keyboard.press("Tab");
  await expect(row.getByText("✓ saved")).toBeVisible();
  expect(posts).toEqual([{ chat: 7, ...others }]);
});

// a chat just sent did not move "0 used today".
test("coming back to the tab re-reads today's counts: text and meter move", async ({ page }) => {
  await page.goto("/settings");
  const row = page.locator('[data-role-row="chat"]');
  await expect(row).toContainText(/\d+ used today/);
  await page.route("**/api/brain", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ caps: { chat: 50, review: 50, extract: 50 }, usage: { chat: 25, review: 0, extract: 0 } }),
    }),
  );
  const cap = Number(await page.locator('input[name="chat-cap"]').inputValue());
  await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
  await expect(row).toContainText("25 used today");
  const pct = cap > 0 ? Math.min(100, (25 / cap) * 100) : 0;
  await expect(row.locator('[data-cap-meter="chat"]')).toHaveAttribute("style", new RegExp(`width: ${pct}%`));
});

// What it's for says what the model is for,
// with its cutoff and a link to its page; a row OpenRouter does not list has no link.
test("What it's for: OpenRouter's words, the cutoff, and details ↗ to the model's page", async ({ page }) => {
  await stubWindow(page);
  await page.goto("/settings");
  await page.locator('[data-role-row="chat"]').getByRole("button", { name: "Change model" }).click();
  const dialog = page.getByRole("dialog");
  const sonnet = dialog.locator("tr[data-model-row]", { hasText: "claude-sonnet-4-6" });
  await expect(sonnet).toContainText("Anthropic's workhorse for coding agents.");
  await expect(sonnet.locator("[data-model-tag]").first()).toHaveText("coding");
  const short = sonnet.getByText("Anthropic's workhorse for coding agents.", { exact: true });
  await expect(short).toHaveAttribute("title", "Claude Sonnet 4.6 is Anthropic's workhorse for coding agents.\nKnows up to 2025-08.");
  const link = sonnet.getByRole("link", { name: "details on openrouter.ai" });
  await expect(link).toHaveAttribute("href", "https://openrouter.ai/anthropic/claude-sonnet-4.6");
  await expect(link).toHaveAttribute("target", "_blank");
  const haiku = dialog.locator("tr[data-model-row]", { hasText: "claude-haiku-4-5" });
  await expect(haiku.getByRole("link", { name: "details on openrouter.ai" })).toBeHidden();
});

test("a tab shows one agent's models", async ({ page }) => {
  await stubWindow(page);
  await page.goto("/settings");
  await page.locator('[data-role-row="chat"]').getByRole("button", { name: "Change model" }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByRole("button", { name: "qoder", exact: true }).click();
  const agents = await dialog.locator("tr[data-model-row] td:nth-child(1)").allInnerTexts();
  expect(new Set(agents.map((a) => a.trim()))).toEqual(new Set(["qoder"]));
});

// codex listed models that could not be chosen. Since
// Siltpoke passes codex `-m` each
// has Use, and the own-config row keeps Use as the way back to no model.
test("the codex tab: its models have Use, and so does codex's own-config row", async ({ page }) => {
  await stubWindow(page);
  await page.goto("/settings");
  await page.locator('[data-role-row="chat"]').getByRole("button", { name: "Change model" }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByRole("button", { name: "codex", exact: true }).click();
  const luna = dialog.locator("tr[data-model-row]", { hasText: "gpt-6-luna" });
  await expect(luna).not.toContainText("can't pick");
  await expect(luna.getByRole("button", { name: "Use" })).toBeVisible();
  const own = dialog.locator("tr[data-model-row]", { hasText: "from codex's config" });
  await expect(own.getByRole("button", { name: "Use" })).toBeVisible();
});
