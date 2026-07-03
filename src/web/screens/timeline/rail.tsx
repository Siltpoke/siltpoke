// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Copyright (c) 2026 Jiaqi Duan
/** @jsxImportSource hono/jsx */
/**
 * Timeline master rail — the left critique/turn list of the merged
 * /timeline page.
 *
 * Rendering rules mirror /history's RecentTable:
 *   - consecutive recursion_guard skips collapse into one muted group row
 *     (reuses groupRecursionGuards);
 *   - fired rows are selectable (Alpine `selected` swap — no reload);
 *   - skipped rows render flat/non-selectable, same as /history.
 */

import type { CriticCall, CriticTelemetry, SortOrder } from "../../../state/api";
import { tokens } from "../../tokens/tokens";
import { prettifyProject } from "../critic/filter-bar";
import { type FilterState, filterHref, formatTimeAgo, STATUS_COLOR } from "../critic/helpers";
import { groupRecursionGuards } from "../critic/recent-table";
import { fmtCost, fmtTokens, rowTokens, turnKey } from "./format";

const KIND_COLOR: Record<string, string> = {
  critical: tokens.color.terra,
  warning: tokens.color.amber,
  comment: tokens.color.moss,
};

function RailGuardGroupRow({ count, timestamp, now }: { count: number; timestamp: string; now: Date }) {
  return (
    <div
      style={{
        borderBottom: `1px solid ${tokens.color.edge}`,
        padding: "6px 14px",
        display: "flex",
        alignItems: "center",
        gap: 8,
        opacity: 0.45,
        fontFamily: tokens.font.mono,
        fontSize: 10,
        color: tokens.color.ink3,
      }}
    >
      <span style={{ minWidth: 40 }}>{formatTimeAgo(timestamp, now)} ago</span>
      <span>{count}× recursion_guard skipped</span>
    </div>
  );
}

function KindDot({ speechKind }: { speechKind: string | null }) {
  const kindColor = (speechKind && KIND_COLOR[speechKind]) || tokens.color.ink3;
  return (
    <span
      role="img"
      aria-label={speechKind ? `kind: ${speechKind}` : "kind: unknown"}
      title={speechKind ?? ""}
      style={{
        width: 8,
        height: 8,
        borderRadius: "50%",
        background: kindColor,
        display: "inline-block",
        flexShrink: 0,
      }}
    />
  );
}

function UserActionChip({ action }: { action: CriticCall["user_action"] }) {
  if (!action) return null;
  return (
    <span
      style={{
        fontFamily: tokens.font.mono,
        fontSize: 8,
        textTransform: "uppercase",
        letterSpacing: "0.06em",
        padding: "1px 5px",
        borderRadius: tokens.radius.pill,
        background: action === "acked" ? tokens.color.moss : tokens.color.ink3,
        color: tokens.color.cream,
        flexShrink: 0,
      }}
    >
      {action === "acked" ? "✓ ack" : "✕ dismiss"}
    </span>
  );
}

function RailRowTopLine({ c, now, homeBasename, tagColor }: {
  c: CriticCall;
  now: Date;
  homeBasename: string | null;
  tagColor: string;
}) {
  const fired = c.status === "fired";
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 7, marginBottom: 4 }}>
      {fired && <KindDot speechKind={c.speech_kind} />}
      <span
        style={{
          fontFamily: tokens.font.mono,
          fontSize: 9,
          fontWeight: 600,
          color: tagColor,
          textTransform: "uppercase",
          flexShrink: 0,
        }}
      >
        {fired ? "FIRED" : "skip"}
      </span>
      <UserActionChip action={c.user_action} />
      <span
        style={{
          fontFamily: tokens.font.mono,
          fontSize: 9,
          color: tokens.color.ink3,
          overflow: "hidden",
          textOverflow: "ellipsis",
          whiteSpace: "nowrap",
          minWidth: 0,
        }}
      >
        {prettifyProject(c.project, homeBasename)}
      </span>
      <span
        style={{
          marginLeft: "auto",
          fontFamily: tokens.font.mono,
          fontSize: 9,
          color: tokens.color.ink3,
          flexShrink: 0,
        }}
      >
        {formatTimeAgo(c.timestamp, now)} ago
      </span>
    </div>
  );
}

