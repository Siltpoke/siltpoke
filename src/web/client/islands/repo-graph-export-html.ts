// The HTML half of a finished export build: assemble the single file, then run
// the finished-output privacy nets over the WHOLE file (spec §7.6) — including
// the JSON island, which carries AI text, ids, evidence and listed files the
// SVG never shows. The strings the file embeds verbatim (font CSS, the
// standalone script) are removed before scanning, exactly as the SVG's are.
import type { TrustMap } from "../../../repo-graph/trust-map";
import type { C4Model } from "./repo-graph-c4-model";
import { buildExportHtml } from "../export/build-html";
import { outputSecretBlock } from "../export/preflight";
import { assertNoAbsolutePaths } from "../export/privacy";

export type HtmlOutcome = { ok: true; html: string } | { ok: false; message: string };

interface HtmlInput {
  svg: string;
  width: number;
  height: number;
  model: C4Model;
  trust: TrustMap;
  fontCss: string;
  appendix: boolean;
  script: () => Promise<string>;
}

const errText = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/** Never throws: an HTML problem must not take the PNG down with it. */
export async function buildHtmlOutcome(d: HtmlInput): Promise<HtmlOutcome> {
  try {
    const standaloneJs = await d.script();
    const html = buildExportHtml({ svg: d.svg, width: d.width, height: d.height, model: d.model, trust: d.trust, standaloneJs, appendix: d.appendix });
    assertNoAbsolutePaths(html, [d.fontCss, standaloneJs]);
    const leaked = outputSecretBlock(html, [d.fontCss, standaloneJs], null, "the HTML file");
    return leaked ? { ok: false, message: leaked } : { ok: true, html };
  } catch (err) {
    return { ok: false, message: `HTML export failed — ${errText(err)}` };
  }
}
