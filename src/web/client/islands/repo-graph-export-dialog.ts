// The preview dialog for the Code Map export (spec §7.5): DOM only, no fetch.
// Built per mount, so no state is shared between mounts. Every string that
// came from the map is set with textContent.
import type { ExportOutcome } from "./repo-graph-export-state";

type Ok = Extract<ExportOutcome, { kind: "ok" }>;

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls: string, text?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

function toggle(label: string, onChange: () => void): { row: HTMLLabelElement; input: HTMLInputElement } {
  const row = el("label", "rg-export-toggle");
  const input = document.createElement("input");
  input.type = "checkbox";
  input.addEventListener("change", onChange);
  row.append(input, ` ${label}`);
  return { row, input };
}

export interface ExportDialog {
  dlg: HTMLDialogElement;
  appendix: () => boolean;
  dark: () => boolean;
  dlPng: HTMLButtonElement;
  cpPng: HTMLButtonElement;
  dlHtml: HTMLButtonElement;
  closeBtn: HTMLButtonElement;
  /** The one status line, directly under the buttons: what the last action did ("" hides it). */
  say: (text: string) => void;
  /** A build started: the previous result is no longer what the toggles say, so Download/Copy wait. */
  pending: () => void;
  /** Reset for a fresh open: appendix off (Q5 — opt-in each time), dark = the page's theme, preview cleared. */
  reset: () => void;
  show: (out: ExportOutcome) => void;
  dispose: () => void;
}

/** What the appendix is and where it goes: it never changes the image, so without this
 * line ticking the box shows no difference at all (B3). */
const APPENDIX_NOTE =
  "Download PNG and Download HTML each also save a .md appendix: every folder, the files the AI listed, and every edge with its evidence. Copy PNG copies the image only; the image itself does not change.";

/** The page's resolved theme: the dashboard's own override if set, else the system's (B2). */
function pageIsDark(): boolean {
  const forced = document.documentElement.getAttribute("data-theme");
  if (forced === "dark" || forced === "light") return forced === "dark";
  return typeof window.matchMedia === "function" && window.matchMedia("(prefers-color-scheme: dark)").matches;
}

/** Show or hide without changing the layout: the element keeps its space either way, so the
 * dialog and its preview never resize when a note or status line comes and goes (F2). */
function reveal(e: HTMLElement, on: boolean): void {
  e.style.visibility = on ? "visible" : "hidden";
  e.setAttribute("aria-hidden", on ? "false" : "true");
}

function buildControls(onToggle: () => void) {
  const appNote = el("p", "rg-export-appnote", APPENDIX_NOTE);
  reveal(appNote, false);
  const app = toggle("Include appendix", () => {
    reveal(appNote, app.input.checked); // at once, not after the rebuild
    onToggle();
  });
  const dark = toggle("Dark background", onToggle);
  const toggles = el("div", "rg-export-toggles");
  toggles.append(app.row, dark.row);
  const dlPng = el("button", "rg-export-act", "Download PNG");
  const cpPng = el("button", "rg-export-act", "Copy PNG");
  const dlHtml = el("button", "rg-export-act", "Download HTML");
  const closeBtn = el("button", "rg-export-act", "Close");
  const actions = el("div", "rg-export-actions");
  for (const b of [dlPng, cpPng, dlHtml, closeBtn]) b.type = "button";
  actions.append(dlPng, cpPng, dlHtml, closeBtn);
  return { app, appNote, dark, toggles, dlPng, cpPng, dlHtml, closeBtn, actions };
}

/** Under the action buttons, not above the (tall) preview: a message shown where the
 * person is already looking. A polite live region so a screen reader speaks it too. */
function statusLine(): HTMLParagraphElement {
  const p = el("p", "rg-export-status");
  p.setAttribute("role", "status");
  p.setAttribute("aria-live", "polite");
  // Always exposed: a live region that is aria-hidden (or hidden) when its text is written can be
  // skipped by a screen reader. Its line is reserved by CSS min-height; empty text shows nothing.
  return p;
}

function buildPreview() {
  const img = el("img", "rg-export-img");
  img.alt = "Preview of the exported Code Map";
  // Full width in the dialog (a tall map scrolls inside it, the footer stays pinned). The preview
  // is a real link, so the keyboard and screen readers reach "open full size" too; imageSwapper
  // gives it its href.
  const link = el("a", "rg-export-open");
  link.target = "_blank";
  link.rel = "noopener";
  link.setAttribute("aria-label", "Open full-size image in a new tab");
  link.title = "Open full size in a new tab";
  link.hidden = true;
  link.append(img);
  return {
    link,
    banner: el("p", "rg-export-banner"),
    stamp: el("p", "rg-export-stamp"),
    status: statusLine(),
    img,
    scaleLine: el("p", "rg-export-scale"),
  };
}

