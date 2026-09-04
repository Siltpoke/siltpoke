// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
// Copyright (c) 2026 Jiaqi Duan
/** @jsxImportSource hono/jsx */
/**
 * CritiqueAuditCard — audit-trail card for a v2 critique.
 *
 * Renders all three evidence tiers, reasoning, critique_for_claude,
 * suggested_fix, and web_sources. Gracefully degrades when v2 fields
 * (intent, evidence, web_sources, reasoning) are absent — shows "—" or
 * omits the section.
 */
import { tokens } from "../tokens/tokens";
import type { BrainOutputV2 } from "../../brain/schema-v2";
import { CritiqueFeedbackInput } from "./CritiqueFeedbackInput";

export interface CritiqueAuditCardProps {
  critique: Partial<BrainOutputV2> & { id: string };
  /** Optional handler for free-text feedback. When omitted the feedback slot is hidden. */
  onFeedback?: (critiqueId: string, text: string) => void;
}

const TIER_LABEL: Record<number, string> = {
  1: "Tier 1 · deterministic",
  2: "Tier 2 · heuristic AST",
  3: "Tier 3 · semantic Brain",
};

const SEVERITY_COLOR: Record<string, string> = {
  low:      tokens.color.moss,
  medium:   tokens.color.amber,
  high:     tokens.color.terra,
  critical: tokens.color.terra,
};

const CATEGORY_COLOR: Record<string, string> = {
  correctness:  tokens.color.terra,
  security:     tokens.color.terra,
  design:       tokens.color.sky,
  tests:        tokens.color.amber,
  readability:  tokens.color.moss,
  performance:  tokens.color.amber,
  consistency:  tokens.color.sky,
};

function Badge({ label, color }: { label: string; color: string }) {
  return (
    <span
      style={{
        fontFamily: tokens.font.mono,
        fontSize: 9,
        color,
        background: `color-mix(in srgb, ${color} 13%, transparent)`,
        border: `1px solid ${color}`,
        borderRadius: 3,
        padding: "1px 5px",
        lineHeight: "14px",
        flexShrink: 0,
      }}
    >
      {label}
    </span>
  );
}

function SectionHead({ label }: { label: string }) {
  return (
    <div
      style={{
        fontFamily: tokens.font.mono,
        fontSize: 9,
        color: tokens.color.ink3,
        letterSpacing: "0.08em",
        textTransform: "uppercase",
        fontWeight: 500,
        marginBottom: 4,
      }}
    >
      {label}
    </div>
  );
}

