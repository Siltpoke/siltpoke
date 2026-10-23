/** Every export action says what it did, on a status line under the buttons —
 * not above the tall preview, where a scrolled dialog hides it. Drives the real island. */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { trust } from "../../export/fixtures";
import { installFetchMock, jsonResponse, mountRepoGraph, registerDom, unregisterDom } from "./_dom-harness";

const g = globalThis as unknown as Record<string, unknown>;
const keep: Record<string, unknown> = {};
let realAnchorClick: (() => void) | undefined;

beforeAll(() => {
  registerDom();
  for (const k of ["Image", "requestAnimationFrame", "ClipboardItem"]) keep[k] = g[k];
  g.Image = class { src = ""; decode = async () => {}; };
  g.requestAnimationFrame = (f: () => void) => setTimeout(f, 0);
  Object.defineProperty(document, "fonts", { value: { ready: Promise.resolve() }, configurable: true });
  HTMLCanvasElement.prototype.getContext = (() => ({ drawImage() {}, getImageData: () => ({ data: [0, 0, 0, 255] }) })) as never;
  HTMLCanvasElement.prototype.toBlob = ((cb: (b: Blob) => void) => cb(new Blob(["png"]))) as never;
  URL.createObjectURL = () => "blob:x";
  URL.revokeObjectURL = () => {};
  // Restored in afterAll: the class outlives this file's DOM registration, so a
  // click() left replaced here makes every later file's `<a>.click()` a no-op.
  realAnchorClick = HTMLAnchorElement.prototype.click;
  HTMLAnchorElement.prototype.click = () => {};
  g.ClipboardItem = class { constructor(public d: Record<string, unknown>) {} };
});
afterAll(async () => {
  for (const [k, v] of Object.entries(keep)) g[k] = v;
  if (realAnchorClick) HTMLAnchorElement.prototype.click = realAnchorClick;
  await unregisterDom();
});

const tick = () => new Promise((r) => setTimeout(r, 0));
const settle = async () => {
  for (let i = 0; i < 8; i++) await tick();
};
const AUTHORED = {
  N: { a: { kind: "cont", title: "Alpha", accent: "sky", x: 70, y: 320, w: 170, h: 90 } },
  E: [],
  BANDS: [],
  BOUNDARY: { x: 40, y: 248, w: 800, h: 300, label: "fixture-repo · authored" },
  GROUP_ACCENT: { sky: "#7fb0c8", terra: "#d96b6b", moss: "#7a9a5e", amber: "#e8a85c" },
};
const okData = { ...trust({ source: "authored" }), stampLine: "stamp", farBehind: false };
const COPY_DONE = "Copied — paste it anywhere";
const COPY_REFUSED = "Copy not allowed by the browser — use Download";
const DATE = "\\d{4}-\\d{2}-\\d{2}";

async function open(data: unknown = okData) {
  installFetchMock([
    ["/static/fonts/", () => Promise.resolve(new Response(new Uint8Array([1, 2, 3])))],
    ["/static/export-standalone.js", () => Promise.resolve(new Response("/* standalone */"))],
    ["/arch/trust", () => Promise.resolve(jsonResponse({ success: true, data }))],
  ]);
  const root = await mountRepoGraph({ authoredModel: AUTHORED as never });
  await settle();
  root.querySelector<HTMLButtonElement>("#rg-export")!.click();
  await settle();
  const dlg = root.querySelector<HTMLDialogElement>("dialog.rg-export-dlg")!;
  const [dl, cp, html] = Array.from(dlg.querySelectorAll<HTMLButtonElement>(".rg-export-actions button"));
  const status = dlg.querySelector<HTMLElement>(".rg-export-status")!;
  return { dlg, dl, cp, html, status };
}

/** The status line keeps its space (CSS min-height) and is never hidden from assistive tech:
 * "shown" means it has text. It is a live region, so it must never be display:none or
 * aria-hidden — an announcement written into a hidden region can be skipped (round 7). */
