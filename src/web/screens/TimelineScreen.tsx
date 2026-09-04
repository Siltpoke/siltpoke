// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
// Copyright (c) 2026 Jiaqi Duan
/** @jsxImportSource hono/jsx */
/**
 * Timeline screen — the merged /history + /traces master/detail page.
 *
 * Layout: header (kicker + summary line contextual to the active filter)
 * → compact filter row (timeline/filter-row.tsx — reuses /history's
 * FilterChip/ProjectSelect/filterHref pieces for parity by reuse; kind +
 * range are selects, sort lives in the rail header) → left master rail
 * (turn list) + right dossier (tab shell; Critic tab live,
 * Diff / Trace / Feedback stubs land next).
 *
 * Row select is Alpine state (`selected`) over server-embedded panes —
 * the same embed-hidden mechanism /history row expansions use; no island,
 * no fetch, no reload. Diff bodies are NOT embedded (loaded
 * on demand via GET /api/critique/:id/diff).
 *
 * Nav shows ONE "Timeline" entry where History + Traces were;
 * /history + /traces redirect here; activeSection="timeline".
 *
 * STYLE CHOICE (deliberate): token-system inline styles, NOT Tailwind — the
 * page embeds the non-Tailwind BlockA/FilterBar/RowActions primitive family
 * verbatim; a Tailwind wrapper around them would be visually inconsistent.
 * Revisit when those primitives convert.
 */

import type { ReviewUnit } from "../../router/review-unit";
import type { CriticTelemetry } from "../../state/api";
import { CANONICAL_NAV } from "../routes/nav";
import { Dashboard } from "../shells/Dashboard";
import { tokens } from "../tokens/tokens";
import { DetailPane, EmptyDetail } from "./timeline/detail-pane";
import { TimelineFilterRow } from "./timeline/filter-row";
import { fmtCost, fmtTokens, turnKey } from "./timeline/format";
import { makeProjHashResolver } from "./timeline/proj-hash";
import { ReviewUnitRow } from "./timeline/review-unit-row";
import { TimelineRail } from "./timeline/rail";

export interface TimelineScreenProps {
  telemetry: CriticTelemetry;
  /**
   * ⏱ Which unit of work closes before a review fires, read from config.json
   * by the route. REQUIRED, not optional-with-a-default: this control's whole
   * history is of a setting that rendered fine while reaching nobody, and an
   * optional prop lets a caller drop it in silence.
   */
  reviewUnit: ReviewUnit;
  /** Daemon secret — forwarded to the review-unit island's own container so
   * its Save POST to /api/config carries `X-Siltpoke-Secret`. */
  secret?: string;
  /**
   * Forwarded filter/pager querystring (no leading `?`, `key` excluded) so a
   * lazy dossier placeholder re-requests its DetailPane against the SAME
   * window. Empty string = no active filters. Optional so existing callers /
   * tests that construct the screen directly keep working (they render every
   * pane eager, the pre-lazy behavior).
   */
  dossierQuery?: string;
}

/**
 * Top summary line, contextual to the active filter. Honest totals:
 * when the range holds more turns than the page shows, lead with the TOTAL
 * range-passing count plus the page count
 * (`2,535 turns in range · showing 200 · …`); a single page keeps the plain
 * `N turns · …` (N IS the total). tokens/$ + acked/dismissed stay
 * contextual to the visible page.
 */
export function summaryLine(telemetry: CriticTelemetry): string {
  const n = telemetry.recent.length;
  const { totals, actionStats, totalInRange } = telemetry;
  const tail = `${fmtTokens(totals.tokens)} tok · ${fmtCost(totals.cost_usd)} · ${actionStats.acked} acked / ${actionStats.dismissed} dismissed`;
  if (totalInRange !== null && totalInRange !== n) {
    return `${totalInRange.toLocaleString("en-US")} turns in range · showing ${n} · ${tail}`;
  }
  return `${n} ${n === 1 ? "turn" : "turns"} · ${tail}`;
}

