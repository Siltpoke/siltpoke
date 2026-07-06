// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
// Copyright (c) 2026 Jiaqi Duan
/** @jsxImportSource hono/jsx */
/**
 * Wave 1.5b — CritiqueInbox primitive.
 *
 * Displays a list of pending critiques with tag pills, file paths, and
 * a pending-count header badge. Capped at `max` rows (default 3).
 *
 * Each critique row delegates to CritiqueAuditCard, which
 * surfaces all v2 fields (intent / evidence / reasoning / suggested_fix).
 * Old Critique shape (tag/text/file/line) is mapped to a partial v2 shape so
 * the card degrades gracefully when v2 fields are absent.
 */
import { tokens } from "../tokens/tokens";
import { CritiqueAuditCard } from "./CritiqueAuditCard";

export type CritiqueTag = "bug" | "style" | "lint" | "design";

export interface Critique {
  id: string;
  tag: CritiqueTag;
  text: string;
  file: string;
  line: number;
  ts: string;
}

export interface CritiqueInboxProps {
  critiques: readonly Critique[];
  pendingCount: number;
  max?: number;
}

const TAG_COLORS: Record<CritiqueTag, { bg: string; color: string }> = {
  bug:    { bg: `${tokens.color.terra}22`,  color: tokens.color.terra },
  style:  { bg: `${tokens.color.amber}22`,  color: tokens.color.amber },
  lint:   { bg: `${tokens.color.sky}22`,    color: tokens.color.sky   },
  design: { bg: `${tokens.color.moss}22`,   color: tokens.color.moss  },
};

function _TagPill({ tag }: { tag: CritiqueTag }) {
  const { bg, color } = TAG_COLORS[tag];
  return (
    <span
      style={{
        fontFamily: tokens.font.mono,
        fontSize: 9,
        color,
        background: bg,
        border: `1px solid ${color}`,
        borderRadius: 3,
        padding: "0 4px",
        lineHeight: "14px",
        flexShrink: 0,
      }}
    >
      {tag}
    </span>
  );
}

export function CritiqueInbox(props: CritiqueInboxProps) {
  const { critiques, pendingCount, max = 4 } = props;
  const visible = critiques.slice(0, max);

  return (
    <div
      class="critique-inbox"
      style={{
        border: `1px solid ${tokens.color.edge}`,
        borderRadius: tokens.radius.sm,
        background: tokens.color.paper,
        padding: "10px 12px",
        display: "flex",
        flexDirection: "column",
        gap: 8,
      }}
    >
      {/* Header */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
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
          REVIEW INBOX
        </span>
        <span
          class="critique-inbox__pending"
          style={{
            fontFamily: tokens.font.mono,
            fontSize: 9,
            color: tokens.color.terra,
            background: `${tokens.color.terra}22`,
            border: `1px solid ${tokens.color.terra}`,
            borderRadius: 999,
            padding: "1px 6px",
            flexShrink: 0,
          }}
        >
          {pendingCount} pending
        </span>
      </div>

      {/* Critique rows — each rendered via CritiqueAuditCard (T11c).
          Old Critique shape (tag/text/file/line) maps to partial v2; the card
          shows the critique bubble text and evidence location, and omits
          sections that have no v2 data (intent, reasoning, etc.). */}
      {visible.length === 0 ? (
        <div
          class="critique-inbox__empty"
          style={{
            fontFamily: tokens.font.mono,
            fontSize: 11,
            color: tokens.color.ink3,
            textAlign: "center",
            padding: "8px 0",
          }}
        >
          no reviews yet
        </div>
      ) : (
        <div
          style={{
            display: "flex",
            flexDirection: "column",
            gap: 8,
            overflowY: "auto",
            maxHeight: 480,
          }}
        >
          {visible.map((critique) => {
            // Map v1 Critique shape to a partial BrainOutputV2 shape so the
            // CritiqueAuditCard can degrade gracefully. Provide one evidence
            // item with the file/line from the old shape.
            const v2Shape = {
              id: critique.id,
              bubble_short: critique.text,
              // Map tag → category (best-effort; "lint" has no direct v2 category)
              category: critique.tag === "bug"
                ? ("correctness" as const)
                : critique.tag === "style"
                  ? ("readability" as const)
                  : critique.tag === "design"
                    ? ("design" as const)
                    : undefined,
              evidence: [
                {
                  rule_id: critique.tag,
                  tier: 1 as const,
                  signal_source: "rubric-tier1" as const,
                  file: critique.file,
                  line: critique.line,
                  snippet: `${critique.file}:${critique.line}`,
                },
              ],
              web_sources: [] as [],
            };
            return (
              <div key={critique.id} class="critique-row" data-critique-id={critique.id}>
                <CritiqueAuditCard critique={v2Shape} />
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
