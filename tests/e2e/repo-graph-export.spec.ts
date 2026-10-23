/**
 * repo-graph-export.spec.ts — Code Map share export, real Chromium.
 *
 * Fixtures (tests/e2e/_setup/export-fixture.ts): EXPORT_HASH has all three architecture
 * sources on a real project root; EMPTY_HASH a generated model with no boxes; HUGE_HASH a
 * generated model too large for a 1x canvas. FIXTURE_HASH (the global seed) is the plain
 * Honest-subset repo where the Authored/Generated chip is hidden. Test names carry the AC id
 * of an internal design note
 */
import { expect, test, type Page } from "@playwright/test";
import { pngChunkTypes, pngSize } from "../_util/png-chunks";
import { FIXTURE_HASH } from "./_setup/seed-repo-graph";
import {
  cleanupExportFixtures,
  EMPTY_HASH,
  EXPORT_HASH,
  EXPORT_ROOT,
  HUGE_HASH,
  seedEmptyFixture,
  seedExportFixture,
  seedHugeFixture,
} from "./_setup/export-fixture";
import {
  action,
  collectDownloads,
  diffShare,
  dlg,
  gotoView,
  inkInRect,
  inkShare,
  openPreview,
  pixelAt,
  svgGeometry,
  viewUrl,
  waitForFiles,
} from "./_setup/export-helpers";

const TRUST = "**/api/repo-graph/arch/trust**";
const NOTICE = "The image contains folder and file names — check before sharing outside.";
const PNG_CHUNKS = new Set(["IHDR", "IDAT", "IEND", "sRGB", "pHYs"]);

test.beforeAll(async () => {
  await seedExportFixture();
  await seedEmptyFixture();
  await seedHugeFixture(30, 30);
});
test.afterAll(() => cleanupExportFixtures());
test.beforeEach(({ page }) => {
  page.setDefaultTimeout(20_000);
});

/** Rewrite the trust response the export (and the page) receives. */
async function mutateTrust(page: Page, edit: (body: { data: Record<string, any> }) => void): Promise<void> {
  await page.route(TRUST, async (route) => {
    const res = await route.fetch();
    const body = (await res.json()) as { data: Record<string, any> };
    edit(body);
    await route.fulfill({ response: res, json: body });
  });
}

// ── where it lives ───────────────────────────────────────────────────────────────

test("AC1 — Export is a sibling of the source chip, visible in every architecture view, hidden on codemap and trace", async ({ page }) => {
  for (const source of ["generated", "authored", "subset"]) {
    await page.goto(viewUrl(EXPORT_HASH, source));
    await expect(page.locator("#rg-export"), source).toBeVisible();
    expect(await page.locator("#rg-export").evaluate((b) => b.closest("#rg-src-chip"))).toBeNull();
    expect(await page.locator("#rg-export").evaluate((b) => b.previousElementSibling?.id)).toBe("rg-src-chip");
  }
  // The Honest-subset view where the chip itself is hidden (no Authored/Generated pair to switch).
  await page.goto(`/repo-graph?repo=${FIXTURE_HASH}`);
  await expect(page.locator(".c4-node").first()).toBeVisible();
  await expect(page.locator("#rg-src-chip")).toBeHidden();
  await expect(page.locator("#rg-export")).toBeVisible();
  // Trace: control first (visible), then hidden after entering trace.
  await page.locator("#rg-ph-enter").click();
  await expect(page.locator("#rg-ph-menu .ph-tree")).toBeVisible();
  await expect(page.locator("#rg-export")).toBeHidden();
  // Codemap.
  await page.goto(`${viewUrl(EXPORT_HASH, "generated")}&arch-mode=codemap`);
  await expect(page.locator("#rg-help-btn")).toBeVisible();
  await expect(page.locator("#rg-export")).toBeHidden();
  await expect(page.locator("#rg-export-note")).toBeHidden();
});

test("AC2 — the notice text is exact and shows with the button", async ({ page }) => {
  await gotoView(page, EXPORT_HASH, "generated");
  await expect(page.locator("#rg-export-note")).toBeVisible();
  await expect(page.locator("#rg-export-note")).toHaveText(NOTICE);
});