/**
 * Reactive-state CSS the inline styles can't express (Alpine data-active),
 * plus the native-HTML machinery the x-html-injected trace fragment relies
 * on (details/summary span rows + CSS-only radio tabs — no Alpine, no
 * script inside the fragment) and the class-scoped thin scrollbars.
 *
 * The filter-row select's chevron is a `background-image: url("data:image/
 * svg+xml,...")` data URI — a CSS custom property cannot be referenced
 * inside that string, so the SVG's stroke color is necessarily a literal
 * PER THEME (the encoded ink token's own hex, not a new hue). Mirrors
 * tokens.css's own four-block theme structure (a `prefers-color-scheme`
 * media block + forced `[data-theme]` blocks) rather than inventing a third
 * mechanism. This is the fix for a real, previously-flagged live defect:
 * the chevron used to stay light-mode-colored in dark mode (see the CSS
 * comment further down, dated before this fix).
 *
 * NOTE for anyone editing this string: do not spell out either color's hex
 * digits in a comment INSIDE this template literal — the color-literal
 * guard (scripts/lint-no-hardcoded-color.ts) scans raw string CONTENT, not
 * JS/CSS comment semantics, so a hex mentioned in a "CSS comment" here
 * would still be flagged as a violation (this is not hypothetical — an
 * earlier draft of this exact fix did that and had to be corrected).
 */
const TIMELINE_CSS = `
.tl-row:hover{background:var(--color-cream)}
.tl-row[data-active="true"]{background:var(--color-cream);box-shadow:inset 3px 0 0 var(--color-ink)}
.tl-tab{font-family:var(--font-mono);font-size:10px;letter-spacing:.06em;text-transform:uppercase;
  padding:7px 14px;background:transparent;border:none;border-bottom:2px solid transparent;
  color:var(--color-ink3);cursor:pointer}
.tl-tab[data-active="true"]{color:var(--color-ink);border-bottom-color:var(--color-ink);font-weight:600}
.tl-span-row:hover{background:var(--color-paper)}

/* Filter-row selects — scale-up + chevron (visual parity with .fsel +
   dSelPill). Scoped to the row so /history's shared components elsewhere
   are untouched. !important beats the shared ProjectSelect's inline pill
   styles (incl. its background SHORTHAND, which would otherwise wipe the
   chevron background-image) without forking it. */
.tl-filter-row select{
  font-size:11px!important;font-weight:600!important;
  color:var(--color-ink2)!important;
  border:1px solid var(--color-edge)!important;border-radius:8px!important;
  background-color:var(--color-cream)!important;
  padding:5px 26px 5px 10px!important;
  /* One shared control height — the flat segments measure 28px, so the
     select and the search input pin to it (measured live). */
  height:28px!important;box-sizing:border-box!important;
  max-width:220px;cursor:pointer;outline:none;
  appearance:none;-webkit-appearance:none;
  background-image:url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 10 6'%3E%3Cpath d='M1 1l4 4 4-4' fill='none' stroke='%235a4f3f' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'/%3E%3C/svg%3E")!important;
  background-repeat:no-repeat!important;
  background-position:right 10px center!important;
  background-size:9px 6px!important;
}
/* Hover: darken the border one step and lift the fill, both derived from
   tokens so the pair follows the theme. These were two beige literals that
   stayed beige in dark mode while the rest of the row went dark. */
.tl-filter-row select:hover{border-color:var(--color-ink3)!important;background-color:var(--color-paper)!important}
/* Dark-theme chevron — see the file's own doc comment above TIMELINE_CSS
   for why this SVG data URI must stay a per-theme literal. */
@media (prefers-color-scheme: dark) {
  :root:not([data-theme="light"]) .tl-filter-row select{
    background-image:url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 10 6'%3E%3Cpath d='M1 1l4 4 4-4' fill='none' stroke='%23adadad' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'/%3E%3C/svg%3E")!important;
  }
}
:root[data-theme="dark"] .tl-filter-row select{
  background-image:url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 10 6'%3E%3Cpath d='M1 1l4 4 4-4' fill='none' stroke='%23adadad' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'/%3E%3C/svg%3E")!important;
}

/* Thin styled scrollbars — scoped to the rail + dossier scroll panes. */
.tl-scroll{scrollbar-width:thin;scrollbar-color:var(--color-edge) transparent}
.tl-scroll::-webkit-scrollbar{width:8px;height:8px}
.tl-scroll::-webkit-scrollbar-thumb{background:var(--color-edge);border-radius:4px}
.tl-scroll::-webkit-scrollbar-thumb:hover{background:var(--color-ink3)}
.tl-scroll::-webkit-scrollbar-track{background:transparent}

/* Span rows expand in place: <details>/<summary>, no marker triangle. */
.tl-span-details>summary{list-style:none}
.tl-span-details>summary::-webkit-details-marker{display:none}
.tl-span-details[open]>summary{background:var(--color-paper)}

/* CSS-only radio tabs inside the expanded span panel. */
.tl-rtab{position:absolute;opacity:0;pointer-events:none;width:0;height:0}
.tl-pane{display:none;min-width:0}
.tl-rtab-msg:checked~.tl-pane-msg,
.tl-rtab-meta:checked~.tl-pane-meta,
.tl-rtab-raw:checked~.tl-pane-raw{display:block}
.tl-span-tab{font-family:var(--font-mono);font-size:10px;letter-spacing:.06em;text-transform:uppercase;
  padding:6px 10px;border-bottom:2px solid transparent;color:var(--color-ink3);cursor:pointer}
.tl-rtab-msg:checked~.tl-span-tabs .tl-tab-msg,
.tl-rtab-meta:checked~.tl-span-tabs .tl-tab-meta,
.tl-rtab-raw:checked~.tl-span-tabs .tl-tab-raw{color:var(--color-ink);border-bottom-color:var(--color-ink);font-weight:600}
/* Radios are visually hidden but keyboard-focusable — surface focus on the label. */
.tl-rtab-msg:focus-visible~.tl-span-tabs .tl-tab-msg,
.tl-rtab-meta:focus-visible~.tl-span-tabs .tl-tab-meta,
.tl-rtab-raw:focus-visible~.tl-span-tabs .tl-tab-raw{outline:2px solid var(--color-sky);outline-offset:-2px;border-radius:3px}
`;

