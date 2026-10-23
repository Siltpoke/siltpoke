// Page CSS for the single-file HTML export (spec §8). System colours only, so the
// file follows the viewer's light/dark setting and carries no palette of its own;
// the map itself is the SVG, which paints its own background. Fonts come from the
// @font-face rules inside that SVG (an inline <svg>'s <style> is document-wide).
export const HTML_PAGE_CSS = `
:root{color-scheme:light dark}
body{margin:0;font:14px/1.45 Geist,system-ui,sans-serif;background:Canvas;color:CanvasText}
.bar{display:flex;gap:12px;align-items:center;padding:8px 16px;border-bottom:1px solid GrayText}
.bar button,#panel button{font:inherit;padding:4px 12px;border:1px solid GrayText;border-radius:6px;background:ButtonFace;color:ButtonText;cursor:pointer}
#status{color:GrayText}
.wrap{display:flex;gap:16px;align-items:flex-start;padding:16px}
#map{flex:1 1 auto;min-width:0;overflow:auto}
#map svg{display:block;max-width:100%;height:auto}
#map [data-id],#map [data-node],#map [data-for]{cursor:pointer}
#map [data-id][data-selected],#map [data-node][data-selected]{stroke:Highlight;stroke-width:2.5}
#panel{position:fixed;right:16px;top:12px;width:320px;max-width:100%;box-sizing:border-box;overflow:auto;padding:12px 14px;border:1px solid GrayText;border-radius:8px;background:Canvas}
body.panel-open #map{margin-right:336px}
#map [data-id]:focus-visible,#map [data-node]:focus-visible{outline:2px solid Highlight;outline-offset:2px}
#panel[hidden]{display:none}
#panel h2{margin:0 0 6px;font-size:16px}
#panel h3{margin:14px 0 4px;font-size:12px;color:GrayText}
#panel p{margin:0}
#panel ul{margin:0;padding-left:18px}
#panel .mono{font-family:"JetBrains Mono",ui-monospace,monospace;font-size:12px}
#panel .note{color:GrayText;font-size:12px}
#panel ul.conns{list-style:none;padding-left:0}
#panel ul.conns li{margin:0 0 8px}
#panel .conn{display:block;white-space:pre-wrap}
#panel .evidence{display:block;padding-left:2.2em;color:GrayText;font-size:12px}
#panel > button{margin-top:16px}
@media (max-width:760px){.wrap{flex-direction:column}#panel{position:static;width:100%}body.panel-open #map{margin-right:0}}
`;
