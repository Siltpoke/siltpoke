// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
// Copyright (c) 2026 Jiaqi Duan
/** @jsxImportSource hono/jsx */
/**
 * Timeline detail pane — the right "dossier" of the merged /timeline page.
 *
 * One pane is server-rendered per FIRED turn; Alpine `selected` state shows
 * exactly one (row click swaps panes without a reload — same embed-hidden
 * pattern /history uses for row expansions). Diff bodies and trace data are
 * NOT embedded; both load on demand on first tab open (see ./detail-tabs
 * for the loader mechanism).
 *
 * All four tabs are live: Critic + Diff / Trace / Feedback.
 */

import type { CriticCall, CriticTelemetry } from "../../../state/api";
import { BlockA, BlockC, BlockD, BlockE, redactPath } from "../../primitives/CritiqueAuditBlocks";
import { tokens } from "../../tokens/tokens";
import { formatTimeAgo } from "../critic/helpers";
import { ChipBadge, RowActions, SpeechKindBadge } from "../critic/row-helpers";
import { Section } from "../critic/section";
import { DiffTab, FeedbackTab, TraceTab } from "./detail-tabs";
import { fmtCost, fmtTokens, rowTokens, turnKey } from "./format";

/**
 * Honesty-caveated label for Block A's agent-reply field: capture stores
 * only the reply's first paragraph, capped at 1200 chars — never the full
 * verbatim reply.
 */
export const AGENT_REPLY_LABEL = "agent reply (opening · first ¶, ≤1200 chars)";

export const TABS = [
  { id: "critic", label: "Code Review" },
  { id: "diff", label: "Diff" },
  { id: "trace", label: "Trace" },
  { id: "feedback", label: "Feedback" },
] as const;

function TabBar() {
  return (
    <div
      style={{
        display: "flex",
        gap: 2,
        borderBottom: `1px solid ${tokens.color.edge}`,
        flexWrap: "wrap",
      }}
    >
      {TABS.map((t) => (
        <button
          key={t.id}
          type="button"
          class="tl-tab"
          x-on:click={`tab = ${JSON.stringify(t.id)}`}
          x-bind:data-active={`tab === ${JSON.stringify(t.id)} ? "true" : "false"`}
          data-active={t.id === "critic" ? "true" : "false"}
        >
          {t.label}
        </button>
      ))}
    </div>
  );
}

function SaidBlock({ c }: { c: CriticCall }) {
  const said = c.bubble_long ?? c.bubble_short;
  if (!said) return null;
  return (
    <div
      style={{
        borderLeft: `3px solid ${tokens.color.edge}`,
        padding: "1px 0 1px 13px",
      }}
    >
      <div
        style={{
          fontFamily: tokens.font.mono,
          fontSize: 9,
          letterSpacing: "0.08em",
          textTransform: "uppercase",
          color: tokens.color.ink3,
          marginBottom: 4,
        }}
      >
        what siltpoke said{c.confidence ? ` · confidence ${c.confidence}` : ""}
      </div>
      <div
        style={{
          fontFamily: tokens.font.body,
          fontSize: 13,
          lineHeight: 1.55,
          color: tokens.color.ink,
          whiteSpace: "pre-wrap",
        }}
      >
        {said}
      </div>
    </div>
  );
}

function MetaStrip({ c }: { c: CriticCall }) {
  const tokTotal = rowTokens(c);
  return (
    <div
      style={{
        display: "flex",
        flexWrap: "wrap",
        gap: 12,
        fontFamily: tokens.font.mono,
        fontSize: 10,
        color: tokens.color.ink3,
        padding: "8px 0",
        borderTop: `1px solid ${tokens.color.edge}`,
        borderBottom: `1px solid ${tokens.color.edge}`,
      }}
    >
      <span>{c.cost_usd !== null ? fmtCost(c.cost_usd) : "cost —"}</span>
      <span>{tokTotal !== null ? `${fmtTokens(tokTotal)} tok` : "tok —"}</span>
      <span>{c.duration_ms !== null ? `${(c.duration_ms / 1000).toFixed(1)}s` : "lat —"}</span>
      <span>
        gate · {c.gating_decision ?? "—"} · turns {c.turns_included ?? "—"}
      </span>
    </div>
  );
}

function headlineFor(c: CriticCall): string {
  const q = c.v2?.user_raw_query;
  if (q) return q.length > 160 ? `${q.slice(0, 160)}…` : q;
  return c.bubble_short ?? "(no bubble)";
}