/**
 * Placeholder for a non-pre-selected dossier. Shares the `.tl-detail-pane`
 * shell + `x-show="selected === key"` toggle with a real DetailPane, so the
 * rail's select state drives it identically. On the FIRST time this row is
 * selected, the Alpine `x-effect` fires a one-shot `dossier-load` event that
 * htmx listens for (`hx-trigger="dossier-load once"`); htmx then morph-swaps
 * the server-rendered DetailPane in its place. `morph` (alpine-morph ext,
 * already active for hx-boost) is required — the injected fragment carries
 * interactive controls (dismiss/ack chips + tab loaders) that `x-html` would
 * leave un-hydrated. After the swap the element is the real DetailPane (no
 * hx-* attrs) → never refetches, and re-selecting is an instant x-show flip.
 */
/** Swap the spinner for an honest refresh hint when a lazy dossier fetch fails. */
const DOSSIER_LOAD_FAIL_JS =
  "this.querySelector('[data-dossier-loading]').textContent = 'couldn’t load this turn — refresh the page to see it'";

function LazyDossier({ paneKey, url }: { paneKey: string; url: string }) {
  const sel = `selected === ${JSON.stringify(paneKey)}`;
  return (
    <div
      class="tl-detail-pane"
      data-turn-key={paneKey}
      data-dossier-lazy=""
      x-show={sel}
      x-cloak
      hx-get={url}
      hx-trigger="dossier-load once"
      hx-swap="morph"
      x-effect={`if (${sel}) $el.dispatchEvent(new Event('dossier-load'))`}
      // Honest failure: the `once` trigger is consumed regardless of outcome,
      // and there is no global htmx error UI — so on the rare miss (the row
      // aged out of even the 200-turn dossier window, or a transient error)
      // swap the spinner for a refresh hint instead of an infinite "loading…".
      // The two colons in `hx-on:htmx:<event>` are not writable as a bare JSX
      // attribute (JSX allows one namespace colon), so spread the htmx error
      // hooks in as string keys.
      {...{
        "hx-on:htmx:response-error": DOSSIER_LOAD_FAIL_JS,
        "hx-on:htmx:send-error": DOSSIER_LOAD_FAIL_JS,
      }}
      style={{ display: "flex", flexDirection: "column", gap: 14 }}
    >
      <div
        data-dossier-loading=""
        style={{ fontFamily: tokens.font.mono, fontSize: 11, color: tokens.color.ink3, padding: "8px 0" }}
      >
        loading…
      </div>
    </div>
  );
}

