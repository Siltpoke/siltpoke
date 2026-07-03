// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Copyright (c) 2026 Jiaqi Duan
/** @jsxImportSource hono/jsx */
/**
 * Critic screen — observability for Brain hook activity.
 *
 * Four panels:
 *   1. Gate diagnostic — top-down "why is critic silent right now?"
 *   2. Budget gauge — used %, soft/hard markers, token breakdown
 *   3. Skip-reason histogram — last N entries by reason
 *   4. Recent activity table — last N entries: timestamp / status / reason / cost
 */
import { Dashboard } from "../shells/Dashboard";
import { CANONICAL_NAV } from "../routes/nav";
import { tokens } from "../tokens/tokens";
import type {
  CriticTelemetry,
  CriticCall,
  CallStatus,
  SpeechKind,
  SortOrder,
  TimeRange,
} from "../../state/api";
import { BlockA, BlockC, BlockD, BlockE, redactPath } from "../primitives/CritiqueAuditBlocks";
import { filterHref, formatTimeAgo, STATUS_COLOR } from "./critic/helpers";
export { GateCheckList, BudgetGauge, SkipHistogram } from "./critic/panels";
import { DiffView, DiffSummaryView } from "./critic/diff";
export { DiffView } from "./critic/diff";
import { FilterBar, prettifyProject, StatusInlineStats, ActionStatsLine } from "./critic/filter-bar";
import { RecentTable } from "./critic/recent-table";

export interface CriticProps {
  telemetry: CriticTelemetry;
}

export function Critic({ telemetry }: CriticProps) {
  const now = new Date();
  return (
    <Dashboard activeSection="history" navSections={CANONICAL_NAV}>
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "1fr",
          gap: 16,
          padding: 16,
          height: "100%",
          boxSizing: "border-box",
          overflow: "hidden",
          gridTemplateRows: "auto 1fr",
          alignContent: "start",
        }}
      >
        {/* 1. Header + legend disclosure + filters */}
        <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          <div>
            <h1
              style={{
                margin: 0,
                fontFamily: tokens.font.display,
                fontSize: 32,
                color: tokens.color.ink,
                lineHeight: 1,
              }}
            >
              history
            </h1>
            <div
              style={{
                fontFamily: tokens.font.body,
                fontSize: 13,
                color: tokens.color.ink3,
                marginTop: 4,
                display: "flex",
                alignItems: "center",
                gap: 14,
                flexWrap: "wrap",
              }}
            >
              <span>
                why siltpoke is/isn't talking right now
                {telemetry.activeProject !== null && (
                  <> · filtered to <b>{prettifyProject(telemetry.activeProject, telemetry.homeBasename)}</b></>
                )}
              </span>
              <StatusInlineStats telemetry={telemetry} />
              <ActionStatsLine stats={telemetry.actionStats} />
            </div>
          </div>
          <FilterBar telemetry={telemetry} />
        </div>

        {/* 2. Recent activity (fills remaining vertical space) */}
        <RecentTable telemetry={telemetry} now={now} />
      </div>
    </Dashboard>
  );
}
