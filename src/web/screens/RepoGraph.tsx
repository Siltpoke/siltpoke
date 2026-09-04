// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
// Copyright (c) 2026 Jiaqi Duan
/** @jsxImportSource hono/jsx */
/**
 * RepoGraph SSR screen, hand-rolled DOM+SVG port.
 *
 * Replaces the earlier cytoscape-based surface with a faithful port of the
 * prototype. This screen renders ONLY the static skeleton + scoped prototype CSS; the
 * Alpine island (islands/repo-graph.ts) drives all rendering imperatively
 * against the `#rg-*` ids — `x-data="repoGraph"` exists only to fire init().
 *
 * The prototype's own sidebar is dropped: this page lives inside the
 * Dashboard shell, which owns the nav. CSS is scoped under `.rg-host` and
 * uses the prototype's warm `:root` tokens verbatim so the ported markup
 * (`gbox` / `node` / `world` / `edges` / `panel` …) renders unchanged.
 *
 * Renders the architecture level only. The picker / search / help / slider /
 * side-panel / explain-modal / tweaks markup is present but inert
 * (default-hidden).
 */
import { Dashboard } from "../shells/Dashboard";
import { CANONICAL_NAV } from "../routes/nav";
import type { ArchitectureProjection } from "../../repo-graph/project-architecture";
import type { RepoEntry } from "../../repo-graph/repo-registry";

export interface RepoGraphScreenProps {
  /** id-keyed architecture projection — the island renders this DOM+SVG. */
  projection: ArchitectureProjection;
  repoEntries: readonly RepoEntry[];
  currentProjHash: string;
  /**
   * Daemon-staleness strip text. Non-null ONLY when the
   * running daemon is behind repo HEAD (`state === "behind"`); `current` /
   * `unknown` pass null → no strip. NOT dismissible (self-clears on restart —
   * persistence would hide a live problem).
   */
  stalenessBanner: string | null;
  stats: { files: number; symbols: number; edges: number };
  /** Daemon secret, embedded for the island's mutating index POSTs. */
  secret?: string;
  /** The cached LLM-derived model (raw ArchModelDoc — the
   * island adapts it to a C4Model), with its grounded share + staleness. */
  generatedModel?: {
    doc: unknown;
    groundedPct: number;
    stale: boolean;
    fileFunctions?: Record<string, number> | null;
    /** ISO timestamp of when this model was generated. */
    generatedTs?: string;
    /** Wall-clock duration of the Brain call (ms). Absent on legacy caches. */
    durationMs?: number;
    costUsd?: number;
    /** Grounding counts. Absent on legacy caches from before this field existed — never
     * default to 0; the popover omits the formula line gracefully. */
    citedClaims?: number;
    totalClaims?: number;
    topologyBlindClaims?: number;
  } | null;
  /** The repo's authored C4 model, SSR-loaded from
   * `.siltpoke/arch-c4.json` (already Zod-validated), or null. */
  authoredModel?: unknown | null;
  /** A file existed but failed validation → the visible fail-soft notice. */
  authoredInvalid?: boolean;
}

function shortName(entry: RepoEntry | undefined, fallback: string): string {
  if (!entry) return fallback;
  if (entry.project_root) {
    const parts = entry.project_root.split("/").filter(Boolean);
    return parts[parts.length - 1] ?? entry.proj_hash;
  }
  return entry.proj_hash;
}

