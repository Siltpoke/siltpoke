// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
// Copyright (c) 2026 Jiaqi Duan
/** @jsxImportSource hono/jsx */
/**
 * CritiquePermalink screen — /critique/:id
 *
 * Renders a single critique in full audit detail:
 *   - CritiqueAuditCard (all v2 fields with graceful degradation for v1)
 *   - TraceWaterfall (if linked traces exist)
 */
import { Dashboard } from "../shells/Dashboard";
import { CANONICAL_NAV } from "../routes/nav";
import { CritiqueAuditCard } from "../primitives/CritiqueAuditCard";
import { TraceWaterfall } from "../primitives/TraceWaterfall";
import { tokens } from "../tokens/tokens";
import type { BrainOutputV2 } from "../../brain/schema-v2";
import type { WaterfallSpan } from "../primitives/TraceWaterfall";

export interface CritiquePermalinkProps {
  critique: Partial<BrainOutputV2> & { id: string };
  spans: WaterfallSpan[];
  traceIds: string[];
}

export function CritiquePermalink({ critique, spans, traceIds }: CritiquePermalinkProps) {
  return (
    <Dashboard navSections={CANONICAL_NAV} activeSection="history">
      <div style={{ padding: 16, maxWidth: 860 }}>
        {/* Page header */}
        <div style={{ marginBottom: 16 }}>
          <span
            style={{
              fontFamily: tokens.font.mono,
              fontSize: 10,
              color: tokens.color.ink3,
              letterSpacing: "0.08em",
              textTransform: "uppercase",
              display: "block",
              marginBottom: 4,
            }}
          >
            REVIEW · audit trail
          </span>
          <h1
            style={{
              margin: "0 0 4px",
              fontFamily: tokens.font.display,
              fontSize: 28,
              fontWeight: 400,
              color: tokens.color.ink,
              lineHeight: 1,
            }}
          >
            {critique.id}
          </h1>
          {critique.bubble_short ? (
            <div
              style={{
                fontFamily: tokens.font.body,
                fontSize: 13,
                color: tokens.color.ink3,
              }}
            >
              {critique.bubble_short}
            </div>
          ) : null}
        </div>

        {/* Audit card */}
        <CritiqueAuditCard critique={critique} />

        {/* Trace waterfall (if linked traces exist) */}
        {spans.length > 0 ? (
          <div style={{ marginTop: 24 }}>
            <div
              style={{
                fontFamily: tokens.font.mono,
                fontSize: 10,
                color: tokens.color.ink3,
                letterSpacing: "0.08em",
                textTransform: "uppercase",
                marginBottom: 8,
              }}
            >
              Linked Traces ({traceIds.length})
            </div>
            <TraceWaterfall spans={spans} />
          </div>
        ) : null}
      </div>
    </Dashboard>
  );
}
