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

import type { CriticTelemetry } from "../../state/api";
import { CANONICAL_NAV } from "../routes/nav";
import { Dashboard } from "../shells/Dashboard";
import { tokens } from "../tokens/tokens";
import { DetailPane, EmptyDetail } from "./timeline/detail-pane";
import { TimelineFilterRow } from "./timeline/filter-row";
import { fmtCost, fmtTokens, turnKey } from "./timeline/format";
import { TimelineRail } from "./timeline/rail";

export interface TimelineScreenProps {
  telemetry: CriticTelemetry;
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
  border:1px solid #e2d6bb!important;border-radius:8px!important;
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
.tl-filter-row select:hover{border-color:#cbb98e!important;background-color:#f4eedf!important}

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

export function TimelineScreen({ telemetry }: TimelineScreenProps) {
  const now = new Date();
  const firedRows = telemetry.recent.filter((c) => c.status === "fired");
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
              firedRows.map((c) => (
                <DetailPane
                  key={turnKey(c)}
                  c={c}
                  now={now}
                  homeBasename={telemetry.homeBasename}
                  preferenceStats={telemetry.preferenceStats}
                  initial={turnKey(c) === initialKey}
                />
              ))
            )}
          </div>
        </div>
      </div>
    </Dashboard>
  );
}