test("AC3 — an empty model: button visible, disabled, 'No map yet'; a click sends no trust or generate request", async ({ page }) => {
  const seen: string[] = [];
  page.on("request", (r) => seen.push(`${r.method()} ${new URL(r.url()).pathname}`));
  await page.goto(viewUrl(EMPTY_HASH, "generated"));
  const btn = page.locator("#rg-export");
  await expect(btn).toBeVisible();
  await expect(btn).toBeDisabled();
  await expect(btn).toHaveAttribute("title", "No map yet");
  await page.waitForTimeout(500); // let the page's own requests settle
  const before = seen.length;
  await btn.click({ force: true });
  await btn.evaluate((b) => b.dispatchEvent(new MouseEvent("click", { bubbles: true })));
  await page.waitForTimeout(600);
  expect(seen.slice(before).filter((r) => /arch\/(trust|generate)/.test(r))).toEqual([]);
  expect(seen.filter((r) => r.includes("/arch/generate"))).toEqual([]);
  await expect(dlg(page)).toBeHidden();
});

// ── preview ──────────────────────────────────────────────────────────────────────

test("AC4/AC5 — the preview shows the image and 'Rendered at 2×' before anything is saved", async ({ page }, info) => {
  const files = collectDownloads(page, info);
  await gotoView(page, EXPORT_HASH, "generated");
  await openPreview(page);
  await expect(dlg(page).locator(".rg-export-img")).toHaveAttribute("src", /^blob:/);
  await expect(dlg(page).locator(".rg-export-scale")).toHaveText("Rendered at 2×");
  await page.waitForTimeout(300);
  expect(files.length).toBe(0);
});

test("AC19/AC20/AC23 — Download PNG: a real file, metadata-free, sized bounds × 2, with ink in the first title", async ({ page }, info) => {
  const files = collectDownloads(page, info);
  await gotoView(page, EXPORT_HASH, "generated");
  await openPreview(page);
  await action(page, "Download HTML").click();
  await waitForFiles(files, 1);
  await action(page, "Download PNG").click();
  await waitForFiles(files, 2);
  const html = files.find((f) => f.name.endsWith(".html"));
  const png = files.find((f) => f.name.endsWith(".png"));
  if (!html || !png) throw new Error("missing download");
  expect(png.name).toMatch(/^code-map-generated-\d{4}-\d{2}-\d{2}\.png$/);
  for (const t of pngChunkTypes(png.bytes)) expect(PNG_CHUNKS.has(t), `chunk ${t}`).toBe(true);
  const geo = svgGeometry(html.text(), "c-alpha");
  expect(pngSize(png.bytes)).toEqual({ w: Math.floor(geo.width * 2), h: Math.floor(geo.height * 2) });
  expect(await inkShare(page, png.bytes), "non-blank").toBeGreaterThan(0.01);
  // The first box's title rect has ink (not fallback-blank text): pixels unlike the box fill.
  const b = geo.box;
  const t = geo.title; // where the builder put the first title line (text is centred in the box)
  const title = { x: Math.round(t.x * 2), y: Math.round(t.y * 2), w: Math.round(t.w * 2), h: Math.round(t.h * 2) };
  const ref = { x: Math.round((b.x + b.w - 3) * 2), y: Math.round((b.y + b.h - 3) * 2) };
  expect(await inkInRect(page, png.bytes, title, ref), "title ink").toBeGreaterThan(40);
});

test("AC23 — export waits for the fonts: no preview before the delayed font files arrive, and the title has ink", async ({ page }, info) => {
  test.setTimeout(60_000);
  const files = collectDownloads(page, info);
  let released = false;
  // Export fonts only — the page's own `Dash-*`/dashboard.css load before Export is clicked.
  await page.route(/\/static\/fonts\/(?!Dash-|dashboard\.css)[^/]+$/, async (route) => {
    await new Promise((r) => setTimeout(r, 1500));
    released = true;
    await route.continue();
  });
  await gotoView(page, EXPORT_HASH, "generated");
  await page.locator("#rg-export").click();
  const img = dlg(page).locator(".rg-export-img");
  await page.waitForTimeout(700);
  expect(released, "fonts still held").toBe(false);
  await expect(img, "no preview while fonts are pending").toBeHidden();
  await expect(img).toBeVisible();
  expect(released, "preview appeared only after the fonts resolved").toBe(true);
  await expect(action(page, "Download PNG")).toBeEnabled();
  await action(page, "Download HTML").click();
  await action(page, "Download PNG").click();
  await waitForFiles(files, 2);
  const html = files.find((f) => f.name.endsWith(".html"));
  const png = files.find((f) => f.name.endsWith(".png"));
  if (!html || !png) throw new Error("missing download");
  const { box: b, title: t } = svgGeometry(html.text(), "c-alpha");
  const title = { x: Math.round(t.x * 2), y: Math.round(t.y * 2), w: Math.round(t.w * 2), h: Math.round(t.h * 2) };
  const ref = { x: Math.round((b.x + b.w - 3) * 2), y: Math.round((b.y + b.h - 3) * 2) };
  expect(await inkInRect(page, png.bytes, title, ref)).toBeGreaterThan(40);
});

