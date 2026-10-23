/**
 * settings-building-with.spec.ts — /settings shows which coding agents
 * Siltpoke has seen sessions of, read from the hooks' records, in a real
 * browser (spec agent-in-use-truth §12.1, §12.4: the "Coding agents on this
 * machine" line).
 *
 * The page used to print "The code was authored by claude" for everyone: the
 * value came from SILTPOKE_HOST, which the dashboard process does not have.
 */
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { E2E_HOME } from "./_setup/honesty-e2e-fixtures";

const LAST_HOST = join(E2E_HOME, "last-host");
const SEEN = join(E2E_HOME, "hosts-seen");
const chip = (family: string) => `[data-agent-chip="${family}"]`;

test.describe("Settings — the coding agents seen on this machine", () => {
  // The e2e home is shared and the daemon reads the records per request (chat
  // resolves through last-host too), so put back exactly what was there.
  let before: string | null = null;
  let seenBefore = false;
  test.beforeAll(() => {
    before = existsSync(LAST_HOST) ? readFileSync(LAST_HOST, "utf8") : null;
    seenBefore = existsSync(SEEN);
  });
  test.afterAll(() => {
    if (before === null) rmSync(LAST_HOST, { force: true });
    else writeFileSync(LAST_HOST, before);
    if (!seenBefore) rmSync(SEEN, { recursive: true, force: true });
  });

  test("an agent in last-host, before any hosts-seen record, reads building with today's time", async ({ page }) => {
    rmSync(SEEN, { recursive: true, force: true });
    writeFileSync(LAST_HOST, "codebuddy\n");
    await page.goto("/settings");
    await expect(page.locator(chip("codebuddy"))).toContainText(/building · \d{2}:\d{2}/);
    await expect(page.locator("[data-agents-bar]").locator("select, input, button")).toHaveCount(0);
    await expect(page.locator("body")).not.toContainText("authored by");
  });

  test("several agents seen: each reads building", async ({ page }) => {
    mkdirSync(SEEN, { recursive: true });
    writeFileSync(join(SEEN, "codex"), "");
    writeFileSync(join(SEEN, "qoder"), "");
    await page.goto("/settings");
    await expect(page.locator(chip("codex"))).toContainText("building ·");
    await expect(page.locator(chip("qoder"))).toContainText("building ·");
  });

  test("no record at all: no agent reads building", async ({ page }) => {
    rmSync(SEEN, { recursive: true, force: true });
    rmSync(LAST_HOST, { force: true });
    await page.goto("/settings");
    await expect(page.locator("[data-agent-chip]")).toHaveCount(5);
    await expect(page.locator("[data-agents-bar]")).not.toContainText("building");
  });
});