function RailRowCostLine({ c }: { c: CriticCall }) {
  const tokTotal = rowTokens(c);
  return (
    <div
      style={{
        display: "flex",
        gap: 9,
        marginTop: 4,
        fontFamily: tokens.font.mono,
        fontSize: 9,
        color: tokens.color.ink3,
      }}
    >
      <span>{c.cost_usd !== null ? fmtCost(c.cost_usd) : "$—"}</span>
      <span>{tokTotal !== null ? `${fmtTokens(tokTotal)} tok` : "— tok"}</span>
      {c.duration_ms !== null && <span>{(c.duration_ms / 1000).toFixed(1)}s</span>}
    </div>
  );
}

function RailRow({ c, now, homeBasename }: {
  c: CriticCall;
  now: Date;
  homeBasename: string | null;
}) {
  const fired = c.status === "fired";
  const key = turnKey(c);
  const tag = fired ? "FIRED" : c.skip_reason ?? "unknown";
  const tagColor = STATUS_COLOR[tag] ?? tokens.color.ink3;
  const selectAttrs = fired
    ? {
        "x-on:click": `selected = ${JSON.stringify(key)}`,
        "x-bind:data-active": `selected === ${JSON.stringify(key)} ? "true" : "false"`,
      }
    : {};

  return (
    <div
      class={fired ? "tl-row" : undefined}
      data-turn-key={key}
      {...selectAttrs}
      style={{
        borderBottom: `1px solid ${tokens.color.edge}`,
        padding: "8px 14px",
        cursor: fired ? "pointer" : "default",
        opacity: c.user_action !== null ? 0.55 : 1,
      }}
    >
      <RailRowTopLine c={c} now={now} homeBasename={homeBasename} tagColor={tagColor} />
      <div
        style={{
          fontFamily: fired ? tokens.font.body : tokens.font.mono,
          fontSize: 11,
          lineHeight: 1.4,
          color: fired ? tokens.color.ink : tagColor,
          whiteSpace: "nowrap",
          overflow: "hidden",
          textOverflow: "ellipsis",
          textDecoration: c.user_action === "dismissed" ? "line-through" : "none",
        }}
      >
        {fired ? c.bubble_short ?? "(no bubble)" : c.skip_reason ?? "unknown reason"}
      </div>
      {fired && <RailRowCostLine c={c} />}
    </div>
  );
}

/**
 * Pager anchor: plain navigation carrying every active filter plus one
 * exclusive cursor — `before=<oldest page row>` pages older,
 * `after=<newest page row>` pages newer. Filter/sort hrefs deliberately
 * DROP both cursors: changing any filter resets to the first page.
 */
function pagerHref(active: FilterState, cursor: "before" | "after", ts: string): string {
  const base = filterHref(active, {}, "/timeline");
  const sep = base.includes("?") ? "&" : "?";
  return `${base}${sep}${cursor}=${encodeURIComponent(ts)}`;
}

const PAGER_ANCHOR_STYLE = {
  flex: 1,
  textAlign: "center",
  padding: "10px 14px",
  fontFamily: tokens.font.mono,
  fontSize: 10,
  letterSpacing: "0.08em",
  textTransform: "uppercase",
  color: tokens.color.ink3,
  textDecoration: "none",
} as const;

/**
 * Bidirectional rail pager: each anchor renders only when more
 * predicate-passing rows exist on that side, so cursor chains terminate
 * and never dead-end. Replaces the one-way Load-older control.
 */
