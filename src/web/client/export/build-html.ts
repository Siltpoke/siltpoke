// The single-file clickable export (spec §8): the SVG export inline, a JSON
// island with the trust map, and the standalone script inline. Pure string
// building. Nothing here fetches: the CSP below forbids it, and the SVG's own
// @font-face rules are data: URIs. The finished string goes through the
// finished-output privacy nets in repo-graph-export-html.ts before it is offered.
import type { TrustMap } from "../../../repo-graph/trust-map";
import type { C4Model } from "../islands/repo-graph-c4-model";
import { listedEdges } from "./edge-list";
import { HTML_PAGE_CSS } from "./html-css";

const HTML_CSP =
  "default-src 'none'; img-src data: blob:; style-src 'unsafe-inline'; script-src 'unsafe-inline'; font-src data:";

const LICENCE =
  "<!-- Code Map export. Fonts (Pixelify Sans, Geist, JetBrains Mono) are embedded under the SIL Open Font License 1.1, https://openfontlicense.org -->";

interface HtmlParts {
  /** The SVG export, byte for byte (AC27). Its @font-face rules serve the whole page. */
  svg: string;
  width: number;
  height: number;
  /** The model the SVG was drawn from: its edges and outside-system boxes go in the island too. */
  model: C4Model;
  trust: TrustMap;
  /** The built `public/static/export-standalone.js`, inlined as text. */
  standaloneJs: string;
  /** Per-file member lists go in only when the appendix toggle was on (AC26). */
  appendix: boolean;
}

/** JSON for a `<script type="application/json">`: `<` can never open a tag or close
 * the script, and the two line separators are escaped so the text is one safe line. */
function jsonForScript(value: unknown): string {
  return JSON.stringify(value)
    .replace(/</g, "\\u003c")
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");
}

/** What the panel needs — not the stamp (the SVG shows it) and never the on-screen
 * "Key pieces" list. `listedFiles` is emptied here, not trusted to the caller.
 * `edges` is every drawn edge (edge-list.ts) and `nodes` the outside-system and
 * person boxes, so every box has a panel and every drawn edge is in one. */
function islandData(model: C4Model, trust: TrustMap, appendix: boolean): unknown {
  return {
    schema: 1,
    source: trust.source,
    containers: trust.containers.map((c) => ({ ...c, listedFiles: appendix ? c.listedFiles : [] })),
    nodes: Object.entries(model.N)
      .filter(([, n]) => n.kind !== "cont")
      .map(([id, n]) => ({ id, kind: n.kind, title: n.title, desc: n.desc ?? "" })),
    edges: listedEdges(model, trust),
  };
}

export function buildExportHtml(parts: HtmlParts): string {
  // An inline script that could close itself would turn the file into markup.
  if (/<\/script|<!--/i.test(parts.standaloneJs)) throw new Error("standalone script cannot be inlined safely");
  const w = Math.max(1, Math.round(Number(parts.width)) || 1);
  return [
    "<!doctype html>",
    '<html lang="en"><head><meta charset="utf-8">',
    `<meta http-equiv="Content-Security-Policy" content="${HTML_CSP}">`,
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    "<title>Code Map</title>",
    LICENCE,
    `<style>${HTML_PAGE_CSS}</style></head><body>`,
    '<div class="bar"><button id="save-img" type="button">Save as image</button><span id="status" role="status"></span></div>',
    `<div class="wrap"><main id="map" style="max-width:${w}px">${parts.svg}</main>`,
    '<aside id="panel" hidden aria-label="Group details"></aside></div>',
    `<script type="application/json" id="trust">${jsonForScript(islandData(parts.model, parts.trust, parts.appendix))}</script>`,
    `<script>${parts.standaloneJs}</script>`,
    "</body></html>",
  ].join("\n");
}
