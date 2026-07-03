/**
 * repo-graph-trace-tree.spec.ts — trace-root tree-picker LIVE acceptance.
 *
 * The implementation layer is unit-guarded; this is the live judgment
 * that the network actually behaves lazily and the tree-leaf pick lands the same
 * trace as the search box. Drives the seeded fixture (alpha/beta/gamma subdirs,
 * alpha/a.ts has the lone `runAlpha` function; util.ts/b.ts/g.ts are 0-fns).
 *
 *   1. lazy is REAL (network, not code-reading): no /symbols before a file is
 *      expanded; expanding fires it once; collapse + re-expand re-uses cache; a
 *      0-fns file never fetches /symbols.
 *   2. parity: tree-leaf pick and search-result pick fire the IDENTICAL
 *      /trace?entry=<funcNodeId> — same sink, same node id.
 *   3. additive-not-broken: the menu search box + the toolbar search still work,
 *      and a tree pick produces a working trace.
 */
import { test, expect, type Page } from "@playwright/test";
import { FIXTURE_HASH } from "./_setup/seed-repo-graph";

const FIXTURE_URL = `/repo-graph?repo=${FIXTURE_HASH}`;
const RUN_ALPHA_NODE = "function:src/alpha/a.ts:runAlpha";

/** Click "⟜ Trace a path", then make sure the picker menu + tree are open. */
async function openTree(page: Page): Promise<void> {
  await expect(page.locator('[x-data="repoGraph"]')).toBeAttached({ timeout: 10_000 });
  await page.locator("#rg-ph-enter").click();
  const tree = page.locator("#rg-ph-menu .ph-tree");
  // phEnterDefault → phOpenSearch already opens the menu in the degraded fixture;
  // if a preset entered trace without opening it, click the pick to open.
  if (!(await tree.isVisible().catch(() => false))) {
    await page.locator("#rg-ph-pick").click();
  }
  await expect(tree).toBeVisible({ timeout: 10_000 });
}

test("1. lazy is real — /symbols fires only on file-expand, cached, 0-fns never fetches", async ({
  page,
}) => {
  const sym: string[] = [];
  const fil: string[] = [];
  page.on("request", (r) => {
    const u = r.url();
    if (u.includes("/api/repo-graph/symbols")) sym.push(u);
    else if (u.includes("/api/repo-graph/files")) fil.push(u);
  });

  await page.goto(FIXTURE_URL);
  await openTree(page);
  await expect(page.locator(".ph-tree-sub")).toHaveCount(3); // alpha / beta / gamma

  // EVIDENCE A — tree open, nothing expanded: 0 /symbols.
  expect(sym.length, "no /symbols before any file is expanded").toBe(0);

  // Expand alpha → /files fires, but still NO /symbols.
  const filBefore = fil.length;
  const alpha = page.locator(".ph-tree-sub", { hasText: "alpha" });
  await Promise.all([
    page.waitForResponse((r) => r.url().includes("/api/repo-graph/files")),
    alpha.click(),
  ]);
  expect(fil.length, "expanding a subdir fetches /files").toBeGreaterThan(filBefore);
  expect(sym.length, "expanding a subdir does NOT fetch /symbols").toBe(0);

  // Badges: a.ts shows "1 fns", util.ts shows "0 fns".
  await expect(page.locator(".ph-tree-file", { hasText: "a.ts" }).locator(".ph-fns")).toHaveText(
    "1 fns",
  );
  await expect(page.locator(".ph-tree-file", { hasText: "util.ts" }).locator(".ph-fns")).toHaveText(
    "0 fns",
  );

  // Expand a.ts → /symbols fires exactly ONCE.
  const aFile = page.locator(".ph-tree-file", { hasText: "a.ts" }).first();
  await Promise.all([
    page.waitForResponse((r) => r.url().includes("/api/repo-graph/symbols")),
    aFile.click(),
  ]);
  expect(sym.length, "expanding a file fetches /symbols once").toBe(1);
  await expect(page.locator(".ph-tree-fn", { hasText: "runAlpha" })).toBeVisible();

  // Collapse + re-expand a.ts → cache hit, NO new /symbols.
  await aFile.click();
  await expect(page.locator(".ph-tree-fn", { hasText: "runAlpha" })).toBeHidden();
  await aFile.click();
  await expect(page.locator(".ph-tree-fn", { hasText: "runAlpha" })).toBeVisible();
  expect(sym.length, "re-expanding a cached file does NOT re-fetch /symbols").toBe(1);

  // Click util.ts (0 fns) → it is not expandable, NO /symbols.
  await page.locator(".ph-tree-file", { hasText: "util.ts" }).first().click();
  await page.waitForTimeout(300);
  expect(sym.length, "a 0-fns file never fetches /symbols").toBe(1);

  // Live network shape, end-to-end: /files=1 (one subdir expanded), /symbols=1
  // (one file expanded, served from cache on re-expand, never fetched for 0-fns).
  expect(fil.length, "exactly one /files fetch (the expanded subdir)").toBe(1);
  expect(sym.length, "exactly one /symbols fetch across the whole session").toBe(1);
});

