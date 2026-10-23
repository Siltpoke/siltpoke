/** The preview's image swap (review round 4, item 2): a new preview is decoded off-screen
 * and swapped in only when ready; the newest wins, a refused decode still shows, and a
 * decode that finishes after the dialog closed changes nothing. `Image.decode` is stubbed
 * so each test decides when (and how) every decode settles. */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { createExportDialog, type ExportDialog } from "../../../src/web/client/islands/repo-graph-export-dialog";
import type { ExportOutcome } from "../../../src/web/client/islands/repo-graph-export-state";
import { deferred, registerDom, unregisterDom } from "../client/islands/_dom-harness";

beforeAll(registerDom);
afterAll(unregisterDom);

interface Probe {
  src: string;
  settle: ReturnType<typeof deferred<void>>;
}
let probes: Probe[];
let realImage: typeof Image;
let ui: ExportDialog;

beforeEach(() => {
  probes = [];
  realImage = globalThis.Image;
  // Each off-screen probe records the URL it was given and waits for the test to settle it.
  (globalThis as { Image: unknown }).Image = class {
    src = "";
    settle = deferred<void>();
    constructor() {
      probes.push(this);
    }
    decode(): Promise<void> {
      return this.settle.promise;
    }
  };
  ui = createExportDialog(() => {});
  document.body.replaceChildren(ui.dlg);
  ui.reset();
});
afterEach(() => {
  (globalThis as { Image: unknown }).Image = realImage;
});

const ok = (label: string): ExportOutcome => ({
  kind: "ok",
  blob: new Blob([label], { type: "image/png" }),
  md: null,
  html: { ok: true, html: "" },
  label,
  stampLine: "stamp",
  farBehind: false,
});
const img = (): HTMLImageElement => ui.dlg.querySelector(".rg-export-img") as HTMLImageElement;
const flush = async (): Promise<void> => {
  for (let i = 0; i < 5; i++) await Promise.resolve();
};

describe("preview image swap", () => {
  test("the old preview stays until the new one has decoded", async () => {
    ui.show(ok("one"));
    probes[0].settle.resolve();
    await flush();
    const first = img().getAttribute("src");
    expect(first).toBe(probes[0].src);
    ui.show(ok("two"));
    await flush();
    expect(img().getAttribute("src")).toBe(first); // not blanked while "two" decodes
    probes[1].settle.resolve();
    await flush();
    expect(img().getAttribute("src")).toBe(probes[1].src);
  });
  test("two quick toggles: the newest wins even when the older decode finishes last", async () => {
    ui.show(ok("one"));
    ui.show(ok("two"));
    probes[1].settle.resolve();
    await flush();
    probes[0].settle.resolve();
    await flush();
    expect(img().getAttribute("src")).toBe(probes[1].src);
    expect(img().hidden).toBe(false);
  });
  test("a refused decode still shows the image (the browser may draw what it could not pre-decode)", async () => {
    ui.show(ok("one"));
    probes[0].settle.reject(new Error("EncodingError"));
    await flush();
    expect(img().getAttribute("src")).toBe(probes[0].src);
    expect(img().hidden).toBe(false);
  });
  test("a decode that finishes after the dialog closed changes nothing", async () => {
    ui.show(ok("one"));
    ui.dispose(); // what closing does
    probes[0].settle.resolve();
    await flush();
    expect(img().hasAttribute("src")).toBe(false);
    expect(img().hidden).toBe(true);
  });
});

describe("open full size (round 9)", () => {
  const link = (): HTMLAnchorElement => ui.dlg.querySelector("a.rg-export-open") as HTMLAnchorElement;
  const clickLink = (): MouseEvent => {
    const ev = new window.MouseEvent("click", { bubbles: true, cancelable: true });
    link().dispatchEvent(ev);
    return ev;
  };
  test("the preview is a real link: new tab, no opener, a name a screen reader can say", async () => {
    ui.show(ok("one"));
    probes[0].settle.resolve();
    await flush();
    expect(link().contains(img())).toBe(true);
    expect(link().target).toBe("_blank");
    expect(link().rel.split(/\s+/)).toContain("noopener");
    expect(link().getAttribute("aria-label")).toBe("Open full-size image in a new tab");
    expect(link().hasAttribute("href")).toBe(true); // focusable
  });
  test("each open gets its own object URL, not the preview's (which is revoked on the next swap)", async () => {
    ui.show(ok("one"));
    probes[0].settle.resolve();
    await flush();
    const ev = clickLink();
    ev.preventDefault(); // keep the test page where it is
    expect(link().href.startsWith("blob:")).toBe(true);
    expect(link().href).not.toBe(img().getAttribute("src"));
  });
  test("with no image yet, the link does nothing", () => {
    ui.show(ok("one")); // still decoding: nothing shown
    expect(link().hidden).toBe(true);
    expect(link().hasAttribute("href")).toBe(false);
    expect(clickLink().defaultPrevented).toBe(true);
  });
});

describe("open full size — every way of opening, and after close (round 10)", () => {
  const link = (): HTMLAnchorElement => ui.dlg.querySelector("a.rg-export-open") as HTMLAnchorElement;
  test("a middle-click press and the context menu also get the tab its own URL first (round 10)", async () => {
    ui.show(ok("one"));
    probes[0].settle.resolve();
    await flush();
    const preview = img().getAttribute("src");
    link().dispatchEvent(new window.MouseEvent("pointerdown", { bubbles: true, button: 1 }));
    const afterMiddle = link().href;
    expect(afterMiddle.startsWith("blob:")).toBe(true);
    expect(afterMiddle).not.toBe(preview);
    link().dispatchEvent(new window.MouseEvent("contextmenu", { bubbles: true, cancelable: true }));
    expect(link().href).not.toBe(afterMiddle); // a fresh one again
    expect(link().href).not.toBe(preview);
  });
  test("once cleared (the dialog closed), the link is hidden, has no href, and is not focusable", async () => {
    ui.show(ok("one"));
    probes[0].settle.resolve();
    await flush();
    expect(link().hidden).toBe(false);
    ui.dispose();
    expect(link().hidden).toBe(true);
    // Not focusable in a browser: an <a> with no href is not in the tab order, and a hidden one
    // is not rendered at all (happy-dom does not model focusability, so both are asserted instead).
    expect(link().hasAttribute("href")).toBe(false);
  });
});