function DetailHeader({ c, now, homeBasename }: {
  c: CriticCall;
  now: Date;
  homeBasename: string | null;
}) {
  const headline = headlineFor(c);
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
      <div style={{ display: "flex", alignItems: "flex-start", gap: 10, flexWrap: "wrap" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap", minWidth: 0 }}>
          <SpeechKindBadge severity={c.severity} critiqueText={c.critique_for_claude} />
          {c.user_action && (
            <ChipBadge
              label={c.user_action}
              color={c.user_action === "acked" ? tokens.color.moss : tokens.color.ink3}
            />
          )}
          <span
            style={{
              fontFamily: tokens.font.mono,
              fontSize: 10,
              color: tokens.color.ink3,
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
            }}
            title={c.cwd ?? undefined}
          >
            {c.cwd ? redactPath(c.cwd, null) : prettyProjectFallback(c, homeBasename)}
            {c.critique_id ? ` · ${c.critique_id}` : ""} · {formatTimeAgo(c.timestamp, now)} ago
          </span>
        </div>
        <div style={{ marginLeft: "auto" }}>
          <RowActions call={c} />
        </div>
      </div>

      <h2
        style={{
          margin: 0,
          fontFamily: tokens.font.body,
          fontSize: 16,
          fontWeight: 600,
          lineHeight: 1.35,
          color: tokens.color.ink,
        }}
      >
        {headline}
      </h2>

      <SaidBlock c={c} />
      <MetaStrip c={c} />
    </div>
  );
}

function prettyProjectFallback(c: CriticCall, homeBasename: string | null): string {
  return homeBasename && c.project === homeBasename ? "home (~)" : c.project;
}

function CriticTab({ c, preferenceStats }: {
  c: CriticCall;
  preferenceStats: CriticTelemetry["preferenceStats"];
}) {
  return (
    <div x-show={'tab === "critic"'} style={{ display: "flex", flexDirection: "column", gap: 24 }}>
      {c.critique_for_claude && (
        <Section title="review · for claude">
          <div
            style={{
              fontFamily: tokens.font.body,
              fontSize: 12,
              color: tokens.color.ink,
              whiteSpace: "pre-wrap",
              lineHeight: 1.55,
            }}
          >
            {c.critique_for_claude}
          </div>
        </Section>
      )}

      {/* A — WHAT I READ (user raw query + agent reply w/ honesty caveat) */}
      <BlockA v2={c.v2} c={c} agentReplyLabel={AGENT_REPLY_LABEL} />

      {/* C — RUBRIC CHECKLIST */}
      <BlockC v2={c.v2} cwd={c.cwd} />

      {/* D — SIGNALS APPLIED */}
      <BlockD v2={c.v2} preferenceStats={preferenceStats} critiqueId={c.critique_id} />

      {/* E — VERDICT CHAIN (gate context lives here + the header strip) */}
      <BlockE v2={c.v2} c={c} />
    </div>
  );
}

export interface DetailPaneProps {
  c: CriticCall;
  now: Date;
  homeBasename: string | null;
  preferenceStats: CriticTelemetry["preferenceStats"];
  /**
   * True for the FIRST fired turn in the currently-sorted rail order
   * (newest under the default sort, oldest under ?sort=oldest): its pane
   * is server-rendered VISIBLE (no x-cloak) so the initial selection shows
   * before Alpine hydrates — server-render the initially-selected turn's
   * detail.
   */
  initial: boolean;
}

export function DetailPane({ c, now, homeBasename, preferenceStats, initial }: DetailPaneProps) {
  const key = turnKey(c);
  return (
    <div
      class="tl-detail-pane"
      data-turn-key={key}
      x-show={`selected === ${JSON.stringify(key)}`}
      {...(initial ? {} : { "x-cloak": "" })}
      style={{ display: "flex", flexDirection: "column", gap: 14 }}
    >
      <DetailHeader c={c} now={now} homeBasename={homeBasename} />
      <TabBar />
      <CriticTab c={c} preferenceStats={preferenceStats} />
      <DiffTab c={c} />
      <TraceTab c={c} />
      <FeedbackTab c={c} />
    </div>
  );
}

/** Rendered when the current filter yields no selectable (fired) turn. */
export function EmptyDetail({ hasRows }: { hasRows: boolean }) {
  return (
    <div
      style={{
        fontFamily: tokens.font.body,
        fontSize: 12,
        fontStyle: "italic",
        color: tokens.color.ink3,
        padding: "24px 4px",
        lineHeight: 1.6,
      }}
    >
      {hasRows
        ? "no fired turn in this window — skipped turns carry no review record to inspect. Flip the status filter to “fired” or “all” to find one."
        : "nothing here yet — no brain-call entries match the active filter."}
    </div>
  );
}
