// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Copyright (c) 2026 Jiaqi Duan
/** @jsxImportSource hono/jsx */
/**
 * Critic screen filter bar — the row above the activity table that holds
 * the status / kind / range filters + project picker + inline stats.
 *
 * Extracted from src/web/screens/Critic.tsx.
 */

import type { CriticTelemetry, SortOrder, SpeechKind, StatusFilter, TimeRange, UserActionStats } from "../../../state/api";
import { tokens } from "../../tokens/tokens";
import { type FilterState, filterHref } from "./helpers";

export function prettifyProject(key: string, homeBasename: string | null): string {
  if (homeBasename && key === homeBasename) return "home (~)";
  return key;
}

/** Exported for reuse by the /timeline compact filter row (design fixup). */
export function FilterChip({ label, active, href, dataKey, dataGroup }: {
  label: string;
  active: boolean;
  href: string;
  dataKey: string;
  dataGroup: string;
}) {
  return (
    <a
      class="critic-filter-chip"
      data-group={dataGroup}
      data-key={dataKey}
      data-active={active ? "true" : "false"}
      href={href}
      style={{
        fontFamily: tokens.font.mono,
        fontSize: 11,
        padding: "3px 10px",
        borderRadius: tokens.radius.pill,
        textDecoration: "none",
        cursor: "pointer",
        background: active ? tokens.color.ink : tokens.color.cream,
        color: active ? tokens.color.cream : tokens.color.ink2,
        border: `1px solid ${active ? tokens.color.ink : tokens.color.edge}`,
        whiteSpace: "nowrap",
        flexShrink: 0,
      }}
    >
      {label}
    </a>
  );
}

function FilterGroup({
  label,
  children,
}: {
  label: string;
  children: import("hono/jsx").Child;
}) {
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: 8,
      }}
    >
      <span
        style={{
          fontFamily: tokens.font.mono,
          fontSize: 10,
          letterSpacing: "0.08em",
          textTransform: "uppercase",
          color: tokens.color.ink3,
          flexShrink: 0,
        }}
      >
        {label}
      </span>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 6,
          flexWrap: "wrap",
        }}
      >
        {children}
      </div>
    </div>
  );
}

/**
 * `basePath` — page the filter chips link back to. Omitted → the original
 * /history behavior (chips → /history, project select → /critic which
 * redirects). The merged /timeline page passes "/timeline" so the same bar
 * drives both surfaces.
 *
 * `trailing` — optional right-aligned slot INSIDE the filter row, rendered
 * just before the project select (design: chips … [search][project] on ONE
 * row). /timeline passes its SearchForm here; /history passes nothing.
 */
export function FilterBar({ telemetry, basePath, trailing }: {
  telemetry: CriticTelemetry;
  basePath?: string;
  trailing?: import("hono/jsx").Child;
}) {
  const { projects, activeProject, activeStatus, activeKind, activeRange, activeSort, activeQuery, homeBasename } = telemetry;
  const active = {
    project: activeProject,
    status: activeStatus,
    kind: activeKind,
    range: activeRange,
    sort: activeSort,
    query: activeQuery,
  };
  const href = (patch: Partial<FilterState>) => filterHref(active, patch, basePath);

  return (
    <div
      class="critic-filter-bar"
      style={{
        display: "flex",
        flexDirection: "column",
        gap: 8,
        marginTop: 4,
      }}
    >
      <div style={{ display: "flex", gap: 16, flexWrap: "wrap", alignItems: "center" }}>
        <FilterGroup label="status">
          <FilterChip label="all" active={activeStatus === null} href={href({ status: null })} dataKey="all" dataGroup="status" />
          <FilterChip label="fired" active={activeStatus === "fired"} href={href({ status: "fired" })} dataKey="fired" dataGroup="status" />
          <FilterChip label="skipped" active={activeStatus === "skipped"} href={href({ status: "skipped" })} dataKey="skipped" dataGroup="status" />
        </FilterGroup>
        <FilterGroup label="kind">
          <FilterChip label="all" active={activeKind === null} href={href({ kind: null })} dataKey="all" dataGroup="kind" />
          <FilterChip label="comment" active={activeKind === "comment"} href={href({ kind: "comment" })} dataKey="comment" dataGroup="kind" />
          <FilterChip label="warning" active={activeKind === "warning"} href={href({ kind: "warning" })} dataKey="warning" dataGroup="kind" />
          <FilterChip label="critical" active={activeKind === "critical"} href={href({ kind: "critical" })} dataKey="critical" dataGroup="kind" />
        </FilterGroup>
        <FilterGroup label="range">
          <FilterChip label="today" active={activeRange === "today"} href={href({ range: "today" })} dataKey="today" dataGroup="range" />
          <FilterChip label="7d" active={activeRange === "7d"} href={href({ range: "7d" })} dataKey="7d" dataGroup="range" />
          <FilterChip label="30d" active={activeRange === "30d"} href={href({ range: "30d" })} dataKey="30d" dataGroup="range" />
          <FilterChip label="all" active={activeRange === "all"} href={href({ range: "all" })} dataKey="all" dataGroup="range" />
        </FilterGroup>
        <FilterGroup label="sort">
          {/* Single toggle — clicking flips to the opposite order.
              Label shows the CURRENT state so it reads as a status, not a
              command; the href is the inverse so click swaps. */}
          <FilterChip
            label={activeSort === "newest" ? "newest first" : "oldest first"}
            active
            href={href({ sort: activeSort === "newest" ? "oldest" : "newest" })}
            dataKey={activeSort}
            dataGroup="sort"
          />
        </FilterGroup>
        {trailing && (
          <div
            class="critic-filter-trailing"
            style={{ marginLeft: "auto", display: "flex", alignItems: "center", gap: 8 }}
          >
            {trailing}
          </div>
        )}
        {projects.length > 0 && (
          <FilterGroup label="project">
            <ProjectSelect
              projects={projects}
              activeProject={activeProject}
              activeStatus={activeStatus}
              activeKind={activeKind}
              activeRange={activeRange}
              activeSort={activeSort}
              activeQuery={activeQuery}
              homeBasename={homeBasename}
              basePath={basePath}
            />
          </FilterGroup>
        )}
      </div>
    </div>
  );
}