function RailPager({ newerHref, olderHref, sort }: {
  newerHref: string | null;
  olderHref: string | null;
  sort: SortOrder;
}) {
  if (newerHref === null && olderHref === null) return null;
  // prev/next follow the list's reading direction, not calendar direction:
  // newest-first reads new→old, so `next` pages older; oldest-first reads
  // old→new, so `next` pages newer. Cursor classes (tl-load-older/newer)
  // stay tied to their calendar cursor so selectors and hrefs are stable.
  const prevHref = sort === "oldest" ? olderHref : newerHref;
  const prevClass = sort === "oldest" ? "tl-load-older" : "tl-load-newer";
  const nextHref = sort === "oldest" ? newerHref : olderHref;
  const nextClass = sort === "oldest" ? "tl-load-newer" : "tl-load-older";
  return (
    <div
      class="tl-pager"
      style={{
        display: "flex",
        borderBottom: `1px solid ${tokens.color.edge}`,
        background: tokens.color.cream,
      }}
    >
      {prevHref !== null && (
        <a class={prevClass} href={prevHref} style={PAGER_ANCHOR_STYLE}>
          ‹ prev
        </a>
      )}
      {nextHref !== null && (
        <a
          class={nextClass}
          href={nextHref}
          style={{
            ...PAGER_ANCHOR_STYLE,
            borderLeft: prevHref !== null ? `1px solid ${tokens.color.edge}` : "none",
          }}
        >
          next ›
        </a>
      )}
    </div>
  );
}

export function TimelineRail({ telemetry, now }: { telemetry: CriticTelemetry; now: Date }) {
  const rows = telemetry.recent;
  const grouped = groupRecursionGuards(rows);
  const active: FilterState = {
    project: telemetry.activeProject,
    status: telemetry.activeStatus,
    kind: telemetry.activeKind,
    range: telemetry.activeRange,
    sort: telemetry.activeSort,
    query: telemetry.activeQuery,
  };
  const sortHref = filterHref(
    active,
    { sort: telemetry.activeSort === "newest" ? "oldest" : "newest" },
    "/timeline",
  );
  const olderHref =
    telemetry.hasMore && telemetry.windowOldestTs !== null
      ? pagerHref(active, "before", telemetry.windowOldestTs)
      : null;
  const newerHref =
    telemetry.hasNewer && telemetry.windowNewestTs !== null
      ? pagerHref(active, "after", telemetry.windowNewestTs)
      : null;
  return (
    <div
      class="tl-rail"
      style={{
        width: 300,
        flexShrink: 0,
        borderRight: `1px solid ${tokens.color.edge}`,
        background: tokens.color.paper,
        display: "flex",
        flexDirection: "column",
        minHeight: 0,
      }}
    >
      <div
        style={{
          padding: "8px 14px",
          borderBottom: `1px solid ${tokens.color.edge}`,
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: 8,
          fontFamily: tokens.font.mono,
          fontSize: 9,
          letterSpacing: "0.08em",
          textTransform: "uppercase",
          color: tokens.color.ink3,
        }}
      >
        <span>turns · {rows.length}</span>
        {/* Sort toggle lives HERE, not in the filter row (design fixup,
            2nd smoke: rail header reads `TODAY · 9   ↓ newest first`).
            Label shows the CURRENT order; the href is the inverse. */}
        <a
          class="tl-rail-sort"
          data-sort={telemetry.activeSort}
          href={sortHref}
          style={{
            fontFamily: tokens.font.mono,
            fontSize: 9.5,
            color: tokens.color.ink3,
            textDecoration: "none",
            whiteSpace: "nowrap",
            flexShrink: 0,
            textTransform: "none",
            letterSpacing: 0,
          }}
        >
          {telemetry.activeSort === "newest" ? "↓ newest first" : "↑ oldest first"}
        </a>
      </div>
      <div class="tl-scroll" style={{ flex: 1, minHeight: 0, overflowY: "auto" }}>
        {rows.length === 0 ? (
          <div
            style={{
              fontFamily: tokens.font.mono,
              fontSize: 11,
              color: tokens.color.ink3,
              padding: "18px 14px",
            }}
          >
            no turns match
          </div>
        ) : (
          grouped.map((item) =>
            "kind" in item && item.kind === "recursion_guard_group" ? (
              <RailGuardGroupRow
                key={`rg-${item.timestamp}`}
                count={item.count}
                timestamp={item.timestamp}
                now={now}
              />
            ) : (
              <RailRow
                key={turnKey(item as CriticCall)}
                c={item as CriticCall}
                now={now}
                homeBasename={telemetry.homeBasename}
              />
            ),
          )
        )}
        <RailPager newerHref={newerHref} olderHref={olderHref} sort={telemetry.activeSort} />
      </div>
    </div>
  );
}