export function TimelineScreen({ telemetry, dossierQuery, reviewUnit, secret }: TimelineScreenProps) {
  const now = new Date();
  const firedRows = telemetry.recent.filter((c) => c.status === "fired");
  // Perf (Task 6 review carry-over): memoize proj_hash resolution by
  // cwd for the duration of THIS render — rows overwhelmingly share a
  // handful of cwds, so this collapses up to 200 sync fs walks (one per
  // row) down to one per DISTINCT cwd. Fresh Map per render (never hoisted
  // module-level — a stale cache across requests could serve a wrong hash
  // after `siltpoke relocate` changes a project's root).
  const resolveProjHash = makeProjHashResolver();
  // Pre-select the first fired row of the CURRENTLY-SORTED rail order
  // (newest under the default sort, oldest under ?sort=oldest) — the top
  // of the visible list is always the pre-opened dossier.
  const firstVisibleFired = firedRows[0];
  const initialKey = firstVisibleFired ? turnKey(firstVisibleFired) : "";
  const alpineState = `{ selected: ${JSON.stringify(initialKey)}, tab: "critic" }`;

  return (
    <Dashboard activeSection="timeline" navSections={CANONICAL_NAV}>
      {/* dangerouslySetInnerHTML (RepoGraph's pattern): a text child gets
          HTML-escaped by hono/jsx — quotes become &quot; INSIDE the style
          tag, which silently kills any url("data:…") declaration (the
          select chevron never rendered because of this). */}
      <style dangerouslySetInnerHTML={{ __html: TIMELINE_CSS }} />
      <div
        x-data={alpineState}
        style={{
          display: "flex",
          flexDirection: "column",
          gap: 12,
          padding: 16,
          height: "100%",
          boxSizing: "border-box",
          overflow: "hidden",
        }}
      >
        {/* Header — kicker + title + contextual summary */}
        <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          <div style={{ display: "flex", alignItems: "flex-end", justifyContent: "space-between", gap: 16, flexWrap: "wrap" }}>
            <div>
              <div
                style={{
                  fontFamily: tokens.font.mono,
                  fontSize: 10,
                  letterSpacing: "0.1em",
                  textTransform: "uppercase",
                  color: tokens.color.ink3,
                  marginBottom: 4,
                }}
              >
                siltpoke · observability
              </div>
              <h1
                style={{
                  margin: 0,
                  fontFamily: tokens.font.display,
                  fontSize: 32,
                  color: tokens.color.ink,
                  lineHeight: 1,
                }}
              >
                Timeline
              </h1>
            </div>
            <div
              class="tl-summary"
              style={{
                fontFamily: tokens.font.mono,
                fontSize: 11,
                color: tokens.color.ink2,
                textAlign: "right",
              }}
            >
              {summaryLine(telemetry)}
            </div>
          </div>
          {/* ONE compact filter row (design fixup 2026-07-02, 2nd smoke):
              [status seg][kind ▾][range ▾] … [search][project ▾]. Sort
              lives in the rail header, not here. */}
          <TimelineFilterRow telemetry={telemetry} />
          {/* ⏱ The setting that decides when this page gets rows at all —
              placed with the filters because it reads as one more control
              over what shows up, not as a settings page bolted on. */}
          <ReviewUnitRow secret={secret ?? ""} reviewUnit={reviewUnit} />
        </div>

        {/* Master rail + dossier */}
        <div
          style={{
            flex: 1,
            minHeight: 0,
            display: "flex",
            border: `1px solid ${tokens.color.edge}`,
            borderRadius: tokens.radius.md,
            background: tokens.color.cream,
            overflow: "hidden",
          }}
        >
          <TimelineRail telemetry={telemetry} now={now} />
          <div
            class="tl-dossier tl-scroll"
            style={{
              flex: 1,
              minWidth: 0,
              overflowY: "auto",
              padding: "18px 22px",
            }}
          >
            {firedRows.length === 0 ? (
              <EmptyDetail hasRows={telemetry.recent.length > 0} />
            ) : (
              firedRows.map((c) => {
                const key = turnKey(c);
                // Lazy mode (real /timeline render): only the pre-selected
                // dossier ships its full DetailPane; every other row is a
                // placeholder that morph-loads its DetailPane on first select
                // (then stays in the DOM → re-select is instant, no refetch).
                // This is what drops the page from ~1MB (20 eager dossiers) to
                // ~one dossier. When dossierQuery is undefined the screen was
                // built directly (tests / non-route callers) → keep the old
                // eager-all behavior.
                if (dossierQuery !== undefined && key !== initialKey) {
                  const url = `/api/timeline/dossier?key=${encodeURIComponent(key)}${dossierQuery ? `&${dossierQuery}` : ""}`;
                  return <LazyDossier key={key} paneKey={key} url={url} />;
                }
                return (
                  <DetailPane
                    key={key}
                    c={c}
                    now={now}
                    homeBasename={telemetry.homeBasename}
                    preferenceStats={telemetry.preferenceStats}
                    initial={key === initialKey}
                    projHash={resolveProjHash(c.cwd)}
                  />
                );
              })
            )}
          </div>
        </div>
      </div>
    </Dashboard>
  );
}
