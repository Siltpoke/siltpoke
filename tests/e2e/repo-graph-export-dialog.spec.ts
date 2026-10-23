/**
 * repo-graph-export-dialog.spec.ts — the preview dialog as a person uses it (found in a hands-on test in Chrome): it can always be closed (B1), it opens in the page's
 * own theme (B2), and ticking "Include appendix" says where the appendix goes and never
 * blanks the preview while the new one renders (B3).
 */
import { expect, type Page, test } from "@playwright/test";
import { cleanupExportFixtures, EXPORT_HASH, seedExportFixture, seedTallFixture, TALL_HASH } from "./_setup/export-fixture";
import { action, collectDownloads, dlg, gotoView, openPreview, waitForFiles } from "./_setup/export-helpers";

test.beforeAll(async () => {
  await seedExportFixture();
  await seedTallFixture();
});
test.afterAll(() => cleanupExportFixtures());
test.beforeEach(({ page }) => {
  page.setDefaultTimeout(20_000);
});

const isOpen = (page: Page): Promise<boolean> => dlg(page).evaluate((d: HTMLDialogElement) => d.open);

// ── B1: every way out works, without hunting for the button ─────────────────────

test.describe("B1 — the dialog can always be closed", () => {
  // A short window makes the preview taller than the dialog, as the real siltpoke map does at 820px.
  test.beforeEach(async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 560 });
    await gotoView(page, EXPORT_HASH, "generated");
    await openPreview(page);
  });
  test("Close is on screen without scrolling, and closes", async ({ page }) => {
    const btn = action(page, "Close");
    const onScreen = await btn.evaluate((e) => {
      const r = e.getBoundingClientRect();
      return r.top >= 0 && r.bottom <= window.innerHeight;
    });
    expect(onScreen, "Close is visible without scrolling the dialog").toBe(true);
    await btn.click();
    expect(await isOpen(page)).toBe(false);
  });
  test("Esc closes", async ({ page }) => {
    await page.keyboard.press("Escape");
    expect(await isOpen(page)).toBe(false);
  });
  test("a click on the backdrop closes; a click inside does not", async ({ page }) => {
    await dlg(page).locator(".rg-export-img").click();
    expect(await isOpen(page)).toBe(true);
    await page.mouse.click(8, 8);
    expect(await isOpen(page)).toBe(false);
  });
});

// ── B2: the export starts in the page's resolved theme ──────────────────────────

async function openIn(page: Page, system: "light" | "dark", forced: "light" | "dark" | null): Promise<void> {
  await page.emulateMedia({ colorScheme: system });
  await gotoView(page, EXPORT_HASH, "generated");
  await page.evaluate((f) => {
    if (f) document.documentElement.setAttribute("data-theme", f);
    else document.documentElement.removeAttribute("data-theme");
  }, forced);
  await openPreview(page);
}
const darkBox = (page: Page) => dlg(page).getByLabel("Dark background");

test.describe("B2 — the export opens in the page's theme", () => {
  for (const [system, forced, want] of [
    ["dark", null, true],
    ["light", null, false],
    ["light", "dark", true],
    ["dark", "light", false],
  ] as const) {
    test(`system ${system}, override ${forced ?? "none"} → dark ${want}`, async ({ page }) => {
      await openIn(page, system, forced);
      if (want) await expect(darkBox(page)).toBeChecked();
      else await expect(darkBox(page)).not.toBeChecked();
    });
  }
  test("the person can still switch it", async ({ page }) => {
    await openIn(page, "dark", null);
    await darkBox(page).uncheck();
    await expect(action(page, "Download PNG")).toBeEnabled();
    await expect(darkBox(page)).not.toBeChecked();
  });
});

// ── B3: the appendix toggle says what it does, and the preview never blanks ────

test.describe("B3 — Include appendix", () => {
  test("says where the appendix goes, next to the toggle", async ({ page }) => {
    await gotoView(page, EXPORT_HASH, "generated");
    await openPreview(page);
    const box = dlg(page).getByLabel(/Include appendix/);
    await box.check();
    await expect(action(page, "Download PNG")).toBeEnabled();
    const note = dlg(page).locator(".rg-export-appnote");
    await expect(note).toBeVisible();
    await expect(note).toContainText(".md");
    await box.uncheck();
    await expect(note).toBeHidden();
  });
});

