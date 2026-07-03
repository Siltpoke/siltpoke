// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Copyright (c) 2026 Jiaqi Duan
/** @jsxImportSource hono/jsx */
/**
 * Block E — VERDICT CHAIN
 *
 * Shows the critic's reasoning → severity → category → final critique_for_claude.
 * Detects auto-promoted critiques (rubric-generated) and hides duplicate text.
 *
 * Extracted from CritiqueAuditBlocks.tsx.
 */
import { tokens } from "../../tokens/tokens";
import type { V2SidecarData } from "../../../state/api";
import type { CriticCall } from "../../../state/api";
import { AuditSection, PlaceholderNote } from "./shared";

export interface BlockEProps {
  v2: V2SidecarData | null;
  c: CriticCall;
}

const SEVERITY_COLOR: Record<string, string> = {
  high:     tokens.color.terra,
  med:      tokens.color.amber,
  medium:   tokens.color.amber,
  low:      tokens.color.moss,
  info:     tokens.color.ink3,
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

function SeverityBadge({ severity }: { severity: string }) {
  const color = SEVERITY_COLOR[severity.toLowerCase()] ?? tokens.color.ink3;
  return (
    <span
      style={{
        fontFamily: tokens.font.mono,
        fontSize: 9,
        fontWeight: 700,
        color,
        background: `${color}22`,
        border: `1px solid ${color}`,
        borderRadius: tokens.radius.sm,
        padding: "1px 6px",
        textTransform: "uppercase",
        letterSpacing: "0.05em",
      }}
    >
      {severity}
    </span>
  );
}

/**
 * Detect critique_for_claude bodies that were auto-populated by the rubric
 * severity-promoter (run-critic.ts autoPromoteSeverity). These are
 * deterministic restatements of Block C trigger rows and would duplicate
 * the rubric checklist in Block E.
 */
function isAutoPromotedCritique(text: string | null): boolean {
  if (!text) return false;
  return (
    text.startsWith("Rubric flagged concerns the model didn't surface:") ||
    text.startsWith("Diff-summary risks (Haiku pre-pass):")
  );
}

function AutoPromotedBadge() {
  return (
    <span
      title="Brain emitted info but rubric had triggers — severity was force-promoted. See Block C for the trigger list."
      style={{
        fontFamily: tokens.font.mono,
        fontSize: 9,
        fontWeight: 600,
        color: tokens.color.amber,
        background: `${tokens.color.amber}18`,
        border: `1px solid ${tokens.color.amber}`,
        borderRadius: tokens.radius.sm,
        padding: "1px 6px",
        textTransform: "uppercase",
        letterSpacing: "0.05em",
      }}
    >
      auto-promoted · see block C
    </span>
  );
}

function CategoryBadge({ category }: { category: string }) {
  const color = CATEGORY_COLOR[category] ?? tokens.color.sky;
  return (
    <span
      style={{
        fontFamily: tokens.font.mono,
        fontSize: 9,
        color,
        background: `${color}18`,
        border: `1px solid ${color}`,
        borderRadius: tokens.radius.sm,
        padding: "1px 6px",
      }}
    >
      {category}
    </span>
  );
}

function IntentBadge({ v2 }: { v2: V2SidecarData }) {
  return (
    <span
      style={{
        fontFamily: tokens.font.mono,
        fontSize: 9,
        color: tokens.color.sky,
        background: `${tokens.color.sky}18`,
        border: `1px solid ${tokens.color.sky}`,
        borderRadius: tokens.radius.sm,
        padding: "1px 6px",
      }}
    >
      {v2.intent_classification}
      {v2.intent_confidence != null && (
        <> · {Math.round(v2.intent_confidence * 100)}%</>
      )}
    </span>
  );
}

function ReasoningBlock({ reasoning }: { reasoning: string }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
      <span
        style={{
          fontFamily: tokens.font.mono,
          fontSize: 9,
          color: tokens.color.ink3,
          textTransform: "uppercase",
          letterSpacing: "0.06em",
        }}
      >
        reasoning
      </span>
      <div
        style={{
          fontFamily: tokens.font.body,
          fontSize: 12,
          color: tokens.color.ink2,
          whiteSpace: "pre-wrap",
          lineHeight: 1.55,
          borderLeft: `2px solid ${tokens.color.ink3}`,
          paddingLeft: 8,
        }}
      >
        {reasoning}
      </div>
    </div>
  );
}

function CritiqueForClaudeBlock({ text }: { text: string }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
      <span
        style={{
          fontFamily: tokens.font.mono,
          fontSize: 9,
          color: tokens.color.terra,
          textTransform: "uppercase",
          letterSpacing: "0.06em",
        }}
      >
        critique for claude (final ask)
      </span>
      <div
        style={{
          fontFamily: tokens.font.body,
          fontSize: 12,
          color: tokens.color.ink,
          whiteSpace: "pre-wrap",
          lineHeight: 1.55,
          borderLeft: `2px solid ${tokens.color.terra}`,
          paddingLeft: 8,
        }}
      >
        {text}
      </div>
    </div>
  );
}

export function BlockE({ v2, c }: BlockEProps) {
  const severity = v2?.severity ?? c.severity;
  const category = v2?.category ?? null;
  const reasoning = v2?.reasoning ?? c.reasoning;
  const critiqueText = v2?.critique_for_claude ?? c.critique_for_claude;
  const autoPromoted = isAutoPromotedCritique(critiqueText);

  return (
    <AuditSection id="E" label="E · VERDICT CHAIN">
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
        {severity && <SeverityBadge severity={severity} />}
        {autoPromoted && <AutoPromotedBadge />}
        {category && <CategoryBadge category={category} />}
        {v2?.intent_classification && <IntentBadge v2={v2} />}
      </div>

      {reasoning ? (
        <ReasoningBlock reasoning={reasoning} />
      ) : (
        <PlaceholderNote text="no reasoning — older entry or Brain skipped it" />
      )}

      {critiqueText && !autoPromoted ? (
        <CritiqueForClaudeBlock text={critiqueText} />
      ) : !critiqueText ? (
        <PlaceholderNote text="no actionable critique — narrative comment only" />
      ) : null}
    </AuditSection>
  );
}