test("AC17 — appendix off: one file; on: .png and .md with headings", async ({ page }, info) => {
  const files = collectDownloads(page, info);
  await gotoView(page, EXPORT_HASH, "generated");
  await openPreview(page);
  await action(page, "Download PNG").click();
  await waitForFiles(files, 1);
  await page.waitForTimeout(400);
  expect(files.map((f) => f.name.split(".").pop())).toEqual(["png"]);
  await dlg(page).getByLabel("Include appendix").check();
  await expect(action(page, "Download PNG")).toBeEnabled();
  await action(page, "Download PNG").click();
  await waitForFiles(files, 3);
  const md = files.find((f) => f.name.endsWith(".md"));
  expect(md?.name).toMatch(/^code-map-generated-\d{4}-\d{2}-\d{2}\.md$/);
  expect(md?.text()).toMatch(/^## /m);
  expect(md?.text()).toContain("src/alpha/a.ts");
});

test("AC18 — the dark toggle changes the top-left pixel", async ({ page }, info) => {
  const files = collectDownloads(page, info);
  await gotoView(page, EXPORT_HASH, "generated");
  await openPreview(page);
  await action(page, "Download PNG").click();
  await dlg(page).getByLabel("Dark background").check();
  await expect(action(page, "Download PNG")).toBeEnabled();
  await action(page, "Download PNG").click();
  await waitForFiles(files, 2);
  const [light, dark] = await Promise.all(files.map((f) => pixelAt(page, f.bytes, 0, 0)));
  const lum = (p: number[]) => p[0] + p[1] + p[2];
  expect(lum(light)).toBeGreaterThan(600);
  expect(lum(dark)).toBeLessThan(200);
});

test("AC19 — Copy PNG (permission granted): the clipboard holds a metadata-free image/png", async ({ page, context }) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await gotoView(page, EXPORT_HASH, "generated");
  await openPreview(page);
  await action(page, "Copy PNG").click();
  await expect(dlg(page).locator(".rg-export-status")).toHaveText("Copied — paste it anywhere");
  const bytes = await page.evaluate(async () => {
    const items = await navigator.clipboard.read();
    const blob = await items[0].getType("image/png");
    return Array.from(new Uint8Array(await blob.arrayBuffer()));
  });
  const png = Uint8Array.from(bytes);
  for (const t of pngChunkTypes(png)) expect(PNG_CHUNKS.has(t), `chunk ${t}`).toBe(true);
  expect(pngSize(png).w).toBeGreaterThan(1000);
});

test("AC19 — Copy PNG refused by the browser: the exact message, and Download still works", async ({ page }, info) => {
  const files = collectDownloads(page, info);
  // A fresh context has no clipboard permission: the browser's own refusal, not a stub.
  await gotoView(page, EXPORT_HASH, "generated");
  await openPreview(page);
  expect(await page.evaluate(async () => (await navigator.permissions.query({ name: "clipboard-write" as PermissionName })).state)).not.toBe("granted");
  await action(page, "Copy PNG").click();
  await expect(dlg(page).locator(".rg-export-status")).toHaveText(/^Copy not allowed by the browser — use Download \(\w+\)$/);
  await action(page, "Download PNG").click();
  await waitForFiles(files, 1);
  expect(files[0].name).toMatch(/\.png$/);
});