export function RepoGraph(props: RepoGraphScreenProps) {
  const { projection, repoEntries, currentProjHash, stalenessBanner, stats, secret, generatedModel, authoredModel, authoredInvalid } = props;

  const initialPayload = JSON.stringify({
    projection,
    repos: repoEntries,
    currentProjHash,
    // The cached LLM-derived model (raw ArchModelDoc + grounded
    // share + staleness), or null when this repo hasn't been generated. The island
    // adapts the doc to a C4Model + reads stale to offer re-generate.
    generatedModel: generatedModel ?? null,
    // The authored model rides the same payload pipeline.
    authoredModel: authoredModel ?? null,
  });

  const fmt = (n: number) => n.toLocaleString();
  const currentRepo = repoEntries.find((r) => r.proj_hash === currentProjHash);
  // Zero indexed repos → the computed cwd hash is dead data, not a name; show
  // the empty-state vocabulary instead of baking a meaningless hash into the
  // picker button. (Non-empty lists always resolve currentRepo: the
  // bare URL falls back to repos[0] and a dead ?repo= 302s away.)
  const repoLabel =
    repoEntries.length === 0 ? "No repo indexed" : shortName(currentRepo, currentProjHash || "repo");
  const hasGraph = projection.subdirs.length > 0;

  return (
    <Dashboard activeSection="repo-graph" navSections={CANONICAL_NAV}>
      <style
        dangerouslySetInnerHTML={{
          __html: `
            /* warm token palette — the prototype's :root custom properties, now
               ALIASED to the dashboard's own tokens.css custom properties
               instead of holding literal hex (Task 9). The property NAMES
               (--cream, --ink3, --resolved, …) are unchanged on purpose:
               repo-graph.ts's SVG code (setAttribute / .style.stroke =
               "var(--ink3)" etc.) and the CSS below both reference these
               names, so every consumer picks up dark-mode for free with no
               further change (see repo-graph.ts:764's own comment, which
               anticipates exactly this). Still scoped to .rg-host (not :root)
               to avoid colliding with the dashboard's own token names, and
               still duplicated onto #rg-ex-overlay / #rg-edge-tip — those two
               sit OUTSIDE .rg-host (document-level fixed overlays) and would
               resolve var(--cream) etc. to nothing without it.
               --resolved/--unresolved/--unresolvable are RepoGraph's own
               "trace confidence" semantic palette (Task 9's graphPalette,
               distinct from the 16 brand tokens — node/edge kinds have no
               brand-token equivalent to alias to). */
            .rg-host, #rg-ex-overlay, #rg-edge-tip {
              --cream:var(--color-cream); --paper:var(--color-paper); --paperD:var(--color-paperD); --edge:var(--color-edge);
              --ink:var(--color-ink); --ink2:var(--color-ink2); --ink3:var(--color-ink3);
              --terra:var(--color-terra); --amber:var(--color-amber); --moss:var(--color-moss); --sky:var(--color-sky);
              --onAccent:var(--color-onAccent);
              --display:"Pixelify Sans",system-ui,sans-serif;
              --mono:"JetBrains Mono",ui-monospace,monospace;
              --body:"Geist",system-ui,sans-serif;
              --radius:10px; --radius-sm:6px;
              /* --shadow-sm/md/lg: deliberately NOT redefined here (Task 10b
                 batch 2 fix round 1). This block used to alias them to
                 "color-mix(in srgb, var(--color-ink) N%, transparent)" — the
                 exact ink-derived-shadow bug batch 1 fixed in
                 FloatingChat.tsx, still live here: dark.ink is near-white, so
                 every shadow in this subtree rendered as a white halo in dark
                 mode. --shadow-sm/md/lg are already real, theme-correct
                 global names (tokens.css's own themeVars() emits them at
                 :root), unlike --cream/--paper/etc. above (which have no
                 global equivalent under those short names) — so simply NOT
                 shadowing them here lets every var(--shadow-lg) call site
                 below inherit the correct global value directly, with no
                 local declaration needed. */
              /* Trace confidence palette — RepoGraph's own graphPalette (Task 9). */
              --resolved:var(--graph-resolved); --unresolved:var(--graph-unresolved); --unresolvable:var(--graph-unresolvable);
            }
            .rg-host {
              display:flex; flex-direction:column; height:100%; min-height:0;
              background:var(--cream); color:var(--ink); font-family:var(--body); font-size:14px;
            }
            .rg-host *{box-sizing:border-box}
            @keyframes rgpulse{0%,100%{opacity:1}50%{opacity:.3}}
            @keyframes rgspin{to{transform:rotate(360deg)}}

            /* page head */
            .rg-host .pagehead{display:flex;align-items:center;gap:14px;padding:11px 20px;border-bottom:1px solid var(--edge);background:var(--cream);flex-shrink:0}
            .rg-host .pagehead h1{font-family:var(--display);font-size:20px;margin:0;font-weight:600;letter-spacing:-.3px}
            .rg-host .pagehead .sub{font-size:12.5px;color:var(--ink3);white-space:nowrap}
            /* Flex spacer pushes right cluster to trailing edge.
               idx-stat sits immediately after repo-pick-wrap (no margin-left:auto on it);
               ph-spacer takes up remaining space so noevi/src-chip/divider/arch-gen stay right.
               Host-agnostic on purpose — the trace ph-bar reuses the same spacer. */
            .rg-host .ph-spacer{flex:1}
            /* Generate button + grounded chip.
               Spatial isolation: button is the LAST
               pagehead child, preceded by .pagehead-divider + margin. Buffer at
               typical width: noevi + src-chip + divider ≈ 300px. */
            .rg-host .arch-gen{display:inline-flex;align-items:center;gap:8px;font-family:var(--body);font-size:12.5px;font-weight:500;border-radius:var(--radius-sm);padding:6px 12px;border:1px solid var(--ink);background:var(--ink);color:var(--cream);cursor:pointer;white-space:nowrap}
            /* Divider hairline + gap before the paid button. pointer-events:none —
               this is a decorative aria-hidden hairline; it must never intercept
               clicks on neighboring controls (e.g. the Auto/Generated toggle). */
            .rg-host .pagehead-divider{width:1px;height:18px;background:var(--edge);flex-shrink:0;margin-left:10px;pointer-events:none}
            /* explicit display overrides the UA [hidden] rule → restore it */
            .rg-host .arch-gen[hidden],.rg-host .arch-chip[hidden]{display:none}
            .rg-host .arch-gen[disabled]{opacity:.7;cursor:default}
            /* .arch-gen.stale ONLY: text/border on the brand 'amber' FILL (this
               rule's own background IS var(--amber), solid). NOT
               var(--color-onAccent) — white-on-amber measures 2.06:1
               (pre-existing documented gap, deferred 2026-08-01, out of
               scope for this track). The prototype's original literal (hex
               3a2c12, dark brown) worked around it with dark text;
               color-mix(amber, black) reproduces that AND follows the active
               theme's amber (8.83:1 light / 9.48:1 dark — recomputed round 2
               against the live palette, non-premultiplied sRGB channel mix
               then WCAG contrastRatio; both comfortably clear even the 4.5:1
               text floor). This mix-toward-
               black is correct ONLY because amber is the background here —
               it does NOT generalize to .rg-btn-accent below, whose
               background is transparent (see that rule's own comment; a
               review round-1 CRITICAL finding caught the two being
               conflated). */
            .rg-host .arch-gen.stale{background:var(--amber);border-color:color-mix(in srgb, var(--amber) 75%, black);color:color-mix(in srgb, var(--amber) 12%, black)}
            /* Button weight tiers.
               .rg-btn-accent: outlined + accent amber, used when cache is stale.
               .rg-btn-ghost:  text-weight + muted ink2 (≥4.5:1 on --paper), used when cache is fresh.
               Both inherit .arch-gen geometry (gap/padding/font) — applied as
               MODIFIER classes alongside .arch-gen, not standalone replacements.
               Full hit area preserved on ghost (no padding reduction). */
            /* .rg-btn-accent's background is transparent — the text sits on
               .pagehead's var(--cream), which INVERTS between themes (light
               and dark canvas are opposite polarity), unlike .stale's solid
               amber fill above. mix(amber, black) was copy-adjusted from
               .stale without re-deriving for a transparent background — a
               review round-1 CRITICAL finding: it measured 1.01:1 in dark
               (near-black text on the near-black dark canvas) while reading
               fine in light (16.86:1) only by accident. Fixed by mixing
               toward var(--color-ink) instead of the literal black — ink
               itself already inverts correctly with the canvas (proven by
               the existing "ink/ink2 on paper" body-floor tests), so the mix
               inherits that: 12.62:1 light / ~14.14-14.18:1 dark (recomputed
               round 2 against the live palette — non-premultiplied sRGB
               channel mix, then WCAG contrastRatio; the dark spread is
               whether the intermediate mixed channel is rounded to an 8-bit
               integer, 14.18, before computing luminance, or kept as a float,
               14.14 — both clear 4.5:1 with room either way). */
            .rg-host .arch-gen.rg-btn-accent{background:transparent;border-color:var(--amber);color:color-mix(in srgb, var(--amber) 12%, var(--ink))}
            .rg-host .arch-gen.rg-btn-accent:hover{background:color-mix(in srgb, var(--amber) 12%, transparent)}
            /* Ghost tier now reads visibly as a BUTTON (1px edge border +
               faint paper tint at rest). Still lighter than accent (outlined amber)
               and default (filled ink). --ink2 text maintains ≥4.5:1 on --paper. */
            .rg-host .arch-gen.rg-btn-ghost{background:var(--paper);border-color:var(--edge);color:var(--ink2)}
            .rg-host .arch-gen.rg-btn-ghost:hover{background:var(--paperD);border-color:var(--ink3)}
            .rg-host .arch-gen .cost{font-family:var(--mono);font-size:11px;opacity:.82}
            .rg-host .arch-gen .spin{width:12px;height:12px;border:2px solid color-mix(in srgb, var(--cream) 40%, transparent);border-top-color:var(--cream);border-radius:50%;display:inline-block;animation:rgspin .9s linear infinite}
            /* Source chip (Authored | Generated). Pill of two segments, same
               visual family as .arch-chip; part of the $0 cluster
               (chip/grounded%/route) that sits LEFT of the divider+genBtn.
               flex-shrink:0 — same "review fixup" as .idx-stat below. This
               chip sets overflow:hidden (to clip the pill's rounded corners),
               and per the flexbox spec an item's automatic min-width resolves
               to 0 (not content-based) whenever overflow isn't visible — so
               WITHOUT flex-shrink:0 this was the one pagehead child the
               browser was free to squeeze below its own text width once the
               quiz controls widened the row, silently clipping the
               Auto/Generated buttons while their JS-reported bounding rects
               stayed full-size. Playwright then hit-tested the clip point and
               found the ancestor (.src-chip / .pagehead) instead of the
               button — "intercepts pointer events", CI-only because Linux's
               fallback-font metrics render this row measurably wider than
               macOS's. Pin it so it can never shrink below content; nothing
               downstream of it (arch-gen etc.) needs the space back — the
               row already has flex-shrink:0 protected members (idx-stat,
               repo-pick-wrap, the quiz select/button) that no browser was
               ever shrinking past content anyway; only the ph-spacer
               (flex-basis:0) absorbs a tight row now. */
            .rg-host .src-chip{display:inline-flex;align-items:stretch;font-family:var(--mono);font-size:11px;background:var(--cream);border:1px solid var(--edge);border-radius:999px;overflow:hidden;flex-shrink:0}
            .rg-host .src-chip[hidden]{display:none}
            .rg-host .src-chip .src-seg{font-family:inherit;font-size:inherit;border:0;background:transparent;color:var(--ink3);padding:3px 11px;cursor:pointer;white-space:nowrap}
            .rg-host .src-chip .src-seg + .src-seg{border-left:1px solid var(--edge)}
            .rg-host .src-chip .src-seg.active{background:var(--ink);color:var(--cream);cursor:default}
            .rg-host .src-chip .src-seg.off{opacity:.45;cursor:default;pointer-events:none}
            .rg-host .src-chip .src-stale{color:var(--amber);font-weight:600}
            .rg-host .src-chip .src-seg.active .src-stale{color:color-mix(in srgb, var(--amber) 45%, var(--cream))}
            .rg-host .arch-chip{display:inline-flex;align-items:center;gap:6px;font-family:var(--mono);font-size:11px;background:var(--cream);border:1px solid var(--edge);border-radius:999px;padding:3px 10px;cursor:pointer}
            .rg-host .arch-chip:hover{background:var(--paperD)}
            .rg-host .arch-chip:focus-visible{outline:2px solid var(--resolved);outline-offset:1px}
            .rg-host .arch-chip b{color:var(--resolved);font-weight:600}
            .rg-host .arch-noevi{font-family:var(--mono);font-size:10.5px;color:var(--ink3);white-space:nowrap}
            .rg-host .arch-noevi[hidden]{display:none}
            /* Grounded chip lives in the toolbar; tight position:relative
               wrapper so the anchor-popover anchors to the chip, not the whole toolbar.
               align:"right" at call-site keeps the popover at the chip's right edge.
               :has(button[hidden]) hides the wrapper when the chip is hidden, preventing
               a ghost gap in the toolbar flex row (chip is architecture-mode-only). */
            .rg-host .arch-chip-tbwrap{position:relative;display:inline-flex;align-items:center}
            .rg-host .arch-chip-tbwrap:has(button[hidden]){display:none}
            /* topology-blind sub-count on the grounded chip — neutral taupe,
               NOT a warning: these are NOT grounding failures, just cores the
               import gradient can't place. Reads "· K layer-not-confirmable". */
            .rg-host .arch-chip .chip-blind{color:var(--ink2);border-left:1px solid var(--edge);margin-left:6px;padding-left:6px}
            /* inferred (grounding-failed) styling — visibly distinct from cited */
            .rg-host .c4-band .c4-bandinf{margin-left:7px;font-family:var(--body);font-size:9px;font-weight:500;color:var(--unresolved);border:1px dashed var(--unresolved);border-radius:999px;padding:0 6px;vertical-align:middle;opacity:.9}
            /* topology-blind — a NEUTRAL "unknown", NOT a warning and NOT
               "worse than inferred": a depended-upon domain core whose layer the
               import gradient structurally can't see (not a grounding failure).
               Neutral taupe (--ink2, body-text weight — EQUAL presence to the
               inferred badge, never weaker: a core awaiting judgment must not read
               fainter than the LLM's mere guess) + DOTTED (distinct from inferred's
               orange dashed); no opacity drop → reads "neutral, awaiting human
               judgment", never error/quality-low, never de-emphasized. */
            .rg-host .c4-band .c4-bandblind{margin-left:7px;font-family:var(--body);font-size:9px;font-weight:500;color:var(--ink2);border:1px dotted var(--ink2);border-radius:999px;padding:0 6px;vertical-align:middle}
            .rg-host .c4-node.ext.inferred{border-style:dashed;border-color:var(--unresolved);opacity:.85}
            /* inferred only restyles the font — NEVER opacity, else its
               specificity (.c4-elab.inferred) clobbers the calm default
               (.c4-elab{opacity:0}) and the label shows at rest. The muted .85
               applies only when lit (.show), so inferred reads softer than cited. */
            .rg-host .c4-elab.inferred{font-style:italic}
            .rg-host .c4-elab.inferred.show{opacity:.85}
            /* Review fixup: stats sit mid-row now (not at the trailing edge) — pin them
               against flex compression so narrow windows squeeze the ph-spacer, not the text. */
            .rg-host .idx-stat{font-family:var(--mono);font-size:11px;color:var(--ink2);display:flex;gap:5px;align-items:center;white-space:nowrap;flex-shrink:0}
            .rg-host .idx-stat b{color:var(--ink);font-weight:600}

            /* repo picker */
            .rg-host .repo-pick-wrap{position:relative}
            .rg-host .repo-pick{display:flex;align-items:center;gap:7px;font-family:var(--body);font-size:13px;font-weight:600;color:var(--ink);background:var(--paper);border:1px solid var(--edge);border-radius:8px;padding:6px 11px;cursor:pointer}
            .rg-host .repo-pick svg{color:var(--ink3)}
            .rg-host .repo-pick .chev{color:var(--ink3);font-size:10px;margin-left:1px}
            .rg-host .repo-pick:hover,.rg-host .repo-pick.open{background:var(--paperD);border-color:var(--ink3)}
            .rg-host .repo-menu{position:absolute;top:40px;left:0;width:330px;background:var(--cream);border:1px solid var(--edge);border-radius:11px;box-shadow:var(--shadow-lg);z-index:50;padding:6px;display:none}
            .rg-host .repo-menu.open{display:block}
            .rg-host .repo-menu .rm-head{font-family:var(--mono);font-size:10px;text-transform:uppercase;letter-spacing:.08em;color:var(--ink3);padding:7px 9px 5px}
            .rg-host .repo-row{display:flex;align-items:center;gap:10px;padding:9px 9px;border-radius:8px;cursor:pointer}
            .rg-host .repo-row:hover{background:var(--paper)}
            .rg-host .repo-row.disabled{cursor:default;opacity:.7}
            .rg-host .repo-row .rdot{width:7px;height:7px;border-radius:50%;flex-shrink:0}
            .rg-host .repo-row .rdot.ready{background:var(--moss)}
            .rg-host .repo-row .rdot.indexing{background:var(--amber);animation:rgpulse 1.1s ease-in-out infinite}
            .rg-host .repo-row .rdot.none{background:var(--edge)}
            .rg-host .repo-row .rinfo{flex:1;min-width:0}
            .rg-host .repo-row .rname{font-family:var(--mono);font-size:13px;font-weight:600;color:var(--ink);display:flex;align-items:center;gap:7px;min-width:0}
            .rg-host .repo-row .rname .rname-txt{min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
            .rg-host .repo-row .rcur{font-family:var(--body);font-size:9px;font-weight:600;color:var(--moss);border:1px solid var(--moss);border-radius:4px;padding:0 4px;flex-shrink:0}
            .rg-host .repo-row .rpath{font-family:var(--mono);font-size:10.5px;color:var(--ink3);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
            .rg-host .repo-row .rstat{font-family:var(--mono);font-size:10px;color:var(--ink3);text-align:right;white-space:nowrap;flex-shrink:0}
            .rg-host .repo-row .rforget{flex-shrink:0;width:22px;height:22px;border:1px solid transparent;border-radius:6px;background:transparent;color:var(--ink3);font-size:15px;line-height:1;cursor:pointer;opacity:0;transition:opacity .12s}
            .rg-host .repo-row:hover .rforget{opacity:1}
            .rg-host .repo-row .rforget:hover{background:var(--paper);border-color:var(--edge);color:var(--ink)}
            .rg-host .repo-row .rforget.rforget-off{cursor:not-allowed;opacity:.3}
            .rg-host .repo-row:hover .rforget.rforget-off{opacity:.3}
            .rg-host .repo-row.confirm{gap:8px;background:color-mix(in srgb, var(--resolved) 8%, var(--cream));flex-wrap:wrap}
            .rg-host .repo-row.confirm .rconfirm{flex:1;min-width:0;font-family:var(--body);font-size:12px;color:var(--ink)}
            /* var(--onAccent) measured only 4.09:1 here in dark mode against
               unresolvable's ORIGINAL dark lift — under the 4.5:1 text floor
               on this destructive-confirm button (round-1 review finding;
               11.5px label text, not WCAG "large text"). A bespoke light/dark
               white/black token was built to fix it directly, then removed:
               raising graphPalette.dark.unresolvable's lift (Important 2,
               palette.ts — independently required because this same color is
               also small body text at several OTHER sites) moved onAccent's
               own dark value to 5.00:1 against the new unresolvable, clearing
               the floor as a side effect (onAccent's light value was already
               7.53:1). See "onAccent on unresolvable clears the 4.5:1 text
               floor" in palette.test.ts. */
            .rg-host .repo-row.confirm .rc-yes{flex-shrink:0;font-family:var(--body);font-size:11.5px;color:var(--onAccent);background:var(--unresolvable);border:none;border-radius:6px;padding:5px 11px;cursor:pointer}
            .rg-host .repo-row.confirm .rc-no{flex-shrink:0;font-family:var(--body);font-size:11.5px;color:var(--ink2);background:transparent;border:1px solid var(--edge);border-radius:6px;padding:5px 11px;cursor:pointer}

            /* "+ Index a repo" affordance + path input */
            .rg-host .rm-add{border-top:1px dashed var(--edge);margin-top:4px;padding-top:6px}
            .rg-host .rm-add-btn{width:100%;text-align:left;background:transparent;border:1px solid transparent;border-radius:7px;padding:8px 9px;font-family:var(--body);font-size:12.5px;color:var(--ink2);cursor:pointer}
            .rg-host .rm-add-btn:hover{background:var(--paper);color:var(--ink)}
            .rg-host .rm-add-plus{font-weight:700;color:var(--moss);margin-right:4px}
            .rg-host .rm-add-form{padding:4px 9px 6px;display:flex;flex-wrap:wrap;gap:6px}
            .rg-host .rm-add-inp{flex:1;min-width:0;box-sizing:border-box;font-family:var(--mono);font-size:11.5px;color:var(--ink);background:var(--paper);border:1px solid var(--edge);border-radius:6px;padding:6px 8px;outline:none}
            .rg-host .rm-add-inp:focus{border-color:var(--resolved)}
            .rg-host .rm-add-go{flex-shrink:0;font-family:var(--body);font-size:12px;color:var(--onAccent);background:var(--moss);border:none;border-radius:6px;padding:6px 12px;cursor:pointer}
            .rg-host .rm-add-go:hover{filter:brightness(1.05)}
            .rg-host .rm-add-err{flex-basis:100%;font-family:var(--body);font-size:11px;color:var(--unresolvable);min-height:0}
            /* Folder browser panel */
            .rg-host .rm-add-panel{padding:4px 8px 8px}
            .rg-host .fb-bar{display:flex;align-items:center;gap:6px;padding:2px 0 6px}
            .rg-host .fb-up{flex-shrink:0;width:24px;height:24px;border:1px solid var(--edge);border-radius:6px;background:var(--paper);color:var(--ink2);cursor:pointer;font-size:13px;line-height:1}
            .rg-host .fb-up:disabled{opacity:.3;cursor:default}
            .rg-host .fb-up:not(:disabled):hover{border-color:var(--ink3);color:var(--ink)}
            .rg-host .fb-crumb{flex:1;min-width:0;font-family:var(--mono);font-size:11px;color:var(--ink2);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;direction:rtl;text-align:left}
            .rg-host .fb-filter{width:100%;box-sizing:border-box;font-family:var(--mono);font-size:11px;color:var(--ink);background:var(--paper);border:1px solid var(--edge);border-radius:6px;padding:4px 8px;outline:none;margin-bottom:4px}
            .rg-host .fb-filter:focus{border-color:var(--resolved)}
            .rg-host .fb-list{max-height:200px;overflow-y:auto;display:flex;flex-direction:column;gap:1px}
            .rg-host .fb-entry{display:flex;align-items:center;gap:7px;width:100%;text-align:left;padding:5px 7px;border:1px solid transparent;border-radius:6px;background:transparent;cursor:pointer;font-family:var(--body);font-size:12px;color:var(--ink)}
            .rg-host .fb-entry:hover{background:var(--paper)}
            .rg-host .fb-ic{flex-shrink:0;font-size:12px;opacity:.8}
            .rg-host .fb-nm{flex:1;min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
            .rg-host .fb-badge{flex-shrink:0;font-family:var(--mono);font-size:8.5px;color:var(--moss);border:1px solid var(--moss);border-radius:4px;padding:0 4px}
            .rg-host .fb-empty,.rg-host .fb-more{font-family:var(--body);font-size:11px;color:var(--ink3);padding:6px 7px;font-style:italic}
            .rg-host .fb-foot{border-top:1px dashed var(--edge);margin-top:6px;padding-top:7px;display:flex;flex-direction:column;gap:6px}
            .rg-host .fb-block{font-family:var(--body);font-size:11px;color:var(--ink2)}
            .rg-host .fb-anyway,.rg-host .fb-alt{background:none;border:none;padding:0;cursor:pointer;font-family:var(--body);color:var(--moss);text-decoration:underline;font-size:11px}
            .rg-host .fb-alt{align-self:flex-start;color:var(--ink3)}
            .rg-host .fb-textwrap{display:flex;gap:6px}
            .rg-host .rg-idx-prog{font-family:var(--mono);font-size:13px;color:var(--ink2)}
            .rg-host .rg-idx-detail{font-family:var(--mono);font-size:11px;color:var(--ink3);margin:0;max-width:520px;line-height:1.5;word-break:break-word}
            .rg-host .rg-idx-cancel{margin-top:12px;font-family:var(--body);font-size:12px;color:var(--ink2);background:transparent;border:1px solid var(--edge);border-radius:7px;padding:6px 14px;cursor:pointer}
            .rg-host .rg-idx-cancel:hover{background:var(--paper);border-color:var(--ink3);color:var(--ink)}

            .rg-host .banner{background:color-mix(in srgb, var(--resolved) 5%, var(--cream));border-bottom:1px solid color-mix(in srgb, var(--resolved) 55%, var(--cream));padding:8px 20px;font-size:12px;color:var(--ink);flex-shrink:0;display:flex;align-items:center}

            /* toolbar */
            .rg-host .toolbar{display:flex;align-items:center;gap:12px;padding:9px 20px;border-bottom:1px solid var(--edge);background:var(--paper);flex-shrink:0;position:relative}
            .rg-host .crumbs{display:flex;align-items:center;gap:6px;font-family:var(--mono);font-size:12px;color:var(--ink3);min-width:0;flex-shrink:1;overflow:hidden}
            .rg-host .crumbs .c{padding:3px 7px;border-radius:5px;cursor:pointer;white-space:nowrap;color:var(--ink2)}
            .rg-host .crumbs .c:hover{background:var(--paperD)}
            .rg-host .crumbs .c.cur{color:var(--ink);font-weight:600;background:var(--paperD);cursor:default}
            .rg-host .crumbs .sep{color:var(--edge)}

            .rg-host .search{position:relative;width:268px;flex-shrink:0}
            .rg-host .search input{width:100%;font-family:var(--mono);font-size:12px;padding:7px 10px 7px 28px;border:1px solid var(--edge);border-radius:7px;background:var(--cream);color:var(--ink);outline:none}
            .rg-host .search input:focus{border-color:var(--ink3);box-shadow:0 0 0 3px color-mix(in srgb, var(--sky) 18%, transparent)}
            .rg-host .search .si{position:absolute;left:8px;top:50%;transform:translateY(-50%);color:var(--ink3);pointer-events:none}
            .rg-host .results{position:absolute;top:38px;left:0;right:0;background:var(--cream);border:1px solid var(--edge);border-radius:8px;box-shadow:var(--shadow-lg);max-height:300px;overflow-y:auto;z-index:40;display:none}
            .rg-host .results.open{display:block}
            .rg-host .res{display:flex;align-items:center;gap:9px;padding:7px 10px;cursor:pointer;border-bottom:1px solid var(--paperD)}
            .rg-host .res:last-child{border-bottom:none}
            .rg-host .res:hover,.rg-host .res.hl{background:var(--paper)}
            .rg-host .res .k{font-family:var(--mono);font-size:9px;text-transform:uppercase;letter-spacing:.06em;padding:2px 5px;border-radius:4px;border:1px solid var(--edge);color:var(--ink3);flex-shrink:0;width:54px;text-align:center}
            .rg-host .res .nm{font-family:var(--mono);font-size:12px;color:var(--ink);font-weight:600}
            .rg-host .res .pa{font-family:var(--mono);font-size:10.5px;color:var(--ink3);margin-left:auto;white-space:nowrap}

            .rg-host .tb-spacer{flex:1}
            .rg-host .ctl{display:flex;align-items:center;gap:8px}
            .rg-host .help-btn{width:18px;height:18px;border-radius:50%;border:1px solid var(--edge);background:var(--cream);color:var(--ink3);font-family:var(--mono);font-size:11px;cursor:pointer;line-height:1;flex-shrink:0;padding:0}
            .rg-host .help-btn:hover,.rg-host .help-btn.on{color:var(--cream);background:var(--ink);border-color:var(--ink)}
            .rg-host .help-pop{position:absolute;top:50px;right:20px;width:330px;background:var(--cream);border:1px solid var(--edge);border-radius:11px;box-shadow:var(--shadow-lg);z-index:55;padding:15px 17px;display:none;font-family:var(--body)}
            .rg-host .help-pop.open{display:block}
            .rg-host .help-pop h5{font-family:var(--display);font-size:14px;font-weight:600;margin:0 0 12px;color:var(--ink)}
            .rg-host .help-pop .hrow{display:flex;gap:11px;align-items:flex-start;margin-bottom:11px;font-size:12px;color:var(--ink2);line-height:1.45}
            .rg-host .help-pop .hrow b{color:var(--ink);font-weight:600}
            .rg-host .help-pop .hrow code{font-family:var(--mono);font-size:11px;background:var(--paper);border:1px solid var(--edge);border-radius:4px;padding:0 4px}
            .rg-host .help-pop .hic{flex-shrink:0;width:24px;display:inline-flex;align-items:center;justify-content:center;padding-top:2px}
            #rg-edge-tip{position:fixed;z-index:90;background:var(--ink);color:var(--cream);font-family:var(--mono);font-size:11px;padding:7px 11px;border-radius:8px;box-shadow:var(--shadow-lg);pointer-events:none;opacity:0;transition:opacity .12s;max-width:300px;line-height:1.45}
            #rg-edge-tip b{color:color-mix(in srgb, var(--amber) 45%, var(--cream));font-weight:600}

            /* stage / canvas */
            .rg-host .stage{flex:1;position:relative;overflow:hidden;background:
              radial-gradient(circle at 1px 1px, color-mix(in srgb, var(--ink3) 16%, transparent) 1px, transparent 0) 0 0/22px 22px,
              var(--cream)}
            .rg-host .viewport{position:absolute;inset:0;cursor:grab}
            .rg-host .viewport.panning{cursor:grabbing}
            .rg-host .world{position:absolute;top:0;left:0;transform-origin:0 0}
            .rg-host .edges{position:absolute;top:0;left:0;overflow:visible;pointer-events:none}
            .rg-host .elink{pointer-events:none}
            .rg-host .ehit{pointer-events:stroke;stroke:transparent;fill:none;cursor:pointer}

            /* group container */
            .rg-host .gbox{position:absolute;border:1px solid var(--edge);border-radius:14px;background:color-mix(in srgb, var(--paper) 50%, transparent)}
            .rg-host .gbox .ghead{display:flex;align-items:center;gap:8px;padding:8px 14px;font-family:var(--mono);font-size:11px;letter-spacing:.04em;color:var(--ink2);text-transform:uppercase;font-weight:600;white-space:nowrap}
            .rg-host .gbox .gdot{width:8px;height:8px;border-radius:3px;flex-shrink:0}
            .rg-host .gbox .gcount{margin-left:auto;font-size:10px;color:var(--ink3);font-weight:500;text-transform:none}
            .rg-host .gbox .ghead .gnote{font-family:var(--mono);font-size:9px;color:var(--ink3);font-weight:500;text-transform:none;letter-spacing:0;background:var(--cream);border:1px solid var(--edge);border-radius:999px;padding:1px 7px;margin-left:9px}
            .rg-host .gbox .sym-empty{padding:22px 16px;text-align:center;font-family:var(--mono);font-size:12px;color:var(--ink3)}
            .rg-host .rg-empty-center{position:absolute;top:50%;left:50%;transform:translate(-50%,-50%);max-width:80%;padding:18px 22px;text-align:center;font-family:var(--mono);font-size:13px;color:var(--ink3);pointer-events:none}
            /* leaf-state banner: sits ~66% down the viewport so the entry node above stays visible */
            .rg-host .rg-leaf-note{position:absolute;top:66%;left:50%;transform:translate(-50%,-50%);max-width:72%;padding:10px 18px;text-align:center;font-family:var(--mono);font-size:12px;color:color-mix(in srgb, var(--resolved) 55%, var(--ink));background:color-mix(in srgb, var(--resolved) 3%, var(--cream));border:1px solid color-mix(in srgb, var(--resolved) 45%, var(--cream));border-radius:8px;pointer-events:none}

            /* subdir node */
            .rg-host .node{position:absolute;background:var(--cream);border:1px solid var(--edge);border-radius:9px;padding:10px 12px;cursor:pointer;transition:box-shadow .12s,border-color .12s,transform .12s,opacity .14s;box-shadow:var(--shadow-md);display:flex;flex-direction:column;gap:5px;overflow:hidden}
            .rg-host .node:hover{transform:translateY(-2px);box-shadow:var(--shadow-lg);border-color:var(--ink3)}
            .rg-host .node.sel{border-color:var(--ink);box-shadow:0 0 0 2px var(--ink),var(--shadow-lg)}
            .rg-host .node.dim{opacity:.22}
            .rg-host .node .ntop{display:flex;align-items:center;gap:7px}
            .rg-host .node .nname{font-family:var(--mono);font-size:12.5px;font-weight:600;color:var(--ink);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;flex:1;min-width:0}
            .rg-host .node .nbadge{margin-left:auto;font-family:var(--mono);font-size:10px;color:var(--ink3);background:var(--paper);border:1px solid var(--edge);border-radius:999px;padding:1px 6px;flex-shrink:0}
            .rg-host .node .nacc{width:7px;height:7px;border-radius:2px;flex-shrink:0}
            .rg-host .node .npurpose{font-size:11.5px;line-height:1.4;color:var(--ink2);display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}
            .rg-host .node .nio{display:flex;gap:10px;font-family:var(--mono);font-size:10px;color:var(--ink3);margin-top:1px}
            .rg-host .node .nio span{display:inline-flex;align-items:center;gap:3px}
            .rg-host .node.compact{padding:8px 12px}
            .rg-host .node.compact .npurpose,.rg-host .node.compact .nio{display:none}
            .rg-host .node.kind-file .nname,.rg-host .node.kind-symbol .nname{font-size:12px}
            .rg-host .node .ksub{font-family:var(--mono);font-size:9.5px;color:var(--ink3);text-transform:uppercase;letter-spacing:.05em}
            .rg-host .node .fdesc{font-family:var(--mono);font-size:10.5px;color:var(--ink2);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
            .rg-host .node .nsig{font-family:var(--mono);font-size:10px;color:var(--ink3);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
            .rg-host .node.kind-symbol{border-left:3px solid var(--sky)}
            .rg-host .node.kind-file{border-left:3px solid var(--moss)}

            /* edges */
            .rg-host .elink{fill:none;stroke:var(--ink3);transition:stroke .14s,stroke-opacity .14s,stroke-width .14s}
            .rg-host .elink.strong{stroke:var(--terra)}
            .rg-host .blane{fill:none;stroke:var(--ink3);stroke-opacity:.5;stroke-linecap:round}
            .rg-host .blchip{fill:var(--cream);stroke:var(--edge);stroke-width:1}
            .rg-host .blabel{font-family:var(--mono);font-size:11px;font-weight:600;fill:var(--ink2)}
            .rg-host .elabel{font-family:var(--mono);font-size:9px;fill:var(--ink3);opacity:0;transition:opacity .14s}
            .rg-host .elabel.show{opacity:1}

            .rg-host .empty-hint{position:absolute;left:50%;bottom:18px;transform:translateX(-50%);font-family:var(--mono);font-size:11px;color:var(--ink3);background:var(--paper);border:1px solid var(--edge);border-radius:999px;padding:5px 12px;box-shadow:var(--shadow-md)}

            /* repo empty / indexing state */
            .rg-host .repo-empty{position:absolute;inset:0;display:none;align-items:center;justify-content:center;flex-direction:column;gap:14px;text-align:center;padding:40px}
            .rg-host .repo-empty.show{display:flex}
            .rg-host .repo-empty h3{font-family:var(--display);font-size:19px;margin:0;color:var(--ink);font-weight:600}
            .rg-host .repo-empty p{font-family:var(--mono);font-size:12px;color:var(--ink3);margin:0;max-width:380px;line-height:1.5}
            .rg-host .repo-empty .re-cmd{font-family:var(--mono);font-size:12px;color:var(--ink);background:var(--paper);border:1px solid var(--edge);border-radius:7px;padding:7px 12px}
            .rg-host .repo-empty .spin{width:18px;height:18px;border:2.5px solid var(--amber);border-right-color:transparent;border-radius:50%;animation:rgspin .8s linear infinite}

            /* zoom controls — top-RIGHT, horizontal row. The detail panel now owns
               the LEFT, so the zoom group sits top-right clear of it; the floating
               chat is bottom-right. */
            .rg-host .zoomctl{position:absolute;right:16px;top:14px;display:flex;flex-direction:row;gap:1px;background:var(--cream);border:1px solid var(--edge);border-radius:8px;overflow:hidden;box-shadow:var(--shadow-md);z-index:20}
            .rg-host .zoomctl button{width:30px;height:30px;border:none;background:var(--cream);color:var(--ink2);font-size:15px;cursor:pointer;font-family:var(--mono);padding:0}
            .rg-host .zoomctl button:hover{background:var(--paperD)}
            .rg-host .zoomctl button+button{border-left:1px solid var(--edge)}

            /* side panel */
            .rg-host .panel{position:absolute;top:0;left:-360px;bottom:0;width:320px;background:var(--cream);border-right:1px solid var(--edge);box-shadow:8px 0 24px color-mix(in srgb, var(--ink) 10%, transparent);z-index:30;display:flex;flex-direction:column;transition:left .25s ease}
            .rg-host .panel.open{left:0}
            .rg-host .p-head{padding:16px 18px 12px;border-bottom:1px solid var(--edge)}
            .rg-host .p-eyebrow{display:flex;align-items:center;gap:7px;font-family:var(--mono);font-size:10px;text-transform:uppercase;letter-spacing:.08em;color:var(--ink3);margin-bottom:8px}
            .rg-host .p-eyebrow .gd{width:8px;height:8px;border-radius:3px}
            .rg-host .p-close{margin-left:auto;cursor:pointer;border:none;background:transparent;color:var(--ink3);font-size:16px;width:22px;height:22px;border-radius:5px;line-height:1}
            .rg-host .p-close:hover{background:var(--paperD);color:var(--ink)}
            .rg-host .p-title{font-family:var(--mono);font-size:17px;font-weight:600;color:var(--ink);word-break:break-all}
            .rg-host .p-purpose{font-size:13px;line-height:1.5;color:var(--ink2);margin-top:8px}
            .rg-host .p-body{flex:1;overflow-y:auto;padding:14px 18px}
            .rg-host .p-sec{margin-bottom:18px}
            .rg-host .p-sec h4{font-family:var(--mono);font-size:10px;text-transform:uppercase;letter-spacing:.08em;color:var(--ink3);margin:0 0 8px;display:flex;align-items:center;gap:6px}
            .rg-host .p-sec h4 .ct{margin-left:auto;color:var(--ink3);font-weight:500}
            .rg-host .p-hint{font-size:11px;line-height:1.45;color:var(--ink3);margin:-2px 0 9px}
            .rg-host .symlist{display:flex;flex-direction:column;gap:2px}
            .rg-host .symrow{padding:7px 8px;border-radius:7px;cursor:pointer;border:1px solid transparent}
            .rg-host .symrow:hover{background:var(--paper);border-color:var(--edge)}
            .rg-host .symtop{display:flex;align-items:center;gap:8px;font-family:var(--mono);font-size:12.5px}
            .rg-host .symtop .fn{color:var(--ink);font-weight:600}
            .rg-host .symtop .symk{font-size:9px;text-transform:uppercase;letter-spacing:.05em;color:var(--ink3);border:1px solid var(--edge);border-radius:4px;padding:1px 5px}
            .rg-host .symtop .fl{margin-left:auto;font-size:10px;color:var(--ink3)}
            .rg-host .symsig{font-family:var(--mono);font-size:11px;color:var(--ink2);margin:5px 0 0 16px;word-break:break-word}
            .rg-host .symdesc{font-size:11.5px;line-height:1.4;color:var(--ink2);margin:4px 0 0 16px}
            .rg-host .p-meta{font-family:var(--mono);font-size:11px;color:var(--ink3);margin-top:7px}
            .rg-host .filelist{display:flex;flex-direction:column;gap:1px}
            .rg-host .filerow{display:flex;align-items:center;gap:8px;padding:5px 7px;border-radius:6px;cursor:pointer;font-family:var(--mono);font-size:12px}
            .rg-host .filerow:hover{background:var(--paper)}
            .rg-host .filerow .fn{color:var(--ink);font-weight:500;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex:1;min-width:0}
            .rg-host .filerow .fl{margin-left:auto;font-size:10px;color:var(--ink3);white-space:nowrap;flex-shrink:0}
            .rg-host .filerow .fdot{width:5px;height:5px;border-radius:50%;background:var(--moss);flex-shrink:0}
            .rg-host .filerow .fdot.off{background:var(--edge)}
            .rg-host .imps{display:flex;flex-direction:column;gap:6px}
            .rg-host .improw{display:flex;align-items:center;gap:9px;font-family:var(--mono);font-size:12px}
            .rg-host .improw .ar{color:var(--ink3);font-size:11px}
            .rg-host .improw .im-name{color:var(--ink);font-weight:500;white-space:nowrap;flex-shrink:0}
            .rg-host .improw .bar{flex:1;height:5px;background:var(--paperD);border-radius:3px;overflow:hidden;min-width:24px}
            .rg-host .improw .bar i{display:block;height:100%;background:var(--ink3);border-radius:3px}
            .rg-host .improw .bar i.strong{background:var(--terra)}
            .rg-host .improw .w{font-size:10.5px;color:var(--ink3);width:44px;text-align:right;flex-shrink:0}
            .rg-host .improw .w .wu{color:var(--ink3);font-weight:400}
            .rg-host .p-foot{padding:14px 18px;border-top:1px solid var(--edge)}
            .rg-host .btn{display:flex;align-items:center;justify-content:center;gap:8px;width:100%;padding:10px;border-radius:8px;font-family:var(--body);font-size:13px;font-weight:600;cursor:pointer;border:1px solid var(--edge);background:var(--paper);color:var(--ink);text-decoration:none}
            .rg-host .btn:hover{background:var(--paperD)}
            .rg-host .btn.primary{background:var(--ink);color:var(--cream);border-color:var(--ink)}
            /* Legitimate use of the black keyword (round-1 review audited all
               color-mix(…, black/white) sites for lint-guard evasion): this is
               a genuine 88%-darken of --ink, a background-only hover state
               with no independent contrast claim of its own. Recomputed
               against the live palette: --cream on --ink is 15.86:1 light /
               14.90:1 dark before the mix, 16.40:1 light / 11.37:1 dark after
               — the darken IMPROVES contrast in light and REGRESSES it in
               dark, but stays comfortably clear of the 4.5:1 text floor in
               both. Not an identity mix (unlike the deleted 0%-mix at
               .rc-yes above). */
            .rg-host .btn.primary:hover{background:color-mix(in srgb, var(--ink) 88%, black)}
            .rg-host .btn.ph-trace{background:color-mix(in srgb, var(--resolved) 8%, var(--cream));color:color-mix(in srgb, var(--resolved) 55%, var(--ink));border-color:color-mix(in srgb, var(--resolved) 45%, var(--cream));margin-top:8px}
            .rg-host .btn.ph-trace:hover{background:color-mix(in srgb, var(--resolved) 20%, var(--cream));border-color:var(--resolved)}
            .rg-host .btn.ph-trace .ph-trace-icon{color:var(--resolved);font-family:var(--mono);font-weight:700}
            .rg-host .ph-trace-na{margin-top:8px;font-size:12px;color:var(--ink3);cursor:default;line-height:1.4}
            .rg-host .ph-trace-na .ph-trace-icon{color:var(--ink3);font-family:var(--mono);font-weight:700}
            .rg-host .btn .arrow{font-family:var(--mono)}
            .rg-host .c4-breakdown{display:flex;flex-direction:column;gap:3px;margin-bottom:8px}
            .rg-host .c4-breakdown .bdrow{font-family:var(--mono);font-size:11px;color:var(--ink2)}
            .rg-host .p-honest{font-size:10.5px;line-height:1.45;color:var(--ink3);font-style:italic;margin-top:6px;padding-left:8px;border-left:2px solid var(--edge)}
            .rg-host .p-note{font-family:var(--mono);font-size:10px;color:var(--ink3);text-align:center;margin-top:8px}
            .rg-host .p-empty{font-family:var(--mono);font-size:12px;color:var(--ink3);padding:14px 4px;text-align:center}
            .rg-host .p-note .ok{color:var(--moss);font-weight:600}
            .rg-host .p-note .warn{color:var(--amber);font-weight:600}
            .rg-host .p-note .muted{color:var(--ink3)}
            .rg-host .btn.gening{pointer-events:none;opacity:.85}
            .rg-host .spin,#rg-ex-overlay .spin{display:inline-block;width:13px;height:13px;border:2px solid currentColor;border-right-color:transparent;border-radius:50%;animation:rgspin .7s linear infinite;vertical-align:-2px;margin-right:5px}
            .rg-host .nbadge.expl{color:var(--moss);border-color:var(--moss)}

            /* explain modal */
            #rg-ex-overlay{position:fixed;inset:0;background:color-mix(in srgb, var(--ink) 34%, transparent);z-index:80;display:none;align-items:center;justify-content:center;padding:40px}
            #rg-ex-overlay.open{display:flex}
            #rg-ex-overlay .exmodal{width:660px;max-width:92vw;max-height:86vh;overflow:hidden;background:var(--cream);border:1px solid var(--edge);border-radius:14px;box-shadow:var(--shadow-lg);display:flex;flex-direction:column}
            #rg-ex-overlay .ex-head{padding:18px 22px 16px;border-bottom:1px solid var(--edge);background:var(--paper)}
            #rg-ex-overlay .ex-route{display:flex;align-items:center;gap:8px;font-family:var(--mono);font-size:11px;color:var(--ink3);margin-bottom:9px}
            #rg-ex-overlay .ex-route .rt{background:var(--cream);border:1px solid var(--edge);border-radius:999px;padding:2px 9px}
            #rg-ex-overlay .ex-route .xx{margin-left:auto;cursor:pointer;border:none;background:transparent;color:var(--ink3);font-size:18px;line-height:1}
            #rg-ex-overlay .ex-title{font-family:var(--mono);font-size:19px;font-weight:600;color:var(--ink);word-break:break-all}
            #rg-ex-overlay .ex-guard{display:inline-flex;align-items:center;gap:6px;margin-top:10px;font-family:var(--mono);font-size:10px;color:var(--moss);background:var(--cream);border:1px solid var(--edge);border-radius:999px;padding:3px 9px;white-space:nowrap}
            #rg-ex-overlay .ex-guard .gck{width:6px;height:6px;border-radius:50%;background:var(--moss)}
            #rg-ex-overlay .ex-body{padding:18px 22px;overflow-y:auto}
            #rg-ex-overlay .ex-lead{font-size:14px;line-height:1.6;color:var(--ink);margin:0 0 18px}
            #rg-ex-overlay .ex-lead cite{font-family:var(--mono);font-size:11px;color:var(--terra);font-style:normal;background:var(--paper);border:1px solid var(--edge);border-radius:4px;padding:0 4px;margin:0 1px;white-space:nowrap}
            #rg-ex-overlay .ex-sec{margin-bottom:16px}
            #rg-ex-overlay .ex-sec h5{font-family:var(--mono);font-size:10px;text-transform:uppercase;letter-spacing:.08em;color:var(--ink3);margin:0 0 8px}
            #rg-ex-overlay .ex-chips{display:flex;flex-wrap:wrap;gap:6px}
            #rg-ex-overlay .ex-chip{font-family:var(--mono);font-size:11.5px;color:var(--ink2);background:var(--paper);border:1px solid var(--edge);border-radius:6px;padding:4px 9px;display:inline-flex;align-items:center;gap:6px}
            #rg-ex-overlay .ex-chip b{color:var(--ink);font-weight:600}
            #rg-ex-overlay .ex-ev{display:flex;flex-direction:column;gap:5px}
            #rg-ex-overlay .ex-evrow{display:flex;align-items:center;gap:9px;font-family:var(--mono);font-size:11.5px;color:var(--ink2)}
            #rg-ex-overlay .ex-evrow .ln{color:var(--terra);flex-shrink:0}
            #rg-ex-overlay .ex-foot{padding:14px 22px;border-top:1px solid var(--edge);font-family:var(--mono);font-size:10px;color:var(--ink3);display:flex;align-items:center;gap:8px}

            /* ───────── "Path Highlight" trace level (ph-trace.css) ─────────
               Toolbar bar + entrypoint picker, the dashed trace container,
               trace nodes (reuse .node), and the 4 confidence edge classes.
               Scoped under .rg-host; body.* selectors → .rg-host.*. */
            .rg-host .ph-bar{display:flex;align-items:center;gap:10px;flex-wrap:nowrap}
            .rg-host .ph-enter{display:flex;align-items:center;gap:7px;font-family:var(--body);font-size:12.5px;font-weight:600;color:var(--ink);background:var(--cream);border:1px solid var(--edge);border-radius:8px;padding:6px 12px;cursor:pointer}
            .rg-host .ph-enter:hover{background:var(--paperD);border-color:var(--ink3)}
            .rg-host .ph-enter .pi{color:var(--resolved);font-family:var(--mono);font-weight:700}
            /* trace mode takes over the toolbar: hide search + controls */
            .rg-host.ph-active-bar .toolbar{flex-wrap:wrap;row-gap:8px;column-gap:14px}
            .rg-host.ph-active-bar .search,
            .rg-host.ph-active-bar .tb-spacer,
            .rg-host.ph-active-bar .ctl{display:none}
            .rg-host.ph-active-bar .ph-bar{flex:1 1 auto;flex-wrap:wrap}
            .rg-host.ph-active-bar .crumbs{order:-1;color:var(--ink2)}
            .rg-host.ph-active-bar .empty-hint{display:none}
            .rg-host .ph-pwrap{position:relative}
            /* .ph-pwrap-right retired: the trace ph-bar
               right-push is now the shared .ph-spacer (flex:1), same pattern as the pagehead. */
            .rg-host .ph-pick{display:flex;align-items:center;gap:7px;font-family:var(--body);font-size:12.5px;color:var(--ink);background:color-mix(in srgb, var(--resolved) 8%, var(--cream));border:1px solid color-mix(in srgb, var(--resolved) 45%, var(--cream));border-radius:8px;padding:6px 11px;cursor:pointer;white-space:nowrap}
            .rg-host .ph-pick .pi{color:var(--resolved);font-weight:700;font-family:var(--mono)}
            .rg-host .ph-pick .pl{color:var(--ink2);font-family:var(--mono);font-size:11px}
            .rg-host .ph-pick .cv{color:var(--ink3);font-size:10px}
            .rg-host .ph-menu{position:absolute;top:40px;left:0;width:304px;background:var(--cream);border:1px solid var(--edge);border-radius:11px;box-shadow:var(--shadow-lg);z-index:60;padding:6px;display:none}
            .rg-host .ph-menu.open{display:block}
            .rg-host .ph-menu-right{left:auto;right:0}
            .rg-host .ph-mh{font-family:var(--mono);font-size:10px;text-transform:uppercase;letter-spacing:.08em;color:var(--ink3);padding:7px 8px 6px}
            .rg-host .ph-ep{display:flex;align-items:center;gap:9px;width:100%;text-align:left;padding:8px 9px;border:1px solid transparent;border-radius:8px;background:transparent;cursor:pointer;font-family:var(--body);color:var(--ink);margin-bottom:2px}
            .rg-host .ph-ep:hover{background:var(--paper)}
            .rg-host .ph-ep.sel{background:color-mix(in srgb, var(--resolved) 8%, var(--cream));border-color:color-mix(in srgb, var(--resolved) 45%, var(--cream))}
            .rg-host .ph-ep .ep-dot{width:8px;height:8px;border-radius:50%;background:var(--moss);flex:none}
            .rg-host .ph-ep.sel .ep-dot{background:var(--resolved)}
            .rg-host .ph-ep .ep-m{display:flex;flex-direction:column;gap:2px;min-width:0;flex:1}
            .rg-host .ph-ep .ep-m b{font-size:12.5px;font-weight:600}
            .rg-host .ph-ep .ep-meta{font-family:var(--mono);font-size:10px;color:var(--ink2);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
            .rg-host .ph-ep .ep-on{font-family:var(--mono);font-size:9px;color:var(--resolved);border:1px solid color-mix(in srgb, var(--resolved) 45%, var(--cream));border-radius:4px;padding:1px 5px;flex:none}
            .rg-host .ph-traced-h{margin-top:4px;border-top:1px dashed var(--edge);padding-top:7px}
            .rg-host .ph-traced-row{display:flex;align-items:center;gap:2px}
            .rg-host .ph-traced-row .ph-ep{flex:1;margin-bottom:0}
            .rg-host .ph-traced-row.sel .ph-ep{background:color-mix(in srgb, var(--resolved) 8%, var(--cream));border-color:color-mix(in srgb, var(--resolved) 45%, var(--cream))}
            .rg-host .ph-traced-row.sel .ep-dot{background:var(--resolved)}
            .rg-host .ph-ferase{flex:none;width:22px;height:22px;border:1px solid transparent;border-radius:6px;background:transparent;color:var(--ink3);font-size:15px;line-height:1;cursor:pointer;margin-right:2px}
            .rg-host .ph-ferase:hover{background:var(--paper);border-color:var(--edge);color:var(--ink)}
            .rg-host .ph-mf{font-size:10.5px;color:var(--ink2);padding:8px 8px 4px;border-top:1px dashed var(--edge);margin-top:3px;line-height:1.45}
            .rg-host .ph-fn-div{border-top:1px dashed var(--edge);margin:6px 0 2px}
            .rg-host .ph-fn-sub{margin-top:0;border-top:none}
            .rg-host .ph-fn-search{padding:4px 6px 2px}
            .rg-host .ph-fn-inp{width:100%;box-sizing:border-box;font-family:var(--body);font-size:12px;color:var(--ink);background:var(--paper);border:1px solid var(--edge);border-radius:7px;padding:5px 9px;outline:none}
            .rg-host .ph-fn-inp:focus{border-color:var(--resolved)}
            .rg-host .ph-fn-res{max-height:160px;overflow-y:auto;padding:2px 4px 0}
            .rg-host .ph-fn-res.open{display:block}
            /* search results reuse .ph-ep (preset-row) layout; only the
               keyboard-highlight state is search-specific (matches .ph-ep:hover). */
            .rg-host .ph-fn-result.hl{background:var(--paper)}
            .rg-host .ph-fn-empty{font-size:11px;color:var(--ink3);padding:6px 9px;font-style:italic}

            /* Browse-to-a-function tree (subdir → file → function), additive */
            .rg-host .ph-tree{max-height:220px;overflow-y:auto;padding:2px 4px 4px}
            .rg-host .ph-tree-row{display:flex;align-items:center;gap:6px;width:100%;box-sizing:border-box;background:none;border:none;text-align:left;cursor:pointer;font-family:var(--body);color:var(--ink);padding:4px 6px;border-radius:6px}
            .rg-host .ph-tree-row:hover{background:var(--paper)}
            .rg-host .ph-tw{font-family:var(--mono);font-size:9px;color:var(--ink3);width:10px;flex:none;text-align:center}
            .rg-host .ph-tlabel{font-size:12px;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex:1}
            .rg-host .ph-tree-sub .ph-tlabel{font-weight:600}
            .rg-host .ph-tree-file{padding-left:18px}
            .rg-host .ph-tree-file.empty{cursor:default;color:var(--ink3)}
            .rg-host .ph-tree-file.empty:hover{background:none}
            .rg-host .ph-tree-fn{padding-left:34px}
            .rg-host .ph-tree-fn .ph-tlabel{font-family:var(--mono);font-size:11.5px;color:var(--resolved)}
            .rg-host .ph-fns{font-family:var(--mono);font-size:9px;color:var(--ink2);border:1px solid var(--edge);border-radius:4px;padding:1px 5px;flex:none}
            .rg-host .ph-fns.zero{color:var(--ink3);opacity:.7}

            /* dashed ochre "call path" container */
            .rg-host .gbox.ph-trace-box{border-style:dashed;background:color-mix(in srgb, var(--resolved) 5%, transparent)}

            /* trace nodes (reuse .node) */
            .rg-host .node.kind-trace{border-left:3px solid var(--resolved)}
            .rg-host .node.kind-trace .nname{font-size:12.5px}
            /* .nname is flex:1 → flag + badges sit at the right of .ntop (gap:7px) */
            .rg-host .node.kind-trace .ph-flag{font-family:var(--mono);font-size:9px;font-weight:700;color:var(--onAccent);background:var(--resolved);border-radius:5px;padding:2px 6px;flex:none}
            .rg-host .node.kind-trace .ph-bdg{font-size:11px;flex:none;line-height:1}
            .rg-host .node.kind-trace .ph-bdg.warn{color:var(--unresolved)}
            .rg-host .node.kind-trace.ph-off{border-left-color:var(--ink3);box-shadow:var(--shadow-sm)}
            .rg-host .node.kind-trace.ph-off .nname{color:var(--ink2);font-weight:500}
            .rg-host .node.kind-trace.ph-more{align-items:center;justify-content:center;border-style:dashed;cursor:pointer}
            .rg-host .node.kind-trace.ph-more .nname{color:var(--ink3);font-family:var(--mono);font-size:11px}
            .rg-host .node.kind-trace.ph-more:hover{border-color:var(--ink3);background:var(--paper)}
            .rg-host .node.kind-trace.ph-unres{border:2px dotted var(--unresolvable);border-left-width:2px;background:color-mix(in srgb, var(--unresolvable) 8%, var(--cream))}
            .rg-host .node.kind-trace.ph-unres .nname{color:var(--unresolvable)}
            .rg-host .node.kind-trace.ph-branch{border:1px dashed var(--resolved);border-left:3px dashed var(--resolved);background:color-mix(in srgb, var(--resolved) 3%, var(--cream));padding:8px 12px;justify-content:center}
            .rg-host .node.kind-trace.ph-branch .nname{font-size:11.5px;color:var(--ink)}
            .rg-host .node.kind-trace .ph-brtag{font-family:var(--mono);font-size:8.5px;font-weight:700;color:var(--resolved);background:color-mix(in srgb, var(--resolved) 8%, var(--cream));border:1px solid color-mix(in srgb, var(--resolved) 45%, var(--cream));border-radius:4px;padding:1px 5px;flex:none;margin-left:auto}

            /* trace edges (reuse .elink) — the 4 confidence classes */
            .rg-host .elink.ph-resolved{stroke:var(--resolved)}
            .rg-host .elink.ph-inferred{stroke:var(--resolved)}
            .rg-host .elink.ph-unresolved{stroke:var(--unresolved);stroke-dasharray:6 5}
            .rg-host .elink.ph-unresolvable{stroke:var(--unresolvable);stroke-dasharray:1.5 5}
            .rg-host .elink.ph-dim{stroke:var(--ink3)}
            .rg-host .elink.ph-fork{stroke:var(--resolved);stroke-dasharray:5 4}

            /* ── trace node card in the shipped .panel (ph-trace.css) ── */
            .rg-host .ph-class{display:inline-block;font-family:var(--mono);font-size:9.5px;font-weight:600;margin-top:9px;padding:2px 8px;border-radius:5px;letter-spacing:.04em}
            .rg-host .ph-class.entry,.rg-host .ph-class.resolved{color:var(--resolved);background:color-mix(in srgb, var(--resolved) 8%, var(--cream));border:1px solid color-mix(in srgb, var(--resolved) 45%, var(--cream))}
            .rg-host .ph-class.unresolvable{color:var(--unresolvable);background:color-mix(in srgb, var(--unresolvable) 8%, var(--cream));border:1px solid color-mix(in srgb, var(--unresolvable) 45%, var(--cream))}
            .rg-host .ph-f{margin-bottom:14px}
            .rg-host .ph-lbl{font-family:var(--mono);font-size:9.5px;text-transform:uppercase;letter-spacing:.08em;color:var(--ink3);margin-bottom:5px}
            .rg-host .ph-val{background:var(--paper);border:1px solid var(--edge);border-radius:7px;padding:8px 10px;font-size:12.5px;color:var(--ink);word-break:break-word;line-height:1.5}
            .rg-host .ph-val.mono{font-family:var(--mono);font-size:11.5px}
            .rg-host .ph-val.empty{display:flex;align-items:center;justify-content:space-between;gap:10px;color:var(--ink2);flex-wrap:wrap}
            .rg-host .ph-val.gen{border-color:color-mix(in srgb, var(--resolved) 45%, var(--cream));background:color-mix(in srgb, var(--resolved) 3%, var(--cream))}
            .rg-host .ph-val.loading{display:flex;align-items:center;gap:9px}
            .rg-host .ph-spark{color:var(--resolved)}
            .rg-host .ph-cite{font-family:var(--mono);font-size:10px;color:var(--ink2);margin-top:7px;padding-top:7px;border-top:1px dashed var(--edge)}
            .rg-host .ph-cite a{color:var(--resolved);text-decoration:underline;cursor:pointer}
            .rg-host .ph-hint{font-size:10.5px;color:var(--ink2);margin-top:6px;line-height:1.45}
            .rg-host .ph-genbtn{font-family:var(--mono);font-size:11px;border:1px solid var(--moss);background:transparent;color:color-mix(in srgb, var(--moss) 55%, var(--ink));padding:4px 10px;border-radius:6px;cursor:pointer;white-space:nowrap;font-weight:600}
            .rg-host .ph-genbtn:hover{background:var(--moss);color:var(--onAccent)}
            .rg-host .ph-spin{width:13px;height:13px;border:2px solid var(--edge);border-top-color:var(--resolved);border-radius:50%;display:inline-block;animation:rgspin .7s linear infinite;flex:none}
            .rg-host .ph-err{background:color-mix(in srgb, var(--unresolvable) 8%, var(--cream));border:1px solid color-mix(in srgb, var(--unresolvable) 45%, var(--cream));border-radius:7px;padding:9px 11px}
            .rg-host .ph-err b{color:var(--unresolvable);font-size:12px}
            .rg-host .ph-err .ph-er{font-family:var(--mono);font-size:10.5px;color:color-mix(in srgb, var(--unresolvable) 55%, var(--ink));margin:5px 0 8px;line-height:1.5}
            .rg-host .ph-offnote{background:var(--paper);border:1px solid var(--edge);border-left:3px solid var(--ink3);border-radius:7px;padding:9px 11px;font-size:11.5px;color:var(--ink2);line-height:1.5;margin-bottom:13px}
            .rg-host .ph-offnote b{color:var(--ink)}
            .rg-host .ph-offnote code{font-family:var(--mono);font-size:10.5px;background:var(--cream);border:1px solid var(--edge);border-radius:4px;padding:0 4px}

            /* ── coverage badge + "why" popover + legend + red fallback ── */
            .rg-host .ph-cwrap{position:relative}
            .rg-host .ph-covinfo{display:inline-flex;align-items:center;gap:7px;font-family:var(--mono);font-size:11px;color:var(--ink2);background:var(--cream);border:1px solid var(--edge);border-radius:8px;padding:6px 10px;cursor:pointer;white-space:nowrap}
            .rg-host .ph-covinfo:hover{background:var(--paperD)}
            .rg-host .ph-covinfo .cv{color:var(--ink3);font-size:10px}
            .rg-host .ph-covinfo b{color:var(--ink);font-weight:700}
            .rg-host .ph-covinfo.ok{border-color:color-mix(in srgb, var(--moss) 45%, var(--cream))}.rg-host .ph-covinfo.warn{border-color:color-mix(in srgb, var(--resolved) 45%, var(--cream))}.rg-host .ph-covinfo.bad{border-color:color-mix(in srgb, var(--unresolvable) 45%, var(--cream))}
            .rg-host .ph-covinfo .cb-dot{width:8px;height:8px;border-radius:50%;background:var(--moss);flex:none}
            .rg-host .ph-covinfo.warn .cb-dot{background:var(--amber)}
            .rg-host .ph-covinfo.bad .cb-dot{background:var(--terra)}
            .rg-host .ph-covinfo .cb-go{font-size:9px;color:color-mix(in srgb, var(--moss) 55%, var(--ink));background:color-mix(in srgb, var(--moss) 8%, var(--cream));border:1px solid color-mix(in srgb, var(--moss) 45%, var(--cream));border-radius:4px;padding:1px 6px;letter-spacing:.02em;white-space:nowrap}
            .rg-host .ph-covinfo.warn .cb-go{color:color-mix(in srgb, var(--resolved) 55%, var(--ink));background:color-mix(in srgb, var(--resolved) 8%, var(--cream));border-color:color-mix(in srgb, var(--resolved) 45%, var(--cream))}
            .rg-host .ph-covinfo.bad .cb-go{color:color-mix(in srgb, var(--unresolvable) 55%, var(--ink));background:color-mix(in srgb, var(--unresolvable) 8%, var(--cream));border-color:color-mix(in srgb, var(--unresolvable) 45%, var(--cream))}
            /* .ph-cpop + .cv-* + .cw-ic + .cv-foot CSS DELETED:
               old hand-built popup retired; confidence popover now uses anchor-popover
               primitive (src/web/client/islands/anchor-popover.ts). Styles injected
               by anchor-popover.ts injectStyle() under [data-anchor-popover] scope. */

            /* legend chip (bottom-left of the stage) */
            .rg-host #rg-ph-legend{position:absolute;left:14px;bottom:14px;z-index:22}
            .rg-host .lg-btn{display:inline-flex;align-items:center;gap:6px;font-family:var(--mono);font-size:11px;color:var(--ink2);background:var(--cream);border:1px solid var(--edge);border-radius:999px;padding:6px 12px;cursor:pointer;box-shadow:var(--shadow-sm)}
            .rg-host .lg-btn:hover{background:var(--paperD);border-color:var(--ink3);color:var(--ink)}
            .rg-host .lg-btn>span{width:15px;height:15px;border-radius:50%;background:var(--ink);color:var(--cream);display:flex;align-items:center;justify-content:center;font-size:10px;font-weight:700}
            .rg-host .lg-pop{position:absolute;left:0;bottom:42px;width:320px;max-height:calc(100vh - 230px);overflow-y:auto;background:var(--cream);border:1px solid var(--edge);border-radius:12px;box-shadow:var(--shadow-lg);padding:12px 14px;display:none}
            .rg-host .lg-pop.open{display:block}
            .rg-host .lg-h{font-family:var(--mono);font-size:10px;text-transform:uppercase;letter-spacing:.08em;color:var(--ink3);margin:11px 0 6px;padding-bottom:4px;border-bottom:1px dashed var(--edge)}
            .rg-host .lg-h:first-child{margin-top:0}
            .rg-host .lg-row{display:flex;align-items:flex-start;gap:9px;font-size:11px;color:var(--ink2);line-height:1.45;margin-bottom:7px}
            .rg-host .lg-row svg{flex:none;margin-top:5px}
            .rg-host .lg-row b{color:var(--ink)}
            .rg-host .lg-sw{flex:none;width:30px;height:18px;border-radius:5px;margin-top:1px}
            .rg-host .lg-sw.white{background:var(--cream);border:1px solid var(--edge)}
            .rg-host .lg-sw.red{background:color-mix(in srgb, var(--unresolvable) 8%, var(--cream));border:2px dotted var(--unresolvable)}
            .rg-host .lg-sw.dim{background:var(--cream);border:1px solid var(--edge);opacity:.3}
            .rg-host .lg-bdg{flex:none;font-family:var(--mono);font-size:10px;color:var(--resolved);background:color-mix(in srgb, var(--resolved) 8%, var(--cream));border:1px solid color-mix(in srgb, var(--resolved) 45%, var(--cream));border-radius:5px;padding:2px 7px;min-width:30px;text-align:center}

            /* red-tier fallback note over the stage */
            .rg-host #rg-ph-fallback{position:absolute;top:50%;left:50%;transform:translate(-50%,-50%);display:none;align-items:flex-start;gap:11px;background:color-mix(in srgb, var(--unresolvable) 8%, var(--cream));border:1px solid color-mix(in srgb, var(--unresolvable) 45%, var(--cream));border-radius:13px;box-shadow:var(--shadow-lg);padding:16px 18px;max-width:380px;z-index:24}
            .rg-host #rg-ph-fallback .fb-ic{font-size:20px;flex:none;line-height:1.2}
            .rg-host #rg-ph-fallback b{color:var(--unresolvable);font-size:13px}
            .rg-host #rg-ph-fallback p{margin:6px 0 0;font-size:11.5px;color:color-mix(in srgb, var(--unresolvable) 55%, var(--ink));line-height:1.55}
            .rg-host .stage.ph-fallback .world{filter:saturate(.6) blur(.4px);opacity:.5}

            /* ── shared/warn card chips + ▲▼ stepper (ph-trace.css) ── */
            .rg-host .ph-chip{display:inline-flex;align-items:center;gap:6px;font-family:var(--mono);font-size:10.5px;border-radius:999px;padding:4px 10px;margin:0 6px 8px 0}
            .rg-host .ph-chip.shared{color:var(--ink2);border:1px solid var(--ink3)}
            .rg-host .ph-warn{background:color-mix(in srgb, var(--resolved) 8%, var(--cream));border:1px solid color-mix(in srgb, var(--resolved) 45%, var(--cream));color:color-mix(in srgb, var(--resolved) 55%, var(--ink));border-radius:8px;padding:9px 11px;font-size:11.5px;line-height:1.5;margin-top:6px}
            .rg-host .p-eyebrow-r{margin-left:auto;display:inline-flex;align-items:center;gap:8px}
            .rg-host .ph-step{display:inline-flex;border:1px solid var(--edge);border-radius:7px;overflow:hidden;background:var(--cream)}
            .rg-host .ph-stb{font-family:var(--mono);font-size:10px;color:var(--ink2);background:transparent;border:none;padding:3px 9px;cursor:pointer}
            .rg-host .ph-stb:hover:not(:disabled){background:var(--paperD);color:var(--ink)}
            .rg-host .ph-stb:first-child{border-right:1px solid var(--edge)}
            .rg-host .ph-stb:disabled{color:var(--edge);cursor:default}

            /* C4 side panel — Key pieces + Talks-to/Called-by rows (ported from oracle). */
            .rg-host .p-tech{font-family:var(--mono);font-size:11px;color:var(--ink3);margin-top:3px}
            .rg-host .rel{display:flex;flex-direction:column;gap:7px}
            .rg-host .relrow{display:flex;align-items:baseline;gap:8px;font-size:12px;color:var(--ink2);line-height:1.5;margin-bottom:2px}
            .rg-host .relrow .ar{font-family:var(--mono);color:var(--terra);flex-shrink:0;font-size:11px}
            .rg-host .relrow b{color:var(--ink);font-weight:600}
            .rg-host .relrow .vb{color:var(--ink3);font-style:italic;margin-right:2px}
            .rg-host .comp{display:flex;flex-direction:column;gap:8px}
            .rg-host .comprow{display:flex;flex-direction:column;gap:1px;padding-left:10px;border-left:2px solid var(--edge)}
            .rg-host .comprow .cn{font-family:var(--mono);font-size:12px;color:var(--ink);font-weight:600}
            .rg-host .comprow .cd{font-size:11px;color:var(--ink3);line-height:1.35}
            /* C4 arch views hide the codemap "?" help popover (import-count
               explainer doesn't apply; C4 has its own in-canvas legend). */
            .rg-host.rg-arch-c4 .ctl .help-btn,
            .rg-host.rg-arch-c4-derived .ctl .help-btn{display:none}
            /* ── the architecture view — C4 container diagram (ported from the oracle prototype) ── */
            .rg-host .c4-boundary{position:absolute;border:1.5px dashed var(--ink3);border-radius:14px;opacity:.7;pointer-events:none}
            .rg-host .c4-boundary .c4-blab{position:absolute;top:-11px;left:18px;background:var(--cream);padding:0 8px;font-family:var(--mono);font-size:11px;color:var(--ink2);font-weight:600}
            .rg-host .c4-band{position:absolute;border-radius:11px;pointer-events:none}
            /* single line — a wrapped tag exceeds BAND_HEAD (26px) and the
               first node covers the overflow. Narrow bands let the tag spill right
               rather than fold down onto a node. */
            .rg-host .c4-band .c4-bandlab{position:absolute;top:9px;left:14px;font-family:var(--mono);font-size:10px;letter-spacing:.1em;text-transform:uppercase;font-weight:600;white-space:nowrap}
            .rg-host .c4-band .c4-bandnote{position:absolute;top:9px;right:14px;font-family:var(--body);font-size:10.5px;font-style:italic;color:var(--ink3)}
            /* anti-slop: "by name" marker — taxonomy-guessed layer name, visibly
               secondary so it never reads like an authored/grounded label. */
            .rg-host .c4-band .c4-bandby{margin-left:7px;font-family:var(--mono);font-size:8px;font-weight:400;letter-spacing:.03em;text-transform:none;color:var(--ink3);border:1px dashed var(--edge);border-radius:999px;padding:0 5px;opacity:.8;vertical-align:middle}
            .rg-host .c4-node{position:absolute;border-radius:10px;padding:10px 12px;display:flex;flex-direction:column;gap:3px;box-shadow:var(--shadow-md);z-index:3;border:1px solid var(--edge);background:var(--cream);cursor:pointer;transition:box-shadow .12s,transform .12s,opacity .14s}
            .rg-host .c4-node:hover{transform:translateY(-2px);box-shadow:var(--shadow-lg);border-color:var(--ink3)}
            .rg-host .c4-node.sel{border-color:var(--ink);box-shadow:0 0 0 2px var(--ink),var(--shadow-lg)}
            .rg-host .c4-node.dim{opacity:.26}
            .rg-host .c4-node .c4-drill{position:absolute;top:5px;right:7px;font-family:var(--mono);font-size:12px;line-height:1;color:var(--ink3);pointer-events:none}
            .rg-host .c4-node.drillable:hover .c4-drill{color:var(--ink)}
            .rg-host .p-note .p-drill{font-family:var(--mono);font-size:11px;color:var(--ink2)}
            .rg-host .c4-node .c4-ntitle{font-family:var(--body);font-size:13.5px;font-weight:600;color:var(--ink);line-height:1.15}
            .rg-host .c4-node .c4-ntech{font-family:var(--mono);font-size:9px;color:var(--ink3)}
            /* clamp to 3 lines — node box is a fixed BOX_H (92px); an
               unclamped desc spills past the bottom border. Full text lives in
               the side panel (p-purpose) on click. */
            .rg-host .c4-node .c4-ndesc{font-size:10.5px;line-height:1.32;color:var(--ink2);display:-webkit-box;-webkit-line-clamp:3;-webkit-box-orient:vertical;overflow:hidden}
            /* Honest-subset literal count badge (derived nodes only). */
            .rg-host .c4-node .c4-ncount{margin-top:4px;font-family:var(--mono);font-size:9.5px;color:var(--ink3);letter-spacing:.02em}
            .rg-host .c4-node.person{background:var(--ink);border-color:var(--ink);border-radius:12px 12px 10px 10px}
            .rg-host .c4-node.person .c4-ntitle{color:var(--cream)}
            .rg-host .c4-node.person .c4-ndesc{color:color-mix(in srgb, var(--cream) 70%, var(--ink))}
            .rg-host .c4-node.ext{background:var(--paperD);border-style:dashed;border-color:var(--ink3)}
            .rg-host .c4-node.accent-terra{border-left:4px solid var(--terra)}
            .rg-host .c4-node.accent-amber{border-left:4px solid var(--amber)}
            .rg-host .c4-node.accent-moss{border-left:4px solid var(--moss)}
            .rg-host .c4-node.accent-sky{border-left:4px solid var(--sky)}
            /* cap long verbs with an ellipsis (full text on hover title + in
               the side panel Talks-to) so a chip can't sprawl across the canvas. */
            .rg-host .c4-elab{position:absolute;z-index:4;font-family:var(--mono);font-size:9.5px;color:var(--ink2);background:var(--cream);border:1px solid var(--edge);border-radius:5px;padding:2px 6px;transform:translate(-50%,-50%);white-space:nowrap;max-width:150px;overflow:hidden;text-overflow:ellipsis;box-shadow:0 1px 2px color-mix(in srgb, var(--ink) 6%, transparent);text-align:center;opacity:0;transition:opacity .14s;pointer-events:none}
            .rg-host .c4-elab.show{opacity:1}


            [x-cloak]{display:none !important}
          `,
        }}
      />

      <div class="rg-host" x-data="repoGraph" data-initial={initialPayload} data-secret={secret ?? ""}>
        {/* Page head — repo picker label is baked server-side (dropdown wired by the island). */}
        <div class="pagehead">
          <h1>Code map</h1>
          <div class="repo-pick-wrap">
            <button class="repo-pick" id="rg-repo-pick" type="button" aria-label="Switch repository">
              <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
                <path d="M1.5 4 C1.5 3 2 2.5 3 2.5 L6 2.5 L7.5 4 L13 4 C14 4 14.5 4.5 14.5 5.5 L14.5 12 C14.5 13 14 13.5 13 13.5 L3 13.5 C2 13.5 1.5 13 1.5 12 Z" />
              </svg>
              <b id="rg-repo-name">{repoLabel}</b>
              <span class="chev">▾</span>
            </button>
            <div class="repo-menu" id="rg-repo-menu"></div>
          </div>
          {/* Stats immediately follow repo-pick-wrap (left cluster);
              margin-left:auto removed; ph-spacer (below) pushes right cluster right. */}
          <span class="idx-stat">
            <b id="rg-st-files">{fmt(stats.files)}</b> files · <b id="rg-st-symbols">{fmt(stats.symbols)}</b> symbols · <b id="rg-st-edges">{fmt(stats.edges)}</b> edges
          </span>
          {/* Flex spacer: pushes everything after it to the trailing edge */}
          <span class="ph-spacer" aria-hidden="true" />
          {/* LOUD honest degrade — generated view only;
              counts containers the model drew without any file evidence. */}
          <span class="arch-noevi" id="rg-arch-noevi" hidden></span>
          {/* Source chip: always visible on a repo with an authored model.
              Segment click switches the view in place. $0 elements only on
              this side of the row (chip, grounded%, route). */}
          <span class="src-chip" id="rg-src-chip" hidden>
            <button class="src-seg" id="rg-src-authored" type="button" title="Hand-authored architecture (.siltpoke/arch-c4.json)">Authored</button>
            <button class="src-seg" id="rg-src-generated" type="button" title="LLM-generated architecture">
              Generated<span id="rg-src-stale" class="src-stale" hidden> ·stale</span>
            </button>
          </span>
          {/* Spatial isolation: divider + paid button
              are the LAST children, never adjacent to the $0 chip cluster. Buffer
              after the /repo-graph route tag's removal (user density pass) is the
              hairline divider + gaps alone; the modal confirm is the second layer
              the click-target separation leans on (user-accepted trade-off).
              The pagehead-divider span provides the visible 1px --edge hairline;
              margin-left:14px on arch-gen provides the gap after it. */}
          <span class="pagehead-divider" aria-hidden="true" />
          <button class="arch-gen" id="rg-arch-gen" type="button" hidden style="margin-left:14px">
            <span id="rg-arch-gen-label">⚡ Generate architecture</span>
            <span class="cost" id="rg-arch-gen-cost"></span>
          </button>
        </div>

        {/* Daemon-staleness strip. NON-dismissible by
            design — it self-clears on daemon restart, so persistence would hide
            a live problem. Only renders when the running daemon is behind repo
            HEAD. */}
        {stalenessBanner ? (
          <div
            class="banner"
            id="rg-daemon-stale"
            style="background:color-mix(in srgb, var(--terra) 8%, var(--cream));border-bottom-color:var(--terra);color:var(--terra)"
          >
            {stalenessBanner}
          </div>
        ) : null}
      {/* Fail-soft notice: a .siltpoke/arch-c4.json existed but failed
          validation — say so visibly while the derived cascade renders. */}
      {authoredInvalid ? (
        <div class="banner" id="rg-authored-invalid">
          <strong>Authored model invalid:</strong> .siltpoke/arch-c4.json failed validation — showing the derived view instead.
        </div>
      ) : null}

        {/* Toolbar */}
        <div class="toolbar">
          <div class="crumbs" id="rg-crumbs"></div>
          <div class="search">
            <span class="si">
              <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6">
                <circle cx="7" cy="7" r="4.5" />
                <path d="M11 11 L14 14" stroke-linecap="round" />
              </svg>
            </span>
            <input id="rg-search-input" placeholder="Jump to symbol… (e.g. runExplain)" autocomplete="off" spellcheck={false} />
            <div class="results" id="rg-search-results"></div>
          </div>
          <div class="tb-spacer"></div>
          <div class="ctl">
            <button class="help-btn" id="rg-help-btn" type="button" title="What do the lines and numbers mean?">?</button>
          </div>
          {/* Grounded chip relocated from pagehead to toolbar-right,
              adjacent to "⟜ Trace a path" / entrypoint picker. Architecture-mode only —
              hidden gating unchanged (updateArchAffordance queries by id, transparent).
              .arch-chip-tbwrap provides position:relative so the anchor-popover anchors
              to the chip, not the whole toolbar. align:"right" at the call-site is correct
              for a chip at the toolbar's right edge (popover extends left, avoids clipping). */}
          <div class="arch-chip-tbwrap" id="rg-arch-chip-wrap">
            <button type="button" class="arch-chip" id="rg-arch-chip" hidden aria-expanded="false" title="share of claims backed by [file:line] evidence">
              grounded <b id="rg-arch-chip-pct"></b>
              <span id="rg-arch-chip-blind" class="chip-blind" hidden></span>
            </button>
          </div>
          {/* Path Highlight bar — island fills it: "⟜ Trace a path"
              button at arch level; entrypoint picker once in trace mode. */}
          <div class="ph-bar" id="rg-phbar"></div>
          <div class="help-pop" id="rg-help-pop">
            <h5>How to read this graph</h5>
            <div class="hrow"><span class="hic"><svg width="22" height="10"><circle cx="11" cy="5" r="3" fill="none" stroke="var(--ink3)" stroke-width="1.6" /></svg></span><span>The canvas is calm by default. <b>Hover or click a module</b> to reveal its <b>import lines</b>.</span></div>
            <div class="hrow"><span class="hic"><svg width="22" height="10"><line x1="1" y1="5" x2="16" y2="5" stroke="var(--ink3)" stroke-width="2" /><path d="M14 2 L20 5 L14 8" fill="none" stroke="var(--ink3)" stroke-width="1.6" /></svg></span><span>The <b>arrow</b> points at what's imported — <code>A → B</code> means A imports B.</span></div>
            <div class="hrow"><span class="hic" style="font-family:var(--mono);color:var(--ink);font-weight:600">28</span><span>The <b>number</b> = how many <b>import statements</b> cross that link. <b>High</b> = tightly coupled (changing one likely affects the other); <b>low</b> = a light, incidental dependency.</span></div>
            <div class="hrow"><span class="hic"><svg width="22" height="10"><line x1="1" y1="5" x2="21" y2="5" stroke="var(--terra)" stroke-width="3.5" /></svg></span><span><b>Red, thicker</b> lines are <b>strong</b> — more than 15 imports.</span></div>
            <div class="hrow"><span class="hic"><span style="font-family:var(--mono);font-size:9px;color:var(--ink3);border:1px solid var(--edge);border-radius:999px;padding:1px 5px">44</span></span><span>The <b>number on a module card</b> is its <b>file count</b> (LOC + symbols deeper in).</span></div>
          </div>
        </div>

        {/* Stage */}
        <div class="stage" id="rg-stage">
          <div class="viewport" id="rg-viewport">
            <div class="world" id="rg-world">
              <svg class="edges" id="rg-edges"></svg>
            </div>
          </div>
          <div class="empty-hint" id="rg-hint" style={hasGraph ? "" : "display:none"}>Click a module to inspect · click again to drill into files</div>
          <div class="repo-empty" id="rg-repo-empty"></div>
          {hasGraph ? null : (
            <div class="repo-empty show">
              <h3>No graph indexed for this repo</h3>
              {/* Was a `/siltpoke-index` command chip. That command has not
                  existed since #279 cut the command surface from 37 to 8, and
                  indexing has never needed one from here anyway: the repo
                  picker in this page's header POSTs /api/repo-graph/index. The
                  chip both named a dead command and looked clickable while
                  being inert text. */}
              <p>Pick this repo from the selector above to index it.</p>
            </div>
          )}
          <div class="zoomctl">
            <button id="rg-zoom-in" type="button" title="Zoom in">+</button>
            <button id="rg-zoom-fit" type="button" title="Fit" style="font-size:11px">fit</button>
            <button id="rg-zoom-out" type="button" title="Zoom out">−</button>
          </div>

          {/* Side panel (content filled by the island) */}
          <aside class="panel" id="rg-panel">
            <div class="p-head" id="rg-phead"></div>
            <div class="p-body" id="rg-pbody"></div>
            <div class="p-foot" id="rg-pfoot"></div>
          </aside>
        </div>
      </div>

      {/* Explain preview modal */}
      <div id="rg-ex-overlay"><div class="exmodal" id="rg-ex-modal"></div></div>
      <div id="rg-edge-tip"></div>
    </Dashboard>
  );
}
