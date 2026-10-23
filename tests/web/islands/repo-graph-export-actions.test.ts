/** Review L3, delivery half: the REAL Close / Download / Copy handlers keep a slow
 * clipboard answer from overwriting a newer status. Driven through wireActions and
 * the real dialog, with only the clipboard's answer held back. */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { type ExportState, type Ok, wireActions } from "../../../src/web/client/islands/repo-graph-export-actions";
import { createExportDialog, type ExportDialog } from "../../../src/web/client/islands/repo-graph-export-dialog";
import { deferred, registerDom, unregisterDom } from "../client/islands/_dom-harness";

beforeAll(registerDom);
afterAll(unregisterDom);

const COPIED = "Copied — paste it anywhere";
let answer: ReturnType<typeof deferred<void>>;
let ui: ExportDialog;
let st: ExportState;

const ok = (): Ok => ({
  kind: "ok",
  blob: new Blob(["png"], { type: "image/png" }),
  md: null,
  html: { ok: true, html: "<!doctype html>" },
  label: "Rendered at 2×",
  stampLine: "stamp",
  farBehind: false,
});
const status = (): string => ui.dlg.querySelector(".rg-export-status")?.textContent ?? "";
const click = (b: HTMLElement): void => void b.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
/** Let the held clipboard answer arrive, and every continuation after it run. */
async function arrive(): Promise<void> {
  answer.resolve();
  for (let i = 0; i < 5; i++) await Promise.resolve();
}

beforeEach(() => {
  answer = deferred<void>();
  Object.defineProperty(navigator, "clipboard", { configurable: true, value: { write: () => answer.promise } });
  ui = createExportDialog(() => {});
  document.body.replaceChildren(ui.dlg);
  st = { run: 0, acts: 0, ok: ok() };
  wireActions(ui, st, { getSource: () => "generated" });
});

describe("a late copy answer never overwrites a newer status", () => {
  test("control: answered with nothing in between, it is reported", async () => {
    click(ui.cpPng);
    await arrive();
    expect(status()).toBe(COPIED);
  });
  test("after Download PNG", async () => {
    click(ui.cpPng);
    click(ui.dlPng);
    const downloaded = status();
    expect(downloaded).toMatch(/^Downloaded code-map-generated-.*\.png$/);
    await arrive();
    expect(status()).toBe(downloaded);
  });
  test("after Download HTML", async () => {
    click(ui.cpPng);
    click(ui.dlHtml);
    const downloaded = status();
    expect(downloaded).toMatch(/^Downloaded code-map-generated-.*\.html$/);
    await arrive();
    expect(status()).toBe(downloaded);
  });
  test("after the dialog closed", async () => {
    click(ui.cpPng);
    ui.dlg.dispatchEvent(new window.Event("close"));
    const after = status();
    await arrive();
    expect(status()).toBe(after);
    expect(status()).not.toBe(COPIED);
  });
});

describe("a click outside the dialog closes it — only when it started outside too", () => {
  /** happy-dom lays nothing out: the dialog's box is 0×0 at the origin, so (500, 500) is outside it. */
  const at = (type: string, target: EventTarget) =>
    target.dispatchEvent(new window.MouseEvent(type, { bubbles: true, clientX: 500, clientY: 500 }));
  const open = (): void => {
    ui.dlg.setAttribute("open", "");
  };
  test("press and release on the backdrop: closes", () => {
    open();
    at("pointerdown", ui.dlg);
    at("click", ui.dlg);
    expect(ui.dlg.open).toBe(false);
  });
  test("a text-selection drag that starts inside and ends over the backdrop does not close (the export is kept)", () => {
    open();
    const inside = ui.dlg.querySelector(".rg-export-status") as HTMLElement;
    at("pointerdown", inside);
    at("click", ui.dlg); // the browser targets the dialog: the common ancestor of press and release
    expect(ui.dlg.open).toBe(true);
  });
});

describe("with the appendix on, both downloads save it (F1)", () => {
  const MD = /code-map-generated-\d{4}-\d{2}-\d{2}\.md/;
  test("Download PNG: the .png and the .md", () => {
    st.ok = { ...ok(), md: "# appendix" };
    click(ui.dlPng);
    expect(status()).toMatch(/^Downloaded code-map-generated-.*\.png and code-map-generated-.*\.md$/);
  });
  test("Download HTML: the .html and the .md", () => {
    st.ok = { ...ok(), md: "# appendix" };
    click(ui.dlHtml);
    expect(status()).toMatch(/^Downloaded code-map-generated-.*\.html and code-map-generated-.*\.md$/);
  });
  test("appendix off: each saves its own file only", () => {
    click(ui.dlHtml);
    expect(status()).not.toMatch(MD);
    click(ui.dlPng);
    expect(status()).not.toMatch(MD);
  });
  test("a refused HTML file saves nothing, the appendix included", () => {
    st.ok = { ...ok(), md: "# appendix", html: { ok: false, message: "refused: a secret" } };
    click(ui.dlHtml);
    expect(status()).toBe("refused: a secret");
  });
});

describe("the appendix is really saved, not just named (round 7)", () => {
  /** Every blob handed to a download link, by its type: the real save() path, spied at URL.createObjectURL. */
  function spySaves(): { types: string[]; restore: () => void } {
    const types: string[] = [];
    const real = URL.createObjectURL;
    URL.createObjectURL = ((b: Blob) => {
      types.push(b.type);
      return real.call(URL, b);
    }) as typeof URL.createObjectURL;
    return { types, restore: () => { URL.createObjectURL = real; } };
  }
  test("Download HTML with the appendix on saves two blobs: the page and the markdown", () => {
    st.ok = { ...ok(), md: "# appendix" };
    const spy = spySaves();
    try {
      click(ui.dlHtml);
      expect(spy.types).toEqual(["text/html", "text/markdown"]);
    } finally {
      spy.restore();
    }
  });
  test("Download PNG with the appendix on saves the image and the markdown", () => {
    st.ok = { ...ok(), md: "# appendix" };
    const spy = spySaves();
    try {
      click(ui.dlPng);
      expect(spy.types).toEqual(["image/png", "text/markdown"]);
    } finally {
      spy.restore();
    }
  });
});