/** Exported for reuse by the /timeline compact filter row (design fixup). */
export function ProjectSelect({
  projects,
  activeProject,
  activeStatus,
  activeKind,
  activeRange,
  activeSort,
  activeQuery = null,
  homeBasename,
  basePath,
}: {
  projects: string[];
  activeProject: string | null;
  activeStatus: StatusFilter | null;
  activeKind: SpeechKind | null;
  activeRange: TimeRange;
  activeSort: SortOrder;
  activeQuery?: string | null;
  homeBasename: string | null;
  /** Omitted → legacy "/critic" target (redirects to /history). */
  basePath?: string;
}) {
  const baseParams = new URLSearchParams();
  if (activeStatus) baseParams.set("status", activeStatus);
  if (activeKind) baseParams.set("kind", activeKind);
  if (activeRange !== "all") baseParams.set("range", activeRange);
  if (activeSort !== "newest") baseParams.set("sort", activeSort);
  if (activeQuery) baseParams.set("q", activeQuery);
  // On change: rebuild url with chosen project + keep other filters.
  const handler =
    `const v=event.target.value;const u=new URL(${JSON.stringify(basePath ?? "/critic")},location.origin);` +
    Array.from(baseParams.entries())
      // JSON.stringify both sides so a query value containing quotes cannot
      // break out of the inline handler string.
      .map(([k, val]) => `u.searchParams.set(${JSON.stringify(k)},${JSON.stringify(val)});`)
      .join("") +
    `if(v)u.searchParams.set('project',v);location.href=u.toString();`;
  // Ensure the active project is in the option list even if it's not
  // currently in the recent-window's distinct project set (e.g. filtered
  // by today/kind with no matching rows). Otherwise the dropdown would
  // fall back to the first option even though SSR sets `selected`.
  const optionProjects = activeProject && !projects.includes(activeProject)
    ? [activeProject, ...projects]
    : projects;
  return (
    <select
      class="critic-project-select"
      aria-label="filter by project"
      autocomplete="off"
      x-on:change={handler}
      x-init={`$el.value = ${JSON.stringify(activeProject ?? "")}`}
      style={{
        fontFamily: tokens.font.mono,
        fontSize: 11,
        padding: "3px 10px",
        borderRadius: tokens.radius.pill,
        border: `1px solid ${tokens.color.edge}`,
        background: tokens.color.cream,
        color: tokens.color.ink,
        cursor: "pointer",
        maxWidth: 220,
      }}
    >
      <option value="" selected={activeProject === null}>all projects</option>
      {optionProjects.map((p) => (
        <option key={p} value={p} selected={p === activeProject}>
          {prettifyProject(p, homeBasename)}
        </option>
      ))}
    </select>
  );
}

export function StatusInlineStats({ telemetry }: { telemetry: CriticTelemetry }) {
  const { gateState, budget } = telemetry;
  const gateLabel = gateState.blocking ? `gates: ${gateState.blocking}` : "all gates open";
  const gateColor = gateState.blocking ? tokens.color.terra : tokens.color.moss;
  const stageColor =
    budget.stage === "hard"
      ? tokens.color.terra
      : budget.stage === "soft"
        ? tokens.color.amber
        : tokens.color.moss;
  const dot = (color: string) => (
    <span style={{ width: 8, height: 8, borderRadius: "50%", background: color, display: "inline-block" }} />
  );
  const sep = <span style={{ color: tokens.color.ink3 }}>·</span>;
  return (
    <span
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 10,
        fontFamily: tokens.font.mono,
        fontSize: 11,
        color: tokens.color.ink2,
        flexWrap: "wrap",
      }}
    >
      <span style={{ display: "inline-flex", alignItems: "center", gap: 5, color: gateColor }}>
        {dot(gateColor)} {gateLabel}
      </span>
      {sep}
      <span style={{ display: "inline-flex", alignItems: "center", gap: 5 }}>
        {dot(stageColor)} budget {budget.stage} · {budget.used_pct.toFixed(1)}% used
      </span>
      {budget.rollup && (
        <>
          {sep}
          <span>{budget.rollup.brain_calls} brain calls · ${budget.rollup.total_cost_usd.toFixed(4)}</span>
        </>
      )}
    </span>
  );
}

