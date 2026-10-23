// Code Map export — the parts of the Export button that are not DOM: button
// state, the fetch → preflight → build → rasterize pipeline, and the copy
// call. Pure functions over injected dependencies, so every failure path is
// testable without a browser. The DOM half is repo-graph-export.ts.
import type { TrustMap, TrustSource } from "../../../repo-graph/trust-map";
import { buildAppendixMd } from "../export/appendix";
import { buildExportSvg } from "../export/build-svg";
import { fontFaceCss } from "../export/fonts";
import { outputSecretBlock, privacyBlock } from "../export/preflight";
import { assertNoAbsolutePaths } from "../export/privacy";
import type { rasterize } from "../export/rasterize";
import { renderPng } from "../export/render-png";
import { scaleLabel } from "../export/scale";
import { standaloneJs } from "../export/standalone-js";
import type { C4Model } from "./repo-graph-c4-model";
import { buildHtmlOutcome, type HtmlOutcome } from "./repo-graph-export-html";

export type ExportSource = TrustSource | "codemap";
/** The endpoint's `data`: the trust map plus the two server-worded fields. */
type TrustResponse = TrustMap & { stampLine: string; farBehind: boolean };

const NO_MAP_TITLE = "No map yet";
const COPY_REFUSED = "Copy not allowed by the browser — use Download";

export function exportButtonState(
  source: ExportSource,
  hasMap: boolean,
): { visible: boolean; disabled: boolean; title: string } {
  const visible = source === "generated" || source === "authored" || source === "subset";
  if (!visible) return { visible: false, disabled: false, title: "" };
  return hasMap
    ? { visible, disabled: false, title: "Export this map as an image" }
    : { visible, disabled: true, title: NO_MAP_TITLE };
}

export type ExportOutcome =
  | { kind: "ok"; blob: Blob; md: string | null; html: HtmlOutcome; label: string; stampLine: string; farBehind: boolean }
  | { kind: "no-map" }
  | { kind: "blocked"; message: string }
  | { kind: "error"; message: string };

interface ExportDeps {
  source: TrustSource;
  model: C4Model;
  withRepo: (url: string) => string;
  appendix: boolean;
  dark: boolean;
  fetchImpl?: typeof fetch;
  fontCss?: () => Promise<string>;
  raster?: typeof rasterize;
  script?: () => Promise<string>;
}

const errText = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/** Fetch the trust map fresh (the citation re-check runs server-side on every
 * request). `appendix=1` only when the appendix toggle is on (Q5 opt-in). */
async function fetchTrust(d: ExportDeps): Promise<TrustResponse | "no-map"> {
  const q = `source=${d.source}${d.appendix ? "&appendix=1" : ""}`;
  const res = await (d.fetchImpl ?? fetch)(d.withRepo(`/api/repo-graph/arch/trust?${q}`));
  if (res.status === 404) return "no-map";
  const body = (await res.json().catch(() => null)) as { success?: boolean; data?: TrustResponse } | null;
  if (!res.ok || !body?.success || !body.data) throw new Error(`could not load the map's trust data (HTTP ${res.status})`);
  return body.data;
}

export async function runExport(d: ExportDeps): Promise<ExportOutcome> {
  try {
    const trust = await fetchTrust(d);
    if (trust === "no-map") return { kind: "no-map" };
    const blocked = privacyBlock(d.model, trust, trust.stampLine);
    if (blocked) return { kind: "blocked", message: blocked };
    // Sanitized once: the SVG embeds exactly this string, and the path check removes exactly this string.
    const fontCss = (await (d.fontCss ?? (() => fontFaceCss()))()).replaceAll("<", "");
    const { svg, width, height } = buildExportSvg(d.model, trust, {
      theme: d.dark ? "dark" : "light",
      fontCss,
      stampLine: trust.stampLine,
      appendix: d.appendix,
    });
    assertNoAbsolutePaths(svg, [fontCss]);
    let md: string | null = null;
    if (d.appendix) {
      md = buildAppendixMd(d.model, trust, trust.stampLine);
      assertNoAbsolutePaths(md);
    }
    const leaked = outputSecretBlock(svg, [fontCss], md);
    if (leaked) return { kind: "blocked", message: leaked };
    const { blob, choice } = await renderPng(svg, width, height, d.raster);
    const html = await buildHtmlOutcome({ svg, width, height, model: d.model, trust, fontCss, appendix: d.appendix, script: d.script ?? (() => standaloneJs()) });
    return { kind: "ok", blob, md, html, label: scaleLabel(choice), stampLine: trust.stampLine, farBehind: trust.farBehind };
  } catch (err) {
    return { kind: "error", message: `Export failed — ${errText(err)}` };
  }
}

const COPY_DONE = "Copied — paste it anywhere";

/** Write the PNG to the clipboard; a refusal (permission / insecure context /
 * no ClipboardItem) is a message, never a throw — Download stays available.
 * `clip.write` is called before any await, so the caller's click activation is
 * still live (Safari and Chromium both require it). The item's value is a
 * Promise, the form WebKit documents for images; Chromium accepts it too. The
 * refusal keeps COPY_REFUSED as its prefix and appends the browser's own error
 * name, so the next manual test says why. */
async function copyPng(
  blob: Blob,
  clip: { write?: Clipboard["write"] } | undefined = globalThis.navigator?.clipboard,
  Item: typeof ClipboardItem | undefined = globalThis.ClipboardItem,
): Promise<{ ok: boolean; message: string }> {
  if (!clip?.write || !Item) return { ok: false, message: `${COPY_REFUSED} (${clip?.write ? "ClipboardItem" : "clipboard"} unavailable)` };
  try {
    await clip.write([new Item({ "image/png": Promise.resolve(blob) })]);
    return { ok: true, message: COPY_DONE };
  } catch (e) {
    return { ok: false, message: `${COPY_REFUSED} (${e instanceof Error ? e.name : "error"})` };
  }
}

/** Copy, then report — unless something newer has happened since the click: a
 * late clipboard answer must not overwrite a newer build's or action's status
 * (review L3). `stillCurrent` is the caller's run-token check. The write itself
 * is still issued before any await (see copyPng). */
export async function copyAndReport(
  blob: Blob,
  stillCurrent: () => boolean,
  say: (message: string) => void,
  clip?: { write?: Clipboard["write"] },
  Item?: typeof ClipboardItem,
): Promise<void> {
  const r = await copyPng(blob, clip, Item);
  if (stillCurrent()) say(r.message);
}
