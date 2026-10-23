// The Export dialog's actions that need only the finished result — Close,
// Download PNG / HTML and Copy — and the two tokens that keep a slow clipboard
// answer from overwriting a newer status (review L3). Split out of
// repo-graph-export.ts so the real handlers can be driven in a test.
import { exportFileName } from "../export/file-name";
import type { ExportDialog } from "./repo-graph-export-dialog";
import { copyAndReport, type ExportOutcome, type ExportSource } from "./repo-graph-export-state";

export type Ok = Extract<ExportOutcome, { kind: "ok" }>;

function save(blob: Blob, name: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** The appendix, when it was built (toggle on): saved beside whichever file was asked for. */
function saveAppendix(ok: Ok, source: Exclude<ExportSource, "codemap">, now: Date): string[] {
  if (!ok.md) return [];
  const name = exportFileName(source, now, "md");
  save(new Blob([ok.md], { type: "text/markdown" }), name);
  return [name];
}

/** Saves the PNG (and the appendix when on); returns the file names, for the status line. */
function downloadOk(ok: Ok, source: ExportSource): string[] {
  if (source === "codemap") return [];
  const now = new Date();
  const png = exportFileName(source, now, "png");
  save(ok.blob, png);
  return [png, ...saveAppendix(ok, source, now)];
}

/** The HTML file for the CURRENT build, and the appendix beside it when on (F1: the note says
 * both downloads carry it). A file the output nets refused is never saved — nor is its
 * appendix: the person is told why instead, in the same words as for the PNG. */
function downloadHtml(ok: Ok, source: ExportSource, say: (t: string) => void): void {
  if (source === "codemap") return;
  if (!ok.html.ok) {
    say(ok.html.message);
    return;
  }
  const now = new Date();
  const name = exportFileName(source, now, "html");
  save(new Blob([ok.html.html], { type: "text/html" }), name);
  say(`Downloaded ${[name, ...saveAppendix(ok, source, now)].join(" and ")}`);
}

export interface ExportState {
  /** Bumped by every build and by closing the dialog. */
  run: number;
  /** Bumped by every action click, so a slow result can tell it is no longer the latest. */
  acts: number;
  ok: Ok | null;
}

/** Close, Download PNG / HTML and Copy: the actions that need only the finished result. */
export function wireActions(ui: ExportDialog, st: ExportState, ctx: { getSource: () => ExportSource }): void {
  ui.dlg.addEventListener("close", () => {
    st.run++; // drop an in-flight build
    ui.dispose();
    st.ok = null;
  });
  ui.closeBtn.addEventListener("click", () => ui.dlg.close());
  // A click on the backdrop lands on the <dialog> itself, outside its box: close, like Esc (B1).
  // Only when the press started there too: a text selection dragged from inside the dialog
  // out over the backdrop also ends in a click on the <dialog>, and must not lose the export.
  const onBackdrop = (e: MouseEvent): boolean => {
    if (e.target !== ui.dlg) return false;
    const r = ui.dlg.getBoundingClientRect();
    return !(e.clientX >= r.left && e.clientX <= r.right && e.clientY >= r.top && e.clientY <= r.bottom);
  };
  let pressedOnBackdrop = false;
  ui.dlg.addEventListener("pointerdown", (e) => {
    pressedOnBackdrop = onBackdrop(e);
  });
  ui.dlg.addEventListener("click", (e) => {
    const close = pressedOnBackdrop && onBackdrop(e);
    pressedOnBackdrop = false;
    if (close) ui.dlg.close();
  });
  ui.dlPng.addEventListener("click", () => {
    st.acts++;
    const names = st.ok ? downloadOk(st.ok, ctx.getSource()) : [];
    if (names.length) ui.say(`Downloaded ${names.join(" and ")}`);
  });
  ui.dlHtml.addEventListener("click", () => {
    st.acts++;
    if (st.ok) downloadHtml(st.ok, ctx.getSource(), ui.say);
  });
  ui.cpPng.addEventListener("click", () => {
    if (!st.ok) return;
    // The run token: a copy answered after a rebuild, a close or another action does not overwrite that newer status.
    const run = st.run;
    const act = ++st.acts;
    // copyPng calls clipboard.write synchronously (no await before it), so the click's user activation is still live.
    void copyAndReport(st.ok.blob, () => run === st.run && act === st.acts, ui.say);
  });
}

