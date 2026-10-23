// Shared page helpers for the Code Map export e2e specs: open a view, open the
// preview, collect downloads to disk, and read PNG pixels back through a canvas.
import { readFileSync } from "node:fs";
import { expect, type Locator, type Page, type TestInfo } from "@playwright/test";

export const viewUrl = (hash: string, source: string): string => `/repo-graph?repo=${hash}&arch-source=${source}`;

export interface Saved {
  name: string;
  path: string;
  bytes: Buffer;
  text: () => string;
}

/** Every download the page fires, saved under the test's output dir (Playwright's own
 * temp names carry no extension, and a file:// HTML page needs one). */
export function collectDownloads(page: Page, info: TestInfo): Saved[] {
  const files: Saved[] = [];
  page.on("download", async (d) => {
    const path = info.outputPath(`${files.length}-${d.suggestedFilename()}`);
    await d.saveAs(path);
    const bytes = readFileSync(path);
    files.push({ name: d.suggestedFilename(), path, bytes, text: () => bytes.toString("utf8") });
  });
  return files;
}

export const dlg = (page: Page): Locator => page.locator("dialog.rg-export-dlg");
export const action = (page: Page, name: string): Locator => dlg(page).getByRole("button", { name, exact: true });

export async function gotoView(page: Page, hash: string, source: string): Promise<void> {
  await page.goto(viewUrl(hash, source));
  await expect(page.locator("#rg-export")).toBeVisible({ timeout: 10_000 });
  await expect(page.locator(".c4-node").first()).toBeVisible({ timeout: 10_000 });
}

/** Click Export and wait for the finished preview (image loaded, actions enabled). */
export async function openPreview(page: Page): Promise<void> {
  await page.locator("#rg-export").click();
  const img = dlg(page).locator(".rg-export-img");
  await expect(img).toBeVisible({ timeout: 20_000 });
  await expect(action(page, "Download PNG")).toBeEnabled({ timeout: 20_000 });
  await expect.poll(() => img.evaluate((e: HTMLImageElement) => e.complete && e.naturalWidth > 0)).toBe(true);
}

export async function waitForFiles(files: Saved[], n: number): Promise<void> {
  await expect.poll(() => files.length, { timeout: 15_000 }).toBe(n);
}

// ── geometry read back from the exported HTML (the SVG travels inside it) ─────────

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** SVG size and the box rect of `id` (in image coordinates: the header offset applied). */
export function svgGeometry(html: string, id: string): { width: number; height: number; box: Rect; title: Rect } {
  const size = /<svg[^>]*\swidth="([\d.]+)" height="([\d.]+)"/.exec(html);
  const shift = /<g transform="translate\(0 ([\d.]+)\)">/.exec(html);
  const box = new RegExp(`<rect data-id="${id}" x="([\\d.]+)" y="([\\d.]+)" width="([\\d.]+)" height="([\\d.]+)"`).exec(html);
  // The title's first line: its box sits on the baseline, one cap height (~13px at 13.5px) above it.
  const t = new RegExp(`<text x="([\\d.]+)" y="([\\d.]+)" data-for="${id}" data-role="title"`).exec(html);
  if (!size || !shift || !box || !t) throw new Error("could not read the SVG geometry from the exported HTML");
  const dy = Number(shift[1]);
  const b = { x: Number(box[1]), y: Number(box[2]) + dy, w: Number(box[3]), h: Number(box[4]) };
  return {
    width: Number(size[1]),
    height: Number(size[2]),
    box: b,
    title: { x: Number(t[1]), y: Number(t[2]) + dy - 13, w: b.x + b.w - 12 - Number(t[1]), h: 17 },
  };
}

// ── pixels: decoded in the browser, only small numbers cross back ────────────────

type Job =
  | { kind: "pixel"; a: string; x: number; y: number }
  | { kind: "ink"; a: string }
  | { kind: "rect"; a: string; r: Rect; ref: { x: number; y: number } }
  | { kind: "diff"; a: string; b: string };

/** One browser-side function (no eval: the page may carry a CSP) that decodes PNGs and answers `job`. */
function run(page: Page, job: Job): Promise<number[]> {
  return page.evaluate(async (j: Job) => {
    const load = async (b64: string) => {
      const bin = atob(b64);
      const u = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i);
      const bmp = await createImageBitmap(new Blob([u], { type: "image/png" }));
      const c = document.createElement("canvas");
      c.width = bmp.width;
      c.height = bmp.height;
      const ctx = c.getContext("2d") as CanvasRenderingContext2D;
      ctx.drawImage(bmp, 0, 0);
      return ctx.getImageData(0, 0, c.width, c.height);
    };
    const img = await load(j.a);
    const d = img.data;
    const far = (i: number, k: number, o = d) => Math.abs(d[i] - o[k]) + Math.abs(d[i + 1] - o[k + 1]) + Math.abs(d[i + 2] - o[k + 2]);
    if (j.kind === "pixel") {
      const i = (j.y * img.width + j.x) * 4;
      return [d[i], d[i + 1], d[i + 2], d[i + 3]];
    }
    if (j.kind === "ink") {
      let n = 0;
      for (let i = 4; i < d.length; i += 4) if (far(i, 0) > 60) n++;
      return [n / (d.length / 4)];
    }
    if (j.kind === "rect") {
      const k = (j.ref.y * img.width + j.ref.x) * 4;
      let n = 0;
      for (let y = j.r.y; y < j.r.y + j.r.h; y++) for (let x = j.r.x; x < j.r.x + j.r.w; x++) if (far((y * img.width + x) * 4, k) > 60) n++;
      return [n];
    }
    const other = await load(j.b);
    if (other.width !== img.width || other.height !== img.height) return [1];
    let n = 0;
    for (let i = 0; i < d.length; i += 4) if (far(i, i, other.data) > 24) n++;
    return [n / (d.length / 4)];
  }, job);
}

export async function pixelAt(page: Page, png: Buffer, x: number, y: number): Promise<number[]> {
  return run(page, { kind: "pixel", a: png.toString("base64"), x, y });
}

/** Share of pixels that differ from the top-left (background) pixel. */
export async function inkShare(page: Page, png: Buffer): Promise<number> {
  return (await run(page, { kind: "ink", a: png.toString("base64") }))[0];
}

/** Pixels inside `r` (image px) that differ from `ref` (a pixel of the same box's fill). */
export async function inkInRect(page: Page, png: Buffer, r: Rect, ref: { x: number; y: number }): Promise<number> {
  return (await run(page, { kind: "rect", a: png.toString("base64"), r, ref }))[0];
}

/** Fraction of pixels whose colour differs by more than a small tolerance (1 when sizes differ). */
export async function diffShare(page: Page, a: Buffer, b: Buffer): Promise<number> {
  return (await run(page, { kind: "diff", a: a.toString("base64"), b: b.toString("base64") }))[0];
}