test.describe("B3/F1 — where the appendix goes", () => {
  test("with it on, Download PNG and Download HTML each save the .md too (F1)", async ({ page }, info) => {
    const files = collectDownloads(page, info);
    await gotoView(page, EXPORT_HASH, "generated");
    await openPreview(page);
    await dlg(page).getByLabel(/Include appendix/).check();
    await expect(action(page, "Download PNG")).toBeEnabled();
    await action(page, "Download HTML").click();
    await waitForFiles(files, 2);
    expect(files.map((f) => f.name.split(".").pop()).sort()).toEqual(["html", "md"]);
    await action(page, "Download PNG").click();
    await waitForFiles(files, 4);
    expect(files.slice(2).map((f) => f.name.split(".").pop()).sort()).toEqual(["md", "png"]);
    const md = (from: number) => files.slice(from, from + 2).find((f) => f.name.endsWith(".md"))?.text();
    expect(md(0)).toContain("## Edges"); // the same appendix, whichever button saved it
    expect(md(2)).toBe(md(0));
  });
  test("the old preview stays up until the new one is ready: no blank frame", async ({ page }) => {
    await gotoView(page, EXPORT_HASH, "generated");
    await openPreview(page);
    const img = dlg(page).locator(".rg-export-img");
    const before = await img.getAttribute("src");
    // A slow machine: the new image takes real time to decode, as the full-size map does on hers.
    const cdp = await page.context().newCDPSession(page);
    await cdp.send("Emulation.setCPUThrottlingRate", { rate: 12 });
    // Sample every animation frame from before the click until the new image is painted.
    await page.evaluate(() => {
      const w = window as unknown as { __blank: number; __frames: number; __stop: boolean };
      w.__blank = 0;
      w.__frames = 0;
      w.__stop = false;
      const el = document.querySelector("dialog.rg-export-dlg .rg-export-img") as HTMLImageElement;
      const tick = (): void => {
        w.__frames++;
        const r = el.getBoundingClientRect();
        if (el.hidden || !el.getAttribute("src") || !el.complete || el.naturalWidth === 0 || r.height < 10) w.__blank++;
        if (!w.__stop) requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    });
    await dlg(page).getByLabel(/Include appendix/).check();
    await expect.poll(() => img.getAttribute("src")).not.toBe(before);
    await expect(action(page, "Download PNG")).toBeEnabled();
    await page.waitForTimeout(200);
    const { blank, frames } = await page.evaluate(() => {
      const w = window as unknown as { __blank: number; __frames: number; __stop: boolean };
      w.__stop = true;
      return { blank: w.__blank, frames: w.__frames };
    });
    expect(frames).toBeGreaterThan(3);
    expect(blank, "frames with no preview on screen").toBe(0);
  });
});

// ── F2: toggling the appendix never resizes the dialog or the preview ────────────

test.describe("F2 — the dialog holds still", () => {
  test("the preview and the dialog keep their exact size and place across an appendix toggle", async ({ page }) => {
    await gotoView(page, EXPORT_HASH, "generated");
    await openPreview(page);
    const img = dlg(page).locator(".rg-export-img");
    // Sizes, and the preview's place inside the dialog's content: the dialog now scrolls (round 8),
    // and ticking a box below the preview scrolls it into view, which moves nothing but the viewport.
    const measure = () =>
      dlg(page).evaluate((d: HTMLElement) => {
        const i = d.querySelector(".rg-export-img") as HTMLImageElement;
        const r = i.getBoundingClientRect();
        const b = d.getBoundingClientRect();
        return { img: { w: r.width, h: r.height, left: i.offsetLeft, top: i.offsetTop }, dlg: { x: b.x, y: b.y, w: b.width, h: b.height } };
      });
    const before = await measure();
    const src = await img.getAttribute("src");
    const box = dlg(page).getByLabel(/Include appendix/);
    await box.check();
    await expect(dlg(page).locator(".rg-export-appnote")).toBeVisible();
    await expect.poll(() => img.getAttribute("src")).not.toBe(src); // the rebuilt preview is in
    await expect(action(page, "Download PNG")).toBeEnabled();
    expect(await measure()).toEqual(before);
    await box.uncheck();
    await expect(action(page, "Download PNG")).toBeEnabled();
    await expect(dlg(page).locator(".rg-export-appnote")).toBeHidden();
    expect(await measure()).toEqual(before);
  });
});

// ── Round 8: the preview uses the dialog's full width; a tall map scrolls ─────────

test.describe("the preview fills the dialog's width", () => {
  for (const [w, h] of [[1280, 800], [1440, 900]] as const) {
    test(`a tall map at ${w}×${h}: preview as wide as the dialog's content, Close still on screen`, async ({ page }) => {
      await page.setViewportSize({ width: w, height: h });
      await gotoView(page, TALL_HASH, "generated");
      await openPreview(page);
      const { imgW, contentW, imgH, dlgH } = await dlg(page).evaluate((d: HTMLElement) => {
        const cs = getComputedStyle(d);
        const img = d.querySelector(".rg-export-img") as HTMLImageElement;
        return {
          imgW: img.getBoundingClientRect().width,
          contentW: d.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight),
          imgH: img.getBoundingClientRect().height,
          dlgH: d.clientHeight,
        };
      });
      expect(Math.abs(imgW - contentW)).toBeLessThanOrEqual(2);
      expect(imgH).toBeGreaterThan(dlgH * 0.6); // tall: it is not squeezed to fit, the dialog scrolls instead
      const onScreen = (e: Element) => {
        const r = e.getBoundingClientRect();
        return r.top >= 0 && r.bottom <= window.innerHeight;
      };
      expect(await action(page, "Close").evaluate(onScreen), "Close stays on screen (B1)").toBe(true);
      expect(await dlg(page).getByLabel(/Include appendix/).evaluate(onScreen), "the toggles stay on screen too").toBe(true);
    });
  }
  test("the preview is a link: Tab to it and Enter opens the full-size image in a tab of its own", async ({ page }) => {
    await gotoView(page, EXPORT_HASH, "generated");
    await openPreview(page);
    const link = dlg(page).getByRole("link", { name: "Open full-size image in a new tab" });
    await link.focus();
    await expect(link).toBeFocused();
    const [tab] = await Promise.all([page.context().waitForEvent("page"), page.keyboard.press("Enter")]);
    expect(tab.url()).toMatch(/^blob:/);
    const drawn = () => tab.evaluate(() => (document.images[0]?.naturalWidth ?? 0) > 0);
    await expect.poll(drawn).toBe(true);
    // The preview's own URL is revoked on close; the tab has its own, so it survives that — and a reload.
    await page.bringToFront();
    await page.keyboard.press("Escape");
    expect(await dlg(page).evaluate((d: HTMLDialogElement) => d.open)).toBe(false);
    await tab.reload();
    await expect.poll(drawn).toBe(true);
    await tab.close();
  });
});

test.describe("a short window (round 9)", () => {
  test("at 1280×500 the footer stops pinning: part of the preview shows, and Close is reachable", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 500 });
    await gotoView(page, TALL_HASH, "generated");
    await openPreview(page);
    const visible = await dlg(page).locator(".rg-export-img").evaluate((i) => {
      const r = i.getBoundingClientRect();
      const dlgEl = i.closest("dialog") as HTMLElement;
      const d = dlgEl.getBoundingClientRect();
      // What is not under the footer: a pinned footer covers the bottom of the dialog's view.
      const foot = (dlgEl.querySelector(".rg-export-foot") as HTMLElement).getBoundingClientRect();
      const bottom = Math.min(r.bottom, d.bottom, foot.top > d.top ? foot.top : d.bottom);
      return bottom - Math.max(r.top, d.top);
    });
    // Pinned, the ~150px footer would leave ~256px here; unpinned the preview gets ~390px.
    expect(visible).toBeGreaterThan(320);
    await action(page, "Close").click(); // scrolls to it, as a person would
    expect(await dlg(page).evaluate((d: HTMLDialogElement) => d.open)).toBe(false);
  });
});
