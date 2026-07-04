// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
// Copyright (c) 2026 Jiaqi Duan
/** @jsxImportSource hono/jsx */
/**
 * /timeline compact filter row.
 *
 * The row is ONE compact line that fits real viewports:
 *
 *   [status segmented] [kind segmented] [range segmented] … [search] [projects ▾]
 *
 * The old shared chip block (~920px of kind/range/sort chip groups) forced
 * the search/project group to wrap; SORT left the row entirely — it lives
 * in the rail header (rail.tsx). KIND and RANGE were briefly <select>
 * dropdowns, then flattened into status-style segments (with sort gone and
 * the flat-item paddings, all three segments fit on one line — no hidden
 * options behind a dropdown). The flat items are ~half the width of the
 * old bordered chips, which is what makes this fit where the chip block
 * didn't.
 *
 * /history's Critic screen keeps the original FilterBar untouched; this row
 * REUSES its shared pieces (ProjectSelect / filterHref) rather than forking
 * them.
 *
 * Visual parity — exact values from the reference design companion (its
 * `fpill` / `dSelPill` / `.fsel` styles):
 *   - status = ONE bordered container (1px #e2d6bb, radius 8, pad 2) with
 *     FLAT text items (active = solid ink block #1f1b16 / cream #f7f2e4
 *     text, radius 6, pad 4px 11px; inactive = plain muted text, no border)
 *     — SegItem below, not the shared bordered FilterChip.
 *   - 4th status facet: errors (brain-failure rows — see
 *     critic-event-log-parse.ts brain_error branch).
 *   - selects scale to pad 5px 10px / radius 8 / weight 600 + a chevron
 *     via TIMELINE_CSS `.tl-filter-row select`.
 *   - search input 190px, pad 6px 30px 6px 10px, fontSize 12, with an
 *     inline decorative magnifier SVG (reference's approach).
 */

import type { CriticTelemetry } from "../../../state/api";
import { tokens } from "../../tokens/tokens";
import { ProjectSelect } from "../critic/filter-bar";
import { type FilterState, filterHref } from "../critic/helpers";

/**
 * Reference-exact values with no token equivalent (ground truth: the
 * decoded design companion). Kept local — the timeline filter row is the
 * only surface on this design revision so far.
 */
const SEG_EDGE = "#e2d6bb"; // container/select border (lighter than tokens.color.edge)
const SEG_ACTIVE_TEXT = "#f7f2e4"; // cream text on the active ink block

const BASE_PATH = "/timeline";

/**
 * One flat label inside a filter segment. Reference `fpill`: active =
 * solid ink rounded-rect with cream text + weight 600; inactive = plain
 * muted text — NO per-item border or background. Keeps FilterChip's
 * data-group/data-key/data-active contract so tests + selectors carry over.
 */
function SegItem({ group, label, active, href, dataKey }: {
  group: "status" | "kind" | "range";
  label: string;
  active: boolean;
  href: string;
  dataKey: string;
}) {
  return (
    <a
      class="tl-seg-item"
      data-group={group}
      data-key={dataKey}
      data-active={active ? "true" : "false"}
      href={href}
      style={{
        fontFamily: tokens.font.mono,
        fontSize: 11,
        fontWeight: active ? 600 : 400,
        color: active ? SEG_ACTIVE_TEXT : tokens.color.ink3,
        background: active ? tokens.color.ink : "transparent",
        border: "none",
        borderRadius: 6,
        padding: "4px 11px",
        textDecoration: "none",
        cursor: "pointer",
        whiteSpace: "nowrap",
        flexShrink: 0,
      }}
    >
      {label}
    </a>
  );
}

/**
 * One bordered segment container of flat SegItems — the status segment's
 * exact box (border SEG_EDGE, radius 8, pad 2, gap 4), reused for kind and
 * range (dropdowns flattened, every option visible). Items navigate via
 * filterHref, which preserves all other active filters.
 */
function FilterSeg({ group, items }: {
  group: "status" | "kind" | "range";
  items: Array<{ label: string; active: boolean; href: string; dataKey: string }>;
}) {
  return (
    <div
      class={group === "status" ? "tl-status-seg" : "tl-filter-seg"}
      data-filter={group}
      style={{
        display: "flex",
        alignItems: "center",
        gap: 4,
        border: `1px solid ${SEG_EDGE}`,
        borderRadius: tokens.radius.md,
        padding: 2,
        background: tokens.color.cream,
        flexShrink: 0,
      }}
    >
      {items.map((it) => (
        <SegItem key={it.dataKey} group={group} {...it} />
      ))}
    </div>
  );
}