export function ActionStatsLine({ stats }: { stats: UserActionStats }) {
  if (stats.total_fired === 0) return null;
  const pillStyle = (color: string) => ({
    fontFamily: tokens.font.mono,
    fontSize: 10,
    padding: "2px 8px",
    borderRadius: tokens.radius.pill,
    background: tokens.color.cream,
    border: `1px solid ${tokens.color.edge}`,
    color,
    display: "inline-flex",
    alignItems: "center",
    gap: 5,
  });
  const dot = (color: string) => (
    <span style={{ width: 6, height: 6, borderRadius: "50%", background: color, display: "inline-block" }} />
  );
  return (
    <span style={{ display: "flex", alignItems: "center", gap: 6, fontFamily: tokens.font.mono, fontSize: 10 }}>
      <span style={pillStyle(tokens.color.moss)}>{dot(tokens.color.moss)} {stats.acked} acked</span>
      <span style={pillStyle(tokens.color.terra)}>{dot(tokens.color.terra)} {stats.dismissed} dismissed</span>
      <span style={pillStyle(tokens.color.ink3)}>{stats.untouched_fired} untouched / {stats.total_fired} fired</span>
    </span>
  );
}

function _Legend() {
  const row = (color: string, label: string, body: string) => (
    <div style={{ display: "grid", gridTemplateColumns: "14px 90px 1fr", gap: 8, alignItems: "baseline" }}>
      <span style={{ width: 10, height: 10, borderRadius: "50%", background: color, display: "inline-block", marginTop: 4 }} />
      <span style={{ fontFamily: tokens.font.mono, fontSize: 11, color: tokens.color.ink, fontWeight: 600 }}>{label}</span>
      <span style={{ fontFamily: tokens.font.body, fontSize: 12, color: tokens.color.ink2, lineHeight: 1.5 }}>{body}</span>
    </div>
  );
  return (
    <div x-data="{open:false}" style={{ display: "flex", flexDirection: "column", gap: 6 }}>
      <button
        type="button"
        x-on:click="open=!open"
        style={{
          alignSelf: "flex-start",
          fontFamily: tokens.font.mono,
          fontSize: 10,
          textTransform: "uppercase",
          letterSpacing: "0.08em",
          color: tokens.color.ink3,
          background: "transparent",
          border: "none",
          padding: 0,
          cursor: "pointer",
          textDecoration: "underline dotted",
        }}
        x-text="open ? 'legend · hide' : 'legend · what do these colors mean?'"
      >
        legend · what do these colors mean?
      </button>
      <div
        x-show="open"
        x-cloak
        style={{
          border: `1px solid ${tokens.color.edge}`,
          borderRadius: tokens.radius.sm,
          background: tokens.color.paper,
          padding: 12,
          display: "flex",
          flexDirection: "column",
          gap: 10,
        }}
      >
        <div style={{ fontFamily: tokens.font.mono, fontSize: 10, color: tokens.color.ink3, textTransform: "uppercase", letterSpacing: "0.08em" }}>
          speech kind · /critic row dot
        </div>
        {row(tokens.color.moss, "comment", "Narrative chit-chat. severity=info, no actionable critique. Most fires land here by design.")}
        {row(tokens.color.amber, "warning", "Real concern. severity=low or medium, OR has critique_for_claude text.")}
        {row(tokens.color.terra, "critical", "Must-fix. severity=high. Rare — Brain only escalates with file:line evidence.")}
        <div style={{ fontFamily: tokens.font.mono, fontSize: 10, color: tokens.color.ink3, textTransform: "uppercase", letterSpacing: "0.08em", marginTop: 4 }}>
          terminal statusline · pet bubble color
        </div>
        {row("#ff6464", "high", "Red. Bubble for severity=high fires only.")}
        {row("#dcc864", "medium", "Yellow. Bubble for severity=medium fires.")}
        {row("#64c8ff", "low", "Cyan. Bubble for severity=low fires.")}
        {row("#969696", "info", "Gray (default). Narrative fires. Brain prompt forces severity=info unless there's citable file:line evidence — so most statusline bubbles are gray. Not a bug.")}
        <div style={{ fontFamily: tokens.font.body, fontSize: 11, color: tokens.color.ink3, lineHeight: 1.5, marginTop: 4 }}>
          Reference: <code>src/brain/system-prompt.md:45-46</code> (severity rules) ·
          <code> src/face/wrapper.ts</code> (color map) ·
          <code> src/state/critic-event-log.ts</code> (speech-kind classifier).
        </div>
      </div>
    </div>
  );
}

