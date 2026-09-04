/**
 * build-stamp.spec.ts — the sidebar footer line that names the build the
 * daemon is serving actually reaches a browser.
 *
 * Why this file exists: every other test for this feature is structurally
 * blind to the failure that matters most. The island's unit tests drive a
 * hand-built `$el`; the shell's SSR test asserts the mount point is in the
 * HTML; the route test asserts the endpoint's JSON. All three pass unchanged
 * against a build where the island never registers, never hydrates, or throws
 * on first paint — and the row ships hidden (`display:none` + `x-show`), so
 * that failure looks exactly like a healthy quiet footer. Nothing short of a
 * real browser distinguishes them.
 *
 * The load-bearing assertion is the cross-check: the text on screen must equal
 * the text `/api/version` derived. Asserting "some text is present" would pass
 * against a hardcoded string, and asserting the string itself would pin a
 * commit id that changes every commit.
 */
import { expect, test } from "@playwright/test";

interface VersionPayload {
  line?: { show: boolean; state: string; text: string; title: string };
}

test("the footer names the build this daemon is serving, and says what the server derived", async ({
  page,
}) => {
  await page.goto("/");

  // Fetch the endpoint FIRST and assert it has something to say. Without this
  // the comparison below could be blank-equals-blank — two empty sides match
  // exactly the way a verified one does.
  const payload: VersionPayload = await page.evaluate(async () => {
    const res = await fetch("/api/version");
    return (await res.json()) as VersionPayload;
  });
  expect(payload.line, "/api/version returned no line").toBeDefined();
  expect(payload.line?.show, "/api/version declined to name a build").toBe(true);
  expect((payload.line?.text ?? "").length, "derived line is empty").toBeGreaterThan(0);

  const row = page.locator("[data-build-stamp]");

  // Hydration: the row ships hidden and only appears once the island's fetch
  // has resolved. If the island never registers, this is the assertion that
  // fails — and it is the only one in the whole feature that can.
  await expect(row).toBeVisible({ timeout: 10_000 });

  // The screen shows the server's derivation, not a string of its own.
  await expect(row).toHaveText(payload.line?.text ?? "", { timeout: 10_000 });
  await expect(row).toHaveText(/^build \S+/);

  // The audit trail (commit subject + the exact file measured) is on the row,
  // not only in the JSON.
  const title = await row.getAttribute("title");
  expect(title ?? "", "title attribute missing the measured path").toContain("/");
});

test("collapsing the rail takes the build line with it", async ({ page }) => {
  await page.goto("/");
  const row = page.locator("[data-build-stamp]");
  await expect(row).toBeVisible({ timeout: 10_000 });

  // 52px of rail has no room for a monospace build id; the row is bound to
  // `!collapsed` for the same reason the daemon identity beside it is.
  await page.getByRole("button", { name: /toggle sidebar/i }).first().click();
  await expect(page.locator("[data-sidebar]").first()).toHaveCSS("width", "52px", {
    timeout: 5_000,
  });
  await expect(row).toBeHidden();

  await page.getByRole("button", { name: /toggle sidebar/i }).first().click();
  await expect(row).toBeVisible({ timeout: 5_000 });
});