/** Right-aligned inline search (GET form, preserves the other filters). */
function SearchForm({ telemetry }: { telemetry: CriticTelemetry }) {
  const { activeStatus, activeKind, activeRange, activeSort, activeProject, activeQuery } =
    telemetry;
  return (
    <form
      method="get"
      action={BASE_PATH}
      // margin: 0 kills the global `form { margin-bottom: 16px }` — flex
      // centers the MARGIN box, so the inherited margin pushed the search
      // input ~8px above its siblings.
      // position: relative anchors the absolute magnifier SVG to the input's
      // box (the hidden inputs don't render, so form box == input box).
      style={{ display: "flex", alignItems: "center", gap: 6, margin: 0, position: "relative" }}
    >
      {/* status is server-defaulted to "fired" when omitted — emit an
          explicit "all" so submitting a search doesn't silently reset an
          explicit all/skipped choice (same semantics as filterHref). */}
      <input type="hidden" name="status" value={activeStatus ?? "all"} />
      {activeKind && <input type="hidden" name="kind" value={activeKind} />}
      {activeRange !== "all" && <input type="hidden" name="range" value={activeRange} />}
      {activeSort !== "newest" && <input type="hidden" name="sort" value={activeSort} />}
      {activeProject && <input type="hidden" name="project" value={activeProject} />}
      <input
        type="search"
        name="q"
        placeholder="search…"
        value={activeQuery ?? ""}
        aria-label="search turns"
        // Reference-exact box: 190px wide, 12px Geist, 30px right pad
        // clears the inline magnifier icon. height 28 = the segments'
        // measured height (one shared control height, 4th round); row
        // alignment via the parent's align-items:center + margin:0 above.
        style={{
          fontFamily: tokens.font.body,
          fontSize: 12,
          height: 28,
          padding: "0 30px 0 10px",
          borderRadius: tokens.radius.md,
          border: `1px solid ${SEG_EDGE}`,
          background: tokens.color.cream,
          color: tokens.color.ink,
          width: 190,
          outline: "none",
          boxSizing: "border-box",
        }}
      />
      {/* Decorative magnifier, right-aligned inside the input (reference
          uses this exact inline SVG). pointer-events:none so clicks land
          on the input. */}
      <svg
        width="13"
        height="13"
        viewBox="0 0 24 24"
        fill="none"
        aria-hidden="true"
        style={{ position: "absolute", right: 10, pointerEvents: "none" }}
      >
        <circle cx="11" cy="11" r="7" stroke="#a89878" stroke-width="2" />
        <line x1="16.2" y1="16.2" x2="21" y2="21" stroke="#a89878" stroke-width="2" stroke-linecap="round" />
      </svg>
    </form>
  );
}

export function TimelineFilterRow({ telemetry }: { telemetry: CriticTelemetry }) {
  const { projects, activeProject, activeStatus, activeKind, activeRange, activeSort, activeQuery, homeBasename } =
    telemetry;
  const active: FilterState = {
    project: activeProject,
    status: activeStatus,
    kind: activeKind,
    range: activeRange,
    sort: activeSort,
    query: activeQuery,
  };
  const href = (patch: Partial<FilterState>) => filterHref(active, patch, BASE_PATH);

  return (
    <div
      class="critic-filter-bar tl-filter-row"
      style={{
        display: "flex",
        alignItems: "center",
        gap: 8,
        flexWrap: "wrap",
        marginTop: 4,
      }}
    >
      {/* Status segment — ONE bordered container, flat text items inside
          (reference: border #e2d6bb, radius 8, pad 2, gap 4). "errors" =
          brain-failure rows (handle-stop catch-path error_message lines,
          parsed as skip_reason=brain_error). */}
      <FilterSeg
        group="status"
        items={[
          { label: "all", active: activeStatus === null, href: href({ status: null }), dataKey: "all" },
          { label: "fired", active: activeStatus === "fired", href: href({ status: "fired" }), dataKey: "fired" },
          { label: "skipped", active: activeStatus === "skipped", href: href({ status: "skipped" }), dataKey: "skipped" },
          { label: "errors", active: activeStatus === "errors", href: href({ status: "errors" }), dataKey: "errors" },
        ]}
      />
      {/* Kind + range — same flat segments, every option visible instead of
          hidden behind a dropdown. */}
      <FilterSeg
        group="kind"
        items={[
          { label: "all kinds", active: activeKind === null, href: href({ kind: null }), dataKey: "all" },
          { label: "comment", active: activeKind === "comment", href: href({ kind: "comment" }), dataKey: "comment" },
          { label: "warning", active: activeKind === "warning", href: href({ kind: "warning" }), dataKey: "warning" },
          { label: "critical", active: activeKind === "critical", href: href({ kind: "critical" }), dataKey: "critical" },
        ]}
      />
      <FilterSeg
        group="range"
        items={[
          { label: "today", active: activeRange === "today", href: href({ range: "today" }), dataKey: "today" },
          { label: "7d", active: activeRange === "7d", href: href({ range: "7d" }), dataKey: "7d" },
          { label: "30d", active: activeRange === "30d", href: href({ range: "30d" }), dataKey: "30d" },
          { label: "all time", active: activeRange === "all", href: href({ range: "all" }), dataKey: "all" },
        ]}
      />
      {/* Spacer … then search + project, right-aligned as one group. */}
      <div
        class="critic-filter-trailing"
        style={{ marginLeft: "auto", display: "flex", alignItems: "center", gap: 8 }}
      >
        <SearchForm telemetry={telemetry} />
        {projects.length > 0 && (
          <ProjectSelect
            projects={projects}
            activeProject={activeProject}
            activeStatus={activeStatus}
            activeKind={activeKind}
            activeRange={activeRange}
            activeSort={activeSort}
            activeQuery={activeQuery}
            homeBasename={homeBasename}
            basePath={BASE_PATH}
          />
        )}
      </div>
    </div>
  );
}
