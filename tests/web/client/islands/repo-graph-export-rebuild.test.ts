/** M1 — while a toggle flip rebuilds, Download / Copy must not act on the
 * PREVIOUS result. Drives the real island: open the dialog, let build 1 finish,
 * flip a toggle with a deferred fetch, and read the two buttons + what a click saves. */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { trust } from "../../export/fixtures";
import { type Deferred, deferred, installFetchMock, jsonResponse, mountRepoGraph, registerDom, unregisterDom } from "./_dom-harness";

const saved: string[] = [];
const g = globalThis as unknown as Record<string, unknown>;
const keep: Record<string, unknown> = {};
let realAnchorClick: (() => void) | undefined;

beforeAll(() => {
  registerDom();
  // happy-dom cannot paint: stand in for the browser-only rasterizer's inputs.
  for (const k of ["Image", "requestAnimationFrame"]) keep[k] = g[k];
  g.Image = class { src = ""; decode = async () => {}; };
  g.requestAnimationFrame = (f: () => void) => setTimeout(f, 0);
  Object.defineProperty(document, "fonts", { value: { ready: Promise.resolve() }, configurable: true });
  HTMLCanvasElement.prototype.getContext = (() => ({
    drawImage() {},
    getImageData: () => ({ data: [0, 0, 0, 255] }),
  })) as never;
  HTMLCanvasElement.prototype.toBlob = ((cb: (b: Blob) => void) => cb(new Blob(["png"]))) as never;
  URL.createObjectURL = () => "blob:x";
  URL.revokeObjectURL = () => {};
  // Restored in afterAll: the class outlives this file's DOM registration, so a
  // click() left replaced here makes every later file's `<a>.click()` a no-op.
  realAnchorClick = HTMLAnchorElement.prototype.click;
  HTMLAnchorElement.prototype.click = function (this: HTMLAnchorElement) {
    saved.push(this.download);
  };
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
const t = { ...trust({ source: "authored" }), stampLine: "stamp", farBehind: false };
const okBody = () => jsonResponse({ success: true, data: t });

describe("Export dialog while a rebuild is pending (M1)", () => {
  test("Download / Copy are disabled and save nothing until the new result shows", async () => {
    let exporting = false;
    const gates: Array<Deferred<Response>> = [];
    installFetchMock([
      ["/static/fonts/", () => Promise.resolve(new Response(new Uint8Array([1, 2, 3])))],
      ["/static/export-standalone.js", () => Promise.resolve(new Response("/* standalone */"))],
      ["/arch/trust", () => {
        if (!exporting) return Promise.resolve(jsonResponse({ success: false }));
        const d = deferred<Response>();
        gates.push(d);
        return d.promise;
      }],
    ]);
    const root = await mountRepoGraph({ authoredModel: AUTHORED as never });
    await settle();
    const dlg = root.querySelector<HTMLDialogElement>("dialog.rg-export-dlg")!;
    const [dl, cp, htmlBtn] = Array.from(dlg.querySelectorAll<HTMLButtonElement>(".rg-export-actions button"));
    exporting = true;
    root.querySelector<HTMLButtonElement>("#rg-export")!.click();
    await settle();
    gates[0].resolve(okBody());
    await settle();
    expect(dl.disabled).toBe(false); // build 1 is shown
    expect(cp.disabled).toBe(false);
    expect(htmlBtn.disabled).toBe(false);

    dlg.querySelector<HTMLInputElement>("input")!.checked = true;
    dlg.querySelector<HTMLInputElement>("input")!.dispatchEvent(new Event("change"));
    await settle(); // build 2's fetch is still unresolved
    expect(gates).toHaveLength(2);
    expect(dl.disabled).toBe(true);
    expect(cp.disabled).toBe(true);
    expect(htmlBtn.disabled).toBe(true); // Download HTML waits for the new build too
    saved.length = 0;
    dl.click();
    cp.click();
    htmlBtn.click();
    await settle();
    expect(saved).toEqual([]);

    gates[1].resolve(okBody());
    await settle();
    expect(dl.disabled).toBe(false);
    expect(cp.disabled).toBe(false);
    expect(htmlBtn.disabled).toBe(false);
    dl.click();
    expect(saved.filter((n) => n.endsWith(".md"))).toHaveLength(1); // the appendix toggle is on, and the .md now matches it
    saved.length = 0;
    htmlBtn.click();
    // The HTML is the CURRENT build's (appendix on), not build 1's — and the appendix rides with it (F1).
    expect(saved.map((n) => n.replace(/\d{4}-\d{2}-\d{2}/, "D"))).toEqual(["code-map-authored-D.html", "code-map-authored-D.md"]);
  });
});

const openDialog = async (root: HTMLElement, body: () => Response) => {
  installFetchMock([
    ["/static/fonts/", () => Promise.resolve(new Response(new Uint8Array([1, 2, 3])))],
    ["/static/export-standalone.js", () => Promise.resolve(new Response("/* standalone */"))],
    ["/arch/trust", () => Promise.resolve(body())],
  ]);
  root.querySelector<HTMLButtonElement>("#rg-export")!.click();
  await settle();
  return root.querySelector<HTMLDialogElement>("dialog.rg-export-dlg")!;
};

describe("Export dialog contents and the HTML action (AC30, AC24)", () => {
  test("exactly two toggles; the actions are Download PNG, Copy PNG, Download HTML, Close", async () => {
    installFetchMock([["/arch/trust", () => Promise.resolve(jsonResponse({ success: false }))]]);
    const root = await mountRepoGraph({ authoredModel: AUTHORED as never });
    await settle();
    const dlg = await openDialog(root, okBody);
    expect(dlg.querySelectorAll("input")).toHaveLength(2);
    expect(dlg.querySelectorAll<HTMLInputElement>("input[type=checkbox]")).toHaveLength(2);
    const labels = Array.from(dlg.querySelectorAll("label")).map((l) => l.textContent?.trim());
    expect(labels).toEqual(["Include appendix", "Dark background"]);
    const actions = Array.from(dlg.querySelectorAll<HTMLButtonElement>(".rg-export-actions button"));
    expect(actions.map((b) => b.textContent)).toEqual(["Download PNG", "Copy PNG", "Download HTML", "Close"]);
    expect(actions.every((b) => !b.hidden)).toBe(true);
  });

  test("an HTML the output nets refuse is never saved, and says why; the PNG is unaffected", async () => {
    installFetchMock([["/arch/trust", () => Promise.resolve(jsonResponse({ success: false }))]]);
    const root = await mountRepoGraph({ authoredModel: AUTHORED as never });
    await settle();
    // A cited file with a personal path: not in the SVG (so the PNG is clean), but in the HTML's JSON island.
    const dirty = trust({ source: "authored" });
    dirty.edges[2].evidence = { kind: "cited", file: "/home/bob/x.ts", line: 1 };
    const dlg = await openDialog(root, () => jsonResponse({ success: true, data: { ...dirty, stampLine: "stamp", farBehind: false } }));
    const [dl, , htmlBtn] = Array.from(dlg.querySelectorAll<HTMLButtonElement>(".rg-export-actions button"));
    expect(dl.disabled).toBe(false);
    saved.length = 0;
    htmlBtn.click();
    expect(saved).toEqual([]);
    expect(dlg.querySelector(".rg-export-status")!.textContent).toContain("absolute path in export: /home/bob/x.ts");
    dl.click();
    expect(saved.filter((n) => n.endsWith(".png"))).toHaveLength(1);
  });
});