export function CritiqueAuditCard({ critique, onFeedback }: CritiqueAuditCardProps) {
  const {
    id,
    intent,
    evidence = [],
    web_sources = [],
    reasoning,
    category,
    severity,
    confidence,
    critique_for_claude,
    suggested_fix,
  } = critique;

  const severityColor = severity ? (SEVERITY_COLOR[severity] ?? tokens.color.ink3) : tokens.color.ink3;
  const categoryColor = category ? (CATEGORY_COLOR[category] ?? tokens.color.ink3) : tokens.color.ink3;

  // Group evidence by tier
  const byTier: Record<number, typeof evidence> = {};
  for (const item of evidence) {
    const t = item.tier;
    if (!byTier[t]) byTier[t] = [];
    byTier[t]?.push(item);
  }
  const tiers = Object.keys(byTier)
    .map(Number)
    .sort();

  return (
    <div
      class="critique-audit-card"
      data-critique-id={id}
      style={{
        border: `1px solid ${tokens.color.edge}`,
        borderRadius: tokens.radius.md,
        background: tokens.color.paper,
        padding: "12px 14px",
        display: "flex",
        flexDirection: "column",
        gap: 12,
      }}
    >
      {/* ── Header ── */}
      <div style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
        {intent ? (
          <Badge
            label={`${intent.classification} · ${Math.round(intent.confidence * 100)}%`}
            color={tokens.color.sky}
          />
        ) : null}
        {category ? <Badge label={category} color={categoryColor} /> : null}
        {severity ? <Badge label={severity} color={severityColor} /> : null}
        {confidence ? (
          <Badge label={`confidence: ${confidence}`} color={tokens.color.ink3} />
        ) : null}
        <span
          style={{
            marginLeft: "auto",
            fontFamily: tokens.font.mono,
            fontSize: 9,
            color: tokens.color.ink3,
          }}
        >
          {id}
        </span>
      </div>

      {/* ── Evidence ── */}
      {tiers.length > 0 ? (
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          <SectionHead label="Evidence" />
          {tiers.map((tier) => (
            <div key={tier}>
              <div
                class={`evidence-tier evidence-tier--${tier}`}
                style={{
                  fontFamily: tokens.font.mono,
                  fontSize: 9,
                  color: tokens.color.ink3,
                  marginBottom: 4,
                  letterSpacing: "0.06em",
                }}
              >
                {TIER_LABEL[tier] ?? `Tier ${tier}`}
              </div>
              {(byTier[tier] ?? []).map((item, idx) => (
                <div
                  key={`${tier}-${idx}`}
                  style={{
                    border: `1px solid ${tokens.color.edge}`,
                    borderRadius: tokens.radius.sm,
                    background: tokens.color.paperD,
                    padding: "5px 8px",
                    marginBottom: 4,
                    display: "flex",
                    flexDirection: "column",
                    gap: 2,
                  }}
                >
                  <div style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
                    <span
                      style={{
                        fontFamily: tokens.font.mono,
                        fontSize: 10,
                        color: tokens.color.ink,
                        fontWeight: 600,
                      }}
                    >
                      {item.rule_id}
                    </span>
                    <span
                      style={{
                        fontFamily: tokens.font.mono,
                        fontSize: 9,
                        color: tokens.color.ink3,
                      }}
                    >
                      {item.signal_source}
                    </span>
                    <span
                      style={{
                        fontFamily: tokens.font.mono,
                        fontSize: 9,
                        color: tokens.color.ink2,
                        marginLeft: "auto",
                      }}
                    >
                      {item.file}:{item.line}
                    </span>
                  </div>
                  {item.snippet ? (
                    <code
                      style={{
                        fontFamily: tokens.font.mono,
                        fontSize: 10,
                        color: tokens.color.ink2,
                        background: tokens.color.paper,
                        borderRadius: 2,
                        padding: "1px 4px",
                        whiteSpace: "pre",
                        overflow: "hidden",
                        textOverflow: "ellipsis",
                        display: "block",
                        maxWidth: "100%",
                      }}
                    >
                      {item.snippet.length > 80 ? `${item.snippet.slice(0, 80)}…` : item.snippet}
                    </code>
                  ) : null}
                </div>
              ))}
            </div>
          ))}
        </div>
      ) : null}

      {/* ── Bubble / summary text ── */}
      {critique.bubble_short && !reasoning ? (
        <p
          style={{
            fontFamily: tokens.font.body,
            fontSize: 12,
            color: tokens.color.ink2,
            margin: 0,
            lineHeight: 1.5,
          }}
        >
          {critique.bubble_short}
        </p>
      ) : null}

      {/* ── Reasoning ── */}
      {reasoning ? (
        <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
          <SectionHead label="Reasoning" />
          <p
            style={{
              fontFamily: tokens.font.body,
              fontSize: 12,
              color: tokens.color.ink2,
              margin: 0,
              lineHeight: 1.5,
            }}
          >
            {reasoning}
          </p>
        </div>
      ) : null}

      {/* ── Critique for Claude ── */}
      {critique_for_claude ? (
        <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
          <SectionHead label="Review for Claude" />
          <div
            style={{
              fontFamily: tokens.font.body,
              fontSize: 12,
              color: tokens.color.ink,
              background: `color-mix(in srgb, ${tokens.color.amber} 9%, transparent)`,
              border: `1px solid ${tokens.color.amber}`,
              borderRadius: tokens.radius.sm,
              padding: "6px 10px",
              lineHeight: 1.5,
            }}
          >
            {critique_for_claude}
          </div>
        </div>
      ) : null}

      {/* ── Suggested fix ── */}
      {suggested_fix ? (
        <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
          <SectionHead label="Suggested Fix" />
          <pre
            style={{
              fontFamily: tokens.font.mono,
              fontSize: 11,
              color: tokens.color.lcdInk,
              background: tokens.color.lcd,
              borderRadius: tokens.radius.sm,
              padding: "6px 10px",
              margin: 0,
              whiteSpace: "pre-wrap",
              wordBreak: "break-all",
            }}
          >
            {suggested_fix}
          </pre>
        </div>
      ) : null}

      {/* ── Web sources ── */}
      {web_sources.length > 0 ? (
        <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
          <SectionHead label="Web Sources" />
          <ul style={{ margin: 0, padding: 0, listStyle: "none", display: "flex", flexDirection: "column", gap: 3 }}>
            {web_sources.map((src, i) => (
              <li key={i}>
                <a
                  href={src.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  style={{
                    fontFamily: tokens.font.body,
                    fontSize: 11,
                    color: tokens.color.sky,
                    textDecoration: "none",
                  }}
                >
                  {src.title || src.url}
                </a>
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {/* ── Feedback slot (optional) ── */}
      {onFeedback ? (
        <CritiqueFeedbackInput critiqueId={id} onSubmit={onFeedback} />
      ) : null}
    </div>
  );
}
