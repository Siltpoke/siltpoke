// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Copyright (c) 2026 Jiaqi Duan
/** @jsxImportSource hono/jsx */
/**
 * RubricActivityPanel — compact card showing recent rubric activity.
 *
 * Data comes from FP calibration report (parsed table of per-rule trigger counts).
 * Shows: total rules, top 3 by trigger count, link to /rubric.
 */
import { tokens } from "../tokens/tokens";

export interface RubricSummary {
  totalRules: number;
  topByTriggers: Array<{ rule_id: string; count: number }>;
}

export interface RubricActivityPanelProps {
  rubricSummary: RubricSummary | null;
}

export function RubricActivityPanel({ rubricSummary }: RubricActivityPanelProps) {
  return (
    <div
      class="rubric-activity-panel"
      style={{
        border: `1px solid ${tokens.color.edge}`,
        borderRadius: tokens.radius.sm,
        background: tokens.color.paper,
        padding: "10px 12px",
        display: "flex",
        flexDirection: "column",
        gap: 6,
      }}
    >
      {/* Header */}
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
        }}
      >
        <span
          style={{
            fontFamily: tokens.font.mono,
            fontSize: 10,
            color: tokens.color.ink3,
            letterSpacing: "0.08em",
            textTransform: "uppercase",
            fontWeight: 500,
          }}
        >
          RUBRIC
        </span>
        <a
          href="/rubric"
          style={{
            fontFamily: tokens.font.mono,
            fontSize: 9,
            color: tokens.color.sky,
            textDecoration: "none",
          }}
        >
          view all →
        </a>
      </div>

      {rubricSummary === null ? (
        <div
          style={{
            fontFamily: tokens.font.mono,
            fontSize: 10,
            color: tokens.color.ink3,
          }}
        >
          no calibration data
        </div>
      ) : (
        <>
          {/* Total rules count */}
          <div
            style={{
              fontFamily: tokens.font.mono,
              fontSize: 10,
              color: tokens.color.ink3,
            }}
          >
            {rubricSummary.totalRules} rules loaded
          </div>

          {/* Top triggers */}
          <div
            style={{
              display: "flex",
              flexDirection: "column",
              gap: 3,
            }}
          >
            {rubricSummary.topByTriggers.slice(0, 3).map((rule) => (
              <div
                key={rule.rule_id}
                style={{
                  display: "flex",
                  justifyContent: "space-between",
                  fontFamily: tokens.font.mono,
                  fontSize: 10,
                }}
              >
                <span style={{ color: tokens.color.ink3 }}>{rule.rule_id}</span>
                <span style={{ color: tokens.color.ink2 }}>{rule.count}</span>
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  );
}