test("AC21 — no exported file carries an absolute path or home directory", async ({ page }, info) => {
  const files = collectDownloads(page, info);
  await gotoView(page, EXPORT_HASH, "generated");
  await openPreview(page);
  await dlg(page).getByLabel("Include appendix").check();
  await expect(action(page, "Download PNG")).toBeEnabled();
  await action(page, "Download PNG").click();
  await action(page, "Download HTML").click();
  await waitForFiles(files, 4); // .png + .md, then .html + .md (F1: both downloads carry the appendix)
  for (const f of files.filter((x) => !x.name.endsWith(".png"))) {
    const text = f.text();
    expect(text, f.name).not.toMatch(/\/Users\/|\/home\/|\/private\/var/);
    expect(text, f.name).not.toContain(EXPORT_ROOT);
    expect(text, f.name).not.toContain(process.cwd());
  }
});

test("AC22 — a map too large for a sharp image steps down and warns", async ({ page }, info) => {
  test.setTimeout(90_000);
  const files = collectDownloads(page, info);
  await page.goto(viewUrl(HUGE_HASH, "generated"));
  await expect(page.locator("#rg-export")).toBeEnabled();
  await page.locator("#rg-export").click();
  const scale = dlg(page).locator(".rg-export-scale");
  await expect(scale).toBeVisible({ timeout: 60_000 });
  await expect(scale).toContainText("map too large");
  await expect(scale).toContainText("the HTML export has no size limit");
  await expect(action(page, "Download PNG")).toBeEnabled({ timeout: 60_000 });
  await action(page, "Download PNG").click();
  await waitForFiles(files, 1);
  const { w, h } = pngSize(files[0].bytes);
  expect(Math.max(w, h)).toBeLessThanOrEqual(16384);
  expect(w * h).toBeLessThanOrEqual(16_000_000);
});

test("AC16 — far behind: the preview shows the server's stamp line prominently, and nothing is regenerated", async ({ page }) => {
  const seen: string[] = [];
  page.on("request", (r) => seen.push(`${r.method()} ${new URL(r.url()).pathname}`));
  await mutateTrust(page, (b) => {
    b.data.farBehind = true;
    b.data.stampLine = "Map from 2025-01-01 · commit abc1234 · 250 commits behind";
  });
  await gotoView(page, EXPORT_HASH, "generated");
  await openPreview(page);
  await expect(dlg(page).locator(".rg-export-banner")).toBeVisible();
  await expect(dlg(page).locator(".rg-export-banner")).toHaveText("Map from 2025-01-01 · commit abc1234 · 250 commits behind");
  expect(seen.filter((r) => r.includes("/arch/generate"))).toEqual([]);
});

// ── privacy ──────────────────────────────────────────────────────────────────────

async function expectBlocked(page: Page, message: RegExp, files: unknown[]): Promise<void> {
  await page.locator("#rg-export").click();
  const status = dlg(page).locator(".rg-export-status");
  await expect(status).toBeVisible();
  await expect(status).toHaveText(message);
  await expect(dlg(page).locator(".rg-export-img")).toBeHidden();
  for (const name of ["Download PNG", "Copy PNG", "Download HTML"]) {
    await expect(action(page, name)).toBeDisabled();
    await action(page, name).evaluate((b) => (b as HTMLButtonElement).click()); // a forced click must do nothing
  }
  await page.waitForTimeout(500);
  expect(files.length).toBe(0);
}

test("privacy — an AI title holding /Users/alice/work blocks all three actions and names the location", async ({ page }, info) => {
  const files = collectDownloads(page, info);
  await mutateTrust(page, (b) => {
    (b.data.containers as Array<{ title: string }>)[0].title = "Reads /Users/alice/work notes";
  });
  await gotoView(page, EXPORT_HASH, "generated");
  await expectBlocked(page, /looks like it contains a local file path \(c-alpha\) — regenerate the map before sharing/, files);
});

test("privacy — a ghp_ key in a folder name blocks the export with the appendix off", async ({ page }, info) => {
  const files = collectDownloads(page, info);
  await mutateTrust(page, (b) => {
    (b.data.containers as Array<{ folders: Array<{ folder: string }> }>)[0].folders[0].folder = `src/ghp_${"A1b2".repeat(10)}`;
  });
  await gotoView(page, EXPORT_HASH, "generated");
  await expectBlocked(page, /looks like it contains a secret \(container 1 folder 1\) — regenerate the map before sharing/, files);
});