/** Run one pick path in its own fresh context (separate HTTP cache, so the
 *  /trace GET actually hits the network) and return the captured entry param. */
async function captureTraceEntry(
  page: Page,
  pick: (p: Page) => Promise<void>,
): Promise<string | null> {
  const trace: string[] = [];
  page.on("request", (r) => {
    if (r.url().includes("/api/repo-graph/trace")) trace.push(r.url());
  });
  await page.goto(FIXTURE_URL);
  await openTree(page);
  await Promise.all([
    page.waitForResponse((r) => r.url().includes("/api/repo-graph/trace")),
    pick(page),
  ]);
  return new URL(trace[trace.length - 1]).searchParams.get("entry");
}

test("2. parity — tree-leaf pick and search pick fire the identical /trace entry", async ({
  browser,
}) => {
  // Two separate contexts → independent HTTP caches, so BOTH paths genuinely hit
  // /trace and we read each live entry param (a single context would serve the
  // second pick from cache and fire no request).
  const ctxA = await browser.newContext();
  const ctxB = await browser.newContext();
  try {
    // PATH A — pick runAlpha via the tree leaf.
    const treeEntry = await captureTraceEntry(await ctxA.newPage(), async (p) => {
      await p.locator(".ph-tree-sub", { hasText: "alpha" }).click();
      await p.locator(".ph-tree-file", { hasText: "a.ts" }).first().click();
      await p.locator(".ph-tree-fn", { hasText: "runAlpha" }).click();
    });

    // PATH B — pick runAlpha via the menu search box.
    const searchEntry = await captureTraceEntry(await ctxB.newPage(), async (p) => {
      await p.locator("#rg-ph-fn-inp").fill("runAlpha");
      const hit = p.locator(".ph-fn-result", { hasText: "runAlpha" }).first();
      await expect(hit).toBeVisible({ timeout: 10_000 });
      await hit.click();
    });

    expect(treeEntry, "tree-leaf entry").toBe(RUN_ALPHA_NODE);
    expect(searchEntry, "search entry").toBe(RUN_ALPHA_NODE);
    expect(treeEntry, "tree-leaf and search pick the SAME funcNodeId").toBe(searchEntry);
  } finally {
    await ctxA.close();
    await ctxB.close();
  }
});

test("3. additive — toolbar search, menu search, and tree pick all still work", async ({ page }) => {
  await page.goto(FIXTURE_URL);
  await page.waitForTimeout(1200); // arch render

  // Toolbar search (the original, separate surface — only present in the arch/file
  // view, hidden once tracing) still resolves the symbol. Tested BEFORE entering
  // trace mode.
  const toolbar = page.locator("#rg-search-input");
  await toolbar.click();
  await toolbar.fill("runAlpha");
  await expect(page.locator("#rg-search-results .res").first()).toContainText("runAlpha", {
    timeout: 10_000,
  });
  await toolbar.fill(""); // clear so its dropdown doesn't overlay the picker

  // Picker menu search box works (returns the seeded symbol).
  await openTree(page);
  await page.locator("#rg-ph-fn-inp").fill("runAlpha");
  await expect(page.locator(".ph-fn-result", { hasText: "runAlpha" }).first()).toBeVisible({
    timeout: 10_000,
  });

  // Tree pick produces a working trace — the picker bar now reads the picked
  // function as the entry (runAlpha has no callees, so it renders as a single
  // entry node card rather than a multi-hop .ph-trace-box).
  await page.locator(".ph-tree-sub", { hasText: "alpha" }).click();
  await page.locator(".ph-tree-file", { hasText: "a.ts" }).first().click();
  await page.locator(".ph-tree-fn", { hasText: "runAlpha" }).click();
  await expect(page.locator("#rg-ph-pick")).toContainText("runAlpha", { timeout: 10_000 });
});
