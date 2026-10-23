// Code Map export island (spec §7.1, §7.5): the Export button beside the
// source chip, its notice line, and the wiring to the preview dialog. State
// lives in the mountExport closure — nothing at module level, so two mounts
// (or two tests) never share a preview.
import type { C4Model } from "./repo-graph-c4-model";
import { type ExportState, type Ok, wireActions } from "./repo-graph-export-actions";
import { EXPORT_CSS } from "./repo-graph-export-css";
import { createExportDialog, type ExportDialog } from "./repo-graph-export-dialog";
import { type ExportSource, exportButtonState, runExport } from "./repo-graph-export-state";

export { exportButtonState };

const EXPORT_NOTICE = "The image contains folder and file names — check before sharing outside.";

interface ExportCtx {
  getSource: () => ExportSource;
  getModel: () => C4Model | null;
  withRepo: (u: string) => string;
}

/** Button, notice and style, created here (RepoGraph.tsx's length pin cannot grow). */
function mountChrome(host: HTMLElement): { btn: HTMLButtonElement; note: HTMLElement } | null {
  const chip = host.querySelector<HTMLElement>("#rg-src-chip");
  if (!chip) return null;
  const style = document.createElement("style");
  style.textContent = EXPORT_CSS;
  const btn = document.createElement("button");
  btn.className = "src-export";
  btn.id = "rg-export";
  btn.type = "button";
  btn.textContent = "Export";
  btn.hidden = true;
  const note = document.createElement("p");
  note.className = "rg-export-note";
  note.id = "rg-export-note";
  note.textContent = EXPORT_NOTICE;
  note.hidden = true;
  // A sibling of the chip, not inside it: the chip is hidden when there is no
  // Authored/Generated pair to switch (e.g. plain Honest-subset), and Export
  // must still be there (AC1) — and visibly disabled when there is no map (AC3).
  chip.after(btn);
  // The notice is its own row under the page head, in normal flow (like the
  // banners there). Floating it over the toolbar covered the search box and the
  // toolbar buttons at every width (measured in the export e2e).
  const head = chip.closest<HTMLElement>(".pagehead");
  if (head) head.after(note);
  else btn.after(note);
  host.append(style);
  return { btn, note };
}

export function mountExport(host: HTMLElement, ctx: ExportCtx): { refresh: (inArchView: boolean) => void } {
  const chrome = mountChrome(host);
  if (!chrome) return { refresh: () => {} };
  const { btn, note } = chrome;
  const st: ExportState & { source: ExportSource | null; hasMap: boolean } = { source: null, hasMap: true, run: 0, acts: 0, ok: null as Ok | null };

  const applyButton = (inArchView: boolean): void => {
    // A map exists when the page holds a model with at least one box (no probe
    // request) and no build has answered 404 for this source.
    const model = ctx.getModel();
    const hasMap = st.hasMap && !!model && Object.keys(model.N).length > 0;
    const b = exportButtonState(ctx.getSource(), hasMap);
    const visible = inArchView && b.visible;
    btn.hidden = !visible;
    btn.disabled = b.disabled;
    btn.title = b.title;
    note.hidden = !visible;
  };

  async function build(): Promise<void> {
    const model = ctx.getModel();
    const source = ctx.getSource();
    if (!model || source === "codemap") return;
    const mine = ++st.run; // newest build wins; an older one resolving late is dropped
    st.ok = null; // never let Download/Copy act on the previous build
    ui.pending();
    const out = await runExport({ source, model, withRepo: ctx.withRepo, appendix: ui.appendix(), dark: ui.dark() });
    if (mine !== st.run) return;
    if (out.kind === "no-map") {
      st.hasMap = false;
      applyButton(true);
    }
    st.ok = out.kind === "ok" ? out : null;
    ui.show(out);
  }

  const ui: ExportDialog = createExportDialog(() => void build());
  host.append(ui.dlg);
  wireActions(ui, st, ctx);
  btn.addEventListener("click", () => {
    if (btn.disabled || !ctx.getModel()) return;
    st.ok = null;
    ui.reset();
    ui.dlg.showModal();
    void build();
  });

  return {
    refresh(inArchView: boolean): void {
      // No probe request (an extra trust fetch per source change would double the
      // page's own): applyButton derives "has a map" from the model, and a 404 seen
      // when building latches hasMap off for this source as a second net (AC3).
      if (ctx.getSource() !== st.source) {
        st.source = ctx.getSource();
        st.hasMap = true;
      }
      applyButton(inArchView);
    },
  };
}