/** The preview image's source. A new image is decoded off-screen and swapped in only
 * once it can be drawn, so the previous preview stays up meanwhile and a toggle never
 * shows an empty frame (B3). The newest paint wins; an older decode finishing late is dropped. */
function imageSwapper(img: HTMLImageElement, link: HTMLAnchorElement): { paint: (blob: Blob) => void; clear: () => void } {
  let url: string | null = null;
  let shown: Blob | null = null;
  let paints = 0;
  // Each open gets its OWN object URL, made at the click: the preview's URL is revoked on every
  // swap and on close, and a tab still showing it would go blank on reload. The tab's URL is never
  // revoked here — it lives until this page unloads (one small blob per click).
  // Minted before ANY way of opening it: a left click or Enter (click), a middle click or a drag
  // (pointerdown — they fire no click), and "Open link in new tab" from the menu (contextmenu).
  // A pointerdown followed by its click mints twice; the first URL just goes unused.
  const mint = (): void => {
    if (shown) link.href = URL.createObjectURL(shown);
  };
  link.addEventListener("pointerdown", mint);
  link.addEventListener("contextmenu", mint);
  link.addEventListener("click", (e) => {
    if (!shown) return void e.preventDefault();
    mint();
  });
  const clear = (): void => {
    paints++;
    if (url) URL.revokeObjectURL(url);
    url = null;
    shown = null;
    img.removeAttribute("src");
    img.hidden = true;
    link.hidden = true;
    link.removeAttribute("href");
  };
  const paint = (blob: Blob): void => {
    const mine = ++paints;
    const next = URL.createObjectURL(blob);
    const probe = new Image();
    probe.src = next;
    const swap = (): void => {
      if (mine !== paints) return void URL.revokeObjectURL(next);
      const old = url;
      url = next;
      shown = blob;
      img.src = next;
      img.hidden = false;
      link.hidden = false;
      link.href = next; // focusable, and a sensible target until the click mints the tab's own URL
      if (old) URL.revokeObjectURL(old);
    };
    probe.decode().then(swap, swap); // a decode refusal still shows what the browser can draw
  };
  return { paint, clear };
}

export function createExportDialog(onToggle: () => void): ExportDialog {
  const dlg = el("dialog", "rg-export-dlg");
  dlg.setAttribute("aria-label", "Export Code Map");
  const { banner, stamp, status, img, link, scaleLine } = buildPreview();
  const c = buildControls(onToggle);
  const { app, dark, dlPng, cpPng, dlHtml, closeBtn } = c;
  // Everything the person acts on sits in one footer pinned to the dialog's bottom edge: a tall
  // preview scrolls under it, the toggles and buttons never do (B1, round 8).
  const foot = el("div", "rg-export-foot");
  foot.append(c.toggles, c.appNote, c.actions, status);
  dlg.append(banner, stamp, link, scaleLine, foot);

  const swapper = imageSwapper(img, link);
  const dispose = swapper.clear;
  const paint = (ok: Ok): void => {
    swapper.paint(ok.blob);
    banner.textContent = ok.stampLine; // the server's wording, never re-derived
    stamp.textContent = ok.stampLine;
    scaleLine.textContent = ok.label;
  };
  const say = (text: string): void => {
    status.textContent = text;
  };
  // Download PNG / Copy PNG / Download HTML all act on the one finished build.
  const enable = (on: boolean): void => {
    for (const b of [dlPng, cpPng, dlHtml]) b.disabled = !on;
  };
  const pending = (): void => {
    enable(false);
    say("Rendering…");
  };
  const show = (out: ExportOutcome): void => {
    const ok = out.kind === "ok" ? out : null;
    if (!ok) dispose(); // a failure must not leave the previous image looking current
    enable(ok !== null);
    banner.hidden = !ok?.farBehind;
    stamp.hidden = !ok;
    scaleLine.hidden = !ok;
    if (out.kind === "ok") {
      paint(out);
      say("");
    } else say(out.kind === "no-map" ? "No map yet" : out.message);
  };
  const reset = (): void => {
    app.input.checked = false;
    reveal(c.appNote, false);
    dark.input.checked = pageIsDark(); // the page's own theme; the person can still switch (B2)
    show({ kind: "error", message: "Rendering…" });
  };
  return { dlg, appendix: () => app.input.checked, dark: () => dark.input.checked, dlPng, cpPng, dlHtml, closeBtn, say, pending, reset, show, dispose };
}