// ── rebuild gating ───────────────────────────────────────────────────────────────

test("gating — a toggle disables the actions until its rebuild resolves; then .png + .md", async ({ page }, info) => {
  const files = collectDownloads(page, info);
  await gotoView(page, EXPORT_HASH, "generated");
  await openPreview(page);
  let release!: () => void;
  const gate = new Promise<void>((r) => {
    release = r;
  });
  await page.route(TRUST, async (route) => {
    await gate;
    await route.continue();
  });
  await dlg(page).getByLabel("Include appendix").check();
  await expect(action(page, "Download PNG")).toBeDisabled();
  await action(page, "Download PNG").click({ force: true });
  await action(page, "Download PNG").evaluate((b) => (b as HTMLButtonElement).click());
  await page.waitForTimeout(600);
  expect(files.length, "nothing downloads while the rebuild is pending").toBe(0);
  release();
  await expect(action(page, "Download PNG")).toBeEnabled();
  await action(page, "Download PNG").click();
  await waitForFiles(files, 2);
  expect(files.map((f) => f.name.split(".").pop()).sort()).toEqual(["md", "png"]);
});

// ── clickable HTML export ──────────────────────────────────────────────────────

test("AC24–AC28 — the HTML opens offline with no network, clicks open the panel, Save as image matches the PNG export", async ({ page, browser }, info) => {
  test.setTimeout(90_000);
  const files = collectDownloads(page, info);
  await gotoView(page, EXPORT_HASH, "generated");
  await openPreview(page);
  await action(page, "Download PNG").click();
  await action(page, "Download HTML").click();
  await waitForFiles(files, 2);
  const pngExport = files.find((f) => f.name.endsWith(".png"));
  const htmlFile = files.find((f) => f.name.endsWith(".html"));
  if (!pngExport || !htmlFile) throw new Error("missing download");
  const html = htmlFile.text();
  // AC26: appendix was off, so no per-file member lists.
  expect(html).not.toContain("src/alpha/a.ts");

  const ctx = await browser.newContext({ acceptDownloads: true });
  await ctx.setOffline(true);
  const web = await ctx.newPage();
  const net: string[] = [];
  const errors: string[] = [];
  web.on("request", (r) => {
    if (!/^(file|data|blob):/.test(r.url())) net.push(r.url());
  });
  web.on("pageerror", (e) => errors.push(e.message));
  const saved = collectDownloads(web, info);
  await web.goto(`file://${htmlFile.path}`);
  // AC24/AC27: same stamp, legend and not-shown line as the PNG (they are in the SVG text).
  const text = (await web.locator("#map svg").textContent()) ?? "";
  for (const t of ["Map from 2026-09-21", "solid: an import, or a source citation checked at export", "Not shown: src/omega"]) expect(text).toContain(t);
  // AC25: click a box → panel with description and an edge line with evidence.
  await web.locator('#map rect[data-id="c-delta"]').click({ position: { x: 8, y: 6 } }); // the card's padding: its middle is covered by its own text now
  const panel = web.locator("#panel");
  await expect(panel).toBeVisible();
  await expect(panel).toContainText("Runs background work.");
  await expect(panel.locator("li", { hasText: "Delta Jobs → Beta Store — feeds" })).toContainText("Evidence: cited src/delta/d.ts:2");
  await expect(panel.locator("li", { hasText: "Delta Jobs → Gamma Gateway — notifies" })).toContainText("Evidence: no evidence recorded");
  await expect(panel.locator("h3", { hasText: /^(Incoming|Outgoing)/ })).toHaveText(["Incoming (1)", "Outgoing (2)"]);
  await expect(panel).not.toContainText("Files the AI listed");
  // AC28: Save as image → the same PNG as the PNG export for this view, theme and scale.
  await web.locator("#save-img").click();
  await waitForFiles(saved, 1);
  expect(saved[0].name).toMatch(/^code-map-generated-\d{4}-\d{2}-\d{2}\.png$/);
  expect(pngSize(saved[0].bytes)).toEqual(pngSize(pngExport.bytes));
  expect(await diffShare(page, saved[0].bytes, pngExport.bytes)).toBeLessThanOrEqual(0.005);
  expect(net, "no network request from the exported file").toEqual([]);
  expect(errors).toEqual([]);
  await ctx.close();
});
