// Styles for the Export button, its notice and the preview dialog. Injected by
// the island (mountExport) rather than written into RepoGraph.tsx, whose
// function-length pin cannot grow. Tokens only — no literal colours.
export const EXPORT_CSS = `
.rg-host .src-export{font-family:var(--mono);font-size:11px;padding:3px 11px;border:1px solid var(--edge);border-radius:999px;background:var(--cream);color:var(--ink2);cursor:pointer;white-space:nowrap;flex-shrink:0}
.rg-host .src-export[hidden]{display:none}
.rg-host .src-export[disabled]{opacity:.45;cursor:default}
.rg-host .rg-export-note{margin:0;padding:3px 20px;font-size:11px;line-height:1.35;color:var(--ink3);font-family:var(--body);background:var(--cream);border-bottom:1px solid var(--edge);flex-shrink:0}
.rg-host .rg-export-note[hidden]{display:none}
.rg-host .rg-export-dlg{width:min(94vw,1200px);max-width:none;box-sizing:border-box;max-height:90vh;overflow:auto;scrollbar-gutter:stable;background:var(--paper);color:var(--ink);border:1px solid var(--edge);border-radius:var(--radius-sm);padding:16px;font-family:var(--body);font-size:13px}
.rg-host .rg-export-dlg::backdrop{background:color-mix(in srgb, var(--ink) 45%, transparent)}
.rg-host .rg-export-img{display:block;width:100%;height:auto;box-sizing:border-box;border:1px solid var(--edge);margin:8px 0;cursor:zoom-in}
.rg-host .rg-export-banner{margin:0 0 8px;padding:6px 10px;background:color-mix(in srgb, var(--amber) 18%, var(--paper));border:1px solid var(--amber);border-radius:var(--radius-sm)}
.rg-host .rg-export-toggles{display:flex;gap:16px;margin:8px 0}
.rg-host .rg-export-actions{display:flex;gap:8px}
.rg-host .rg-export-open{display:block}
.rg-host .rg-export-open:focus-visible{outline:2px solid var(--ink);outline-offset:2px}
.rg-host .rg-export-foot{position:sticky;bottom:-16px;margin:0 -16px -16px;padding:4px 16px 12px;background:var(--paper);border-top:1px solid var(--edge)}
.rg-host .rg-export-appnote{margin:0 0 8px;font-size:12px;color:var(--ink2)}
.rg-host .rg-export-status{margin:10px 0 0;font-size:12px;color:var(--ink2);min-height:1.4em}
.rg-host .rg-export-act{font:inherit;padding:5px 12px;border:1px solid var(--edge);background:var(--cream);color:var(--ink);border-radius:var(--radius-sm);cursor:pointer}
.rg-host .rg-export-act[disabled]{opacity:.45;cursor:default}
.rg-host .rg-export-dlg [hidden]{display:none}
@media (max-height:520px){.rg-host .rg-export-foot{position:static;margin:0;padding:4px 0 0;border-top:0}.rg-host .rg-export-toggles{margin:4px 0}}
`;
