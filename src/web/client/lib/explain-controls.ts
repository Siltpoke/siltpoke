/**
 * The explain controls Code Map draws in two places: the file / function
 * panel's foot, and the trace card's Purpose field. Pure HTML builders — the
 * island binds the clicks.
 *
 * Both used to stop offering anything once an answer existed (defect [42]):
 * the panel showed only "Open explanation", and the card's button disappeared.
 * The server takes `force` on both routes; these builders add the control that
 * sends it. A regenerate is a new paid call, so it is a separate, smaller
 * control — never the default action.
 */
import type { IndexFreshness } from "../islands/repo-graph-index-freshness";
import { type OverCapFields, overCapHtml } from "./over-cap-note";

type Esc = (s: unknown) => string;

export type ExplState = "none" | "valid" | "stale";

const REGEN_TITLE = "Runs a new paid call and replaces the saved answer";

const CACHED_TAIL: Record<IndexFreshness, string> = {
  fresh: "up to date with the code",
  behind: '<span class="warn">matches the index, but the code changed since it was built</span>',
  pending: "matches the indexed code",
  unknown: "matches the indexed code",
};

/**
 * Foot HTML for the file / function panel. The click handler branches on
 * `data-act` ("open" | "gen") — NOT the label text. `#rg-expl-regen` exists
 * only when there is a cached answer to replace.
 *
 * `index` is whether the index is still the code on disk. "Cached" means the
 * answer matches the INDEXED file (`cache-lifecycle.ts` compares against the
 * index's fingerprints, never the disk), so "up to date with the code" may be
 * said only when the index itself is current (defect [84]).
 */
export function explBtnHtml(state: ExplState, index: IndexFreshness): string {
  let label: string;
  let note: string;
  // A real button of its own, below the note: it was once a text link inside the
  // note that wrapped to two lines and sat right under Open explanation (defect [76]).
  let regen = "";
  if (state === "valid") {
    label = "Open explanation";
    note = `<span class="ok">✓ cached</span> · ${CACHED_TAIL[index]}`;
    regen = `<button type="button" class="rg-regen" id="rg-expl-regen" title="${REGEN_TITLE}">↻ Re-generate</button>`;
  } else if (state === "stale") {
    label = "Re-generate explanation";
    note = '<span class="warn">↻ code changed</span> · cached copy was cleared';
  } else {
    label = "Generate explanation";
    note = '<span class="muted">not generated yet · the button runs it</span>';
  }
  const act = state === "valid" ? "open" : "gen";
  return `<a class="btn primary" id="rg-expl-btn" data-act="${act}">${label} <span class="arrow">→</span></a><div class="p-note">${note}</div>${regen}`;
}

/** A trace node's grounded-purpose generation state. */
export interface PurposeGen extends OverCapFields {
  state: "idle" | "loading" | "done" | "error";
  text?: string;
  cite?: string;
  error?: string;
}

/** The part of a trace node the Purpose field reads. */
interface PurposeNode {
  id: string;
  purpose: { src: string; text?: string };
}

const genBtn = (id: string, label: string, esc: Esc, force = false): string =>
  `<button class="ph-genbtn" data-gen="${esc(id)}"${force ? ` data-force="1" title="${REGEN_TITLE}"` : ""}>${label}</button>`;

/** The generated answer in whichever state it is in, or null when there is none yet. */
function generatedHtml(t: PurposeNode, g: PurposeGen | undefined, esc: Esc): string | null {
  if (g?.state === "done" && g.text) {
    return (
      `<div class="ph-val gen"><span class="ph-spark">✨</span> ${esc(g.text)}<div class="ph-cite">grounded · <a>${esc(g.cite ?? "")}</a> · cached</div>${overCapHtml(g, "div", "ph-cite", esc)}</div>` +
      // `error` beside a done answer = the last regenerate failed; the answer shown is the one kept.
      (g.error ? `<div class="ph-hint" data-regen-failed>⚠ Regenerate failed — ${esc(g.error)}. The saved answer is unchanged.</div>` : "") +
      `<div class="ph-hint">${genBtn(t.id, "↻ Regenerate", esc, true)}</div>`
    );
  }
  if (g?.state === "loading") {
    return `<div class="ph-val loading"><span class="ph-spin"></span> siltpoke is reading this function…</div><div class="ph-hint">Read the source → produce one grounded sentence → cache it. Counts once.</div>`;
  }
  if (g?.state === "error") {
    return `<div class="ph-err"><b>⚠ Brain unavailable</b><div class="ph-er">${esc(g.error ?? "unknown error")}</div>${genBtn(t.id, "↻ Retry", esc)}</div>`;
  }
  return null;
}

/**
 * Purpose field — progressive disclosure: code comment (free) → empty + ✨
 * button → loading → grounded sentence + cite → Brain-unavailable + retry.
 * A node with a code comment keeps the comment and can still ask for a look.
 */
export function purposeHtml(t: PurposeNode, g: PurposeGen | undefined, esc: Esc): string {
  const generated = generatedHtml(t, g, esc);
  if (t.purpose.src === "jsdoc") {
    const comment = `<div class="ph-val">${esc(t.purpose.text ?? "")}</div><div class="ph-hint">Source: code comment (JSDoc) · free</div>`;
    return comment + (generated ?? `<div class="ph-hint">${genBtn(t.id, "✨ Let siltpoke look", esc)}</div>`);
  }
  if (generated !== null) return generated;
  const isU = t.purpose.src === "unresolvable";
  const empty = isU
    ? "There IS a next step, but static analysis can't tell who — so it won't guess for you"
    : "no comment — null";
  const hint = isU
    ? "Dynamic call — static analysis can't link it. Click to let siltpoke read the actual code and give you one sourced sentence with a file:line citation."
    : "Click → siltpoke reads this function, produces one grounded sentence, and caches it. Shows the reason if the Brain is unavailable.";
  return `<div class="ph-val empty">${empty}${genBtn(t.id, "✨ Let siltpoke look", esc)}</div><div class="ph-hint">${hint}</div>`;
}