const shown = (e: HTMLElement): boolean => {
  expect(e.hidden).toBe(false);
  expect(e.hasAttribute("aria-hidden")).toBe(false);
  expect(e.style.visibility).not.toBe("hidden");
  return (e.textContent ?? "") !== "";
};

describe("export status line", () => {
  test("sits under the action buttons, after the preview; empty (its line kept) when there is nothing to say, and never hidden", async () => {
    const { dlg, status } = await open();
    // The status is the last line of the pinned footer (under the buttons), which follows the preview.
    const foot = dlg.querySelector(".rg-export-foot")!;
    const kids = Array.from(foot.children);
    expect(status.parentElement).toBe(foot as HTMLElement);
    expect(kids.indexOf(status)).toBe(kids.length - 1);
    expect(kids.indexOf(status)).toBeGreaterThan(kids.indexOf(dlg.querySelector(".rg-export-actions")!));
    const top = Array.from(dlg.children);
    expect(top.indexOf(foot)).toBeGreaterThan(top.indexOf(dlg.querySelector(".rg-export-img")!));
    expect(shown(status)).toBe(false);
    expect(status.getAttribute("role")).toBe("status");
  });
  test("Download PNG names the file; with the appendix on it names both", async () => {
    const { dlg, dl, status } = await open();
    dl.click();
    expect(shown(status)).toBe(true);
    expect(status.textContent).toMatch(new RegExp(`^Downloaded code-map-authored-${DATE}\\.png$`));
    const box = dlg.querySelector<HTMLInputElement>("input")!;
    box.checked = true;
    box.dispatchEvent(new Event("change"));
    await settle();
    expect(shown(status)).toBe(false); // a fresh build clears the last message
    dl.click();
    expect(status.textContent).toMatch(new RegExp(`^Downloaded code-map-authored-${DATE}\\.png and code-map-authored-${DATE}\\.md$`));
  });
  test("Download HTML names the file", async () => {
    const { html, status } = await open();
    html.click();
    expect(status.textContent).toMatch(new RegExp(`^Downloaded code-map-authored-${DATE}\\.html$`));
  });
  test("Rendering… shows on the same line while a build is pending", async () => {
    const { dlg, status } = await open();
    const box = dlg.querySelector<HTMLInputElement>("input")!;
    box.checked = true;
    box.dispatchEvent(new Event("change")); // build starts; the fetch resolves on later ticks
    expect(shown(status)).toBe(true);
    expect(status.textContent).toBe("Rendering…");
    await settle();
  });
  test("a blocked map says why on the status line", async () => {
    const dirty = { ...okData, containers: okData.containers.map((c, i) => (i === 0 ? { ...c, desc: "key AKIAABCDEFGHIJKLMNOP" } : c)) };
    const { status } = await open(dirty);
    expect(shown(status)).toBe(true);
    expect(status.textContent).toContain("looks like it contains a secret");
  });
});

describe("Copy PNG", () => {
  const withClipboard = (write: (items: unknown[]) => Promise<void>) =>
    Object.defineProperty(navigator, "clipboard", { value: { write }, configurable: true });
  test("success says Copied — paste it anywhere, and write is called inside the click, before any await", async () => {
    const calls: unknown[][] = [];
    withClipboard(async (items) => { calls.push(items); });
    const { cp, status } = await open();
    cp.click();
    expect(calls).toHaveLength(1); // synchronously: the click's user activation is still live
    const item = calls[0][0] as { d: Record<string, unknown> };
    expect(Object.keys(item.d)).toEqual(["image/png"]);
    expect(await item.d["image/png"]).toBeInstanceOf(Blob);
    await settle();
    expect(status.textContent).toBe(COPY_DONE);
  });
  test("a refusal keeps the exact prefix and names the browser's error", async () => {
    withClipboard(async () => { throw new DOMException("no", "NotAllowedError"); });
    const { cp, status } = await open();
    cp.click();
    await settle();
    expect(status.textContent).toBe(`${COPY_REFUSED} (NotAllowedError)`);
  });
});
