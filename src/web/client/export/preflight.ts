// Export preflight (spec §7.6): the ONE list of AI-written strings the export
// draws, and the two pre-render checks over it. A field added to build-svg or
// the appendix that carries AI prose must be added to collectAiStrings, or it
// ships unscanned — tests/web/export/preflight.test.ts pins each field kind
// through privacyBlock, the only entry point.
import type { TrustMap } from "../../../repo-graph/trust-map";
import type { C4Model } from "../islands/repo-graph-c4-model";
import { findPathShaped, findSecretShaped, findSecretShapedInMarkup } from "./privacy";

interface AiString {
  where: string;
  text: string;
}

/** Everything else the output carries that no person typed but a bad map can fill:
 * ids (the `id:` lines, edge cells and data-id attributes), evidence text, folder
 * names, the `Not shown` folders, the stamp line and the listed files. Scanned for secrets only — a path here is caught on the finished
 * output (a folder path is legitimate data, not AI prose). `where` never echoes
 * the value; ids come first so a secret in an id is named by position. */
function collectDataStrings(model: C4Model, trust: TrustMap, stampLine: string | undefined): AiString[] {
  const out: AiString[] = [];
  trust.containers.forEach((c, i) => {
    out.push({ where: `container ${i + 1} id`, text: c.id });
  });
  Object.keys(model.N).forEach((id, i) => {
    out.push({ where: `node ${i + 1} id`, text: id });
  });
  model.E.forEach(([s, t], i) => {
    out.push({ where: `edge ${i + 1} ends`, text: `${s} ${t}` });
  });
  trust.edges.forEach((e, i) => {
    const where = `edge ${i + 1}`;
    out.push({ where: `${where} ends`, text: `${e.source} ${e.target}` });
    if (e.evidence.kind === "cited") out.push({ where: `${where} evidence`, text: e.evidence.file });
    if (e.evidence.kind === "none") out.push({ where: `${where} evidence`, text: e.evidence.reason });
  });
  for (const c of trust.containers) for (const f of c.listedFiles) out.push({ where: c.id, text: f });
  trust.containers.forEach((c, i) => {
    c.folders.forEach((f, j) => {
      out.push({ where: `container ${i + 1} folder ${j + 1}`, text: f.folder });
    });
  });
  trust.notShown.forEach((f, i) => {
    out.push({ where: `not-shown folder ${i + 1}`, text: f });
  });
  if (stampLine !== undefined) out.push({ where: "stamp line", text: stampLine });
  return out;
}

/** Container titles and descriptions, edge verbs, band labels and the boundary
 * label — from BOTH the trust map (appendix) and the C4 model (what build-svg
 * draws: node titles of every kind, ext/person descriptions, edge verbs, bands, boundary). `where` names
 * the container id for the ones that have one. */
function collectAiStrings(model: C4Model, trust: TrustMap): AiString[] {
  const out: AiString[] = [];
  for (const c of trust.containers) {
    // The id names the container: a title is the very text that may hold the secret,
    // and the message must not echo it.
    out.push({ where: c.id, text: c.title });
    out.push({ where: c.id, text: c.desc });
  }
  for (const [i, [id, n]] of Object.entries(model.N).entries()) {
    out.push({ where: id, text: n.title });
    // Every box draws its own description now (groups too, since 2026-09-29), named by position.
    if (n.desc) out.push({ where: `node ${i + 1} description`, text: n.desc });
  }
  for (const [s, t, verb] of model.E) out.push({ where: `edge ${s} → ${t}`, text: verb });
  for (const e of trust.edges) out.push({ where: `edge ${e.source} → ${e.target}`, text: e.verb });
  for (const [i, b] of model.BANDS.entries()) out.push({ where: `band ${i + 1}`, text: b.label });
  out.push({ where: "boundary label", text: model.BOUNDARY.label });
  return out;
}

const secretMessage = (where: string): string =>
  `A group description looks like it contains a secret (${where}) — regenerate the map before sharing`;

/** Second net, on the finished output: the SVG or HTML (`embedded` = the exact
 * strings put into it verbatim — font CSS, the standalone script — removed before
 * scanning; `label` names it in the message) and the appendix when on. */
export function outputSecretBlock(
  svg: string,
  embedded: readonly string[],
  md: string | null,
  label = "the image",
): string | null {
  let own = svg;
  for (const e of embedded) if (e) own = own.split(e).join(" ");
  // The markup scan closes the SVG's line-wrap seams; the appendix is plain text.
  const where =
    findSecretShapedInMarkup([{ where: label, text: own }]) ??
    (md === null ? null : findSecretShaped([{ where: "the appendix", text: md }]));
  return where === null ? null : secretMessage(where);
}

/** The message that blocks the three actions, or null when the strings are clean. */
export function privacyBlock(model: C4Model, trust: TrustMap, stampLine?: string): string | null {
  const strings = collectAiStrings(model, trust);
  const secret = findSecretShaped([...collectDataStrings(model, trust, stampLine), ...strings]);
  if (secret !== null) return secretMessage(secret);
  const path = findPathShaped(strings);
  if (path !== null) {
    return `An AI-written label looks like it contains a local file path (${path}) — regenerate the map before sharing`;
  }
  return null;
}
