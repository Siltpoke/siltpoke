/**
 * repo-graph-pages.spec.ts — /repo-graph e2e (cytoscape build).
 *
 * Two surfaces:
 *   • `/repo-graph` (cwd repo unindexed in the e2e tmp home) → empty state +
 *     chrome (nav, help popover, search debounce, settings menu).
 *   • `/repo-graph?repo=a11ce0000001` → the seeded fixture (globalSetup
 *     `_setup/seed-repo-graph.ts`): cytoscape arch render, drill, search hit,
 *     explain button state.
 */
import { test, expect } from "@playwright/test";
import { FIXTURE_HASH } from "./_setup/seed-repo-graph";

const FIXTURE_URL = `/repo-graph?repo=${FIXTURE_HASH}`;

test("1. SSR shell loads with title + island root", async ({ page }) => {
  await page.goto("/repo-graph");
  await expect(page).toHaveTitle(/repo graph/i);
  await expect(page.locator('[x-data="repoGraph"]')).toBeAttached({ timeout: 10_000 });
});

test("2. Sidebar 'Repo Graph' nav entry visible + linked", async ({ page }) => {
  await page.goto("/repo-graph");
  const navLink = page.locator('a[href="/repo-graph"]').first();
  await expect(navLink).toBeAttached({ timeout: 10_000 });
  await expect(navLink).toContainText(/repo graph/i);
});

test("3. Bare /repo-graph with unindexed cwd falls back to an indexed repo", async ({ page }) => {
  // Picker-default dead-hash fallback: a bare /repo-graph whose cwd
  // repo is unindexed BUT other repos ARE indexed resolves to repos[0] (the
  // recency-list top) instead of dead-ending on the empty state. The e2e home
  // always has the seeded fixture, so bare /repo-graph renders that graph, not
  // the "No graph indexed" empty state. (The empty-state markup itself — the
  // zero-repos case — is covered by tests/web/routes/repo-graph.test.ts SSR.)
  await page.goto("/repo-graph");
  await expect(page.locator(".c4-node").first()).toBeVisible({ timeout: 10_000 });
  await expect(page.locator(".repo-empty.show")).toHaveCount(0);
});

test("4. Help popover opens on `?` + dismisses on outside click (codemap view)", async ({ page }) => {
  // The help popover explains import-LINE semantics, so it lives on the codemap
  // (module/import) view; it is intentionally hidden in the C4 arch view
  // (RepoGraph.tsx CSS: .rg-arch-c4(-derived) .ctl .help-btn{display:none}).
  // The fixture opens in the honest-subset C4 view (rg-arch-c4-derived) by
  // default, so drive the codemap view explicitly (?arch-mode=codemap) where
  // the help button is visible.
  await page.goto(`${FIXTURE_URL}&arch-mode=codemap`);
  const helpBtn = page.locator("#rg-help-btn");
  await expect(helpBtn).toBeVisible({ timeout: 10_000 });
  await helpBtn.click();
  const popover = page.locator("#rg-help-pop");
  await expect(popover).toBeVisible({ timeout: 5_000 });
  await expect(popover).toContainText(/how to read this graph/i);
  await page.mouse.click(60, 60);
  await expect(popover).toBeHidden({ timeout: 5_000 });
});

test("5. Search box debounces an /api/repo-graph/search call", async ({ page }) => {
  await page.goto("/repo-graph");
  const search = page.locator('input[placeholder*="Jump to symbol"]');
  await expect(search).toBeVisible({ timeout: 10_000 });
  const reqPromise = page.waitForRequest((r) => r.url().includes("/api/repo-graph/search?q="), {
    timeout: 5_000,
  });
  await search.fill("foo");
  await reqPromise;
});

// (Former test 6 — "Settings menu opens with layout/edges/canvas toggles" —
//  DELETED: the settings menu was removed from the architecture view. There is no
//  [aria-label="View settings"] button / .rg-settings-pop in the product
//  (grep-confirmed absent, not renamed). Diagnosed test-stale: feature removed,
//  so the test asserts a surface that no longer exists.)

test("7. [fixture] architecture level renders C4 container cards", async ({ page }) => {
  // The architecture view replaced the cytoscape canvas (#rg-cy) with a DOM/SVG C4 render
  // (.c4-node) — DOM, so headless renders it fine. Degraded fixture (no CLAUDE.md
  // §Architecture) → honest-subset C4: one container per subdir (alpha/beta/gamma).
  await page.goto(FIXTURE_URL);
  await expect(page.locator(".c4-boundary")).toBeVisible({ timeout: 10_000 });
  for (const name of ["alpha", "beta", "gamma"]) {
    await expect(page.locator(".c4-node", { hasText: name })).toBeVisible();
  }
});

test("8. [fixture] drill architecture → file level + breadcrumb", async ({ page }) => {
  await page.goto(FIXTURE_URL);
  const alpha = page.locator(".c4-node", { hasText: "alpha" });
  await expect(alpha).toBeVisible({ timeout: 10_000 });
  // C4 two-click drill: first click selects (opens panel), second drills to files.
  await alpha.click();
  await page.waitForTimeout(250);
  await alpha.click();
  // alpha has a.ts + util.ts.
  await expect(page.locator(".node.kind-file")).toHaveCount(2, { timeout: 10_000 });
  await expect(page.locator("#rg-crumbs")).toContainText("alpha");
});

test("9. [fixture] search returns the seeded symbol", async ({ page }) => {
  await page.goto(FIXTURE_URL);
  await page.waitForTimeout(1200);
  const search = page.locator("#rg-search-input");
  await search.click();
  await search.fill("runAlpha");
  await page.waitForTimeout(500);
  const rows = page.locator("#rg-search-results .res");
  await expect(rows.first()).toBeVisible({ timeout: 5_000 });
  await expect(rows.first()).toContainText("runAlpha");
});

test("10. [fixture] explain button shows Generate when no cache", async ({ page }) => {
  // The architecture view moved the explain affordance off the arch container (its panel
  // is now "runtime container · human-authored labels") down to the FILE/symbol
  // level. Drill alpha → file level → select a file → its panel foot carries the
  // (uncached) Generate-explanation button.
  await page.goto(FIXTURE_URL);
  const alpha = page.locator(".c4-node", { hasText: "alpha" });
  await expect(alpha).toBeVisible({ timeout: 10_000 });
  await alpha.click();
  await page.waitForTimeout(250);
  await alpha.click(); // second click drills to file level
  const aFile = page.locator(".node.kind-file", { hasText: "a.ts" });
  await expect(aFile).toBeVisible({ timeout: 10_000 });
  await aFile.click(); // select the file → opens its side panel
  await expect(page.locator("#rg-expl-btn")).toContainText(/generate explanation/i, {
    timeout: 5_000,
  });
});
