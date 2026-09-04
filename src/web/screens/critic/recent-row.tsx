// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
// Copyright (c) 2026 Jiaqi Duan
/** @jsxImportSource hono/jsx */
/**
 * RecentRow — one row in the Critic.tsx /history activity table.
 *
 * Extracted from src/web/screens/Critic.tsx.
 */
import { tokens } from "../../tokens/tokens";
import type { CriticCall, CriticTelemetry } from "../../../state/api";
import { BlockA, BlockC, BlockD, BlockE, EvidenceMark, PartialDiffMark, redactPath } from "../../primitives/CritiqueAuditBlocks";
import { STATUS_COLOR, formatTimeAgo } from "./helpers";
import { prettifyProject } from "./filter-bar";
import { DiffSummaryView, DiffView } from "./diff";
import { RowActions, SpeechKindBadge, ChipBadge } from "./row-helpers";
import { EmptySection, Section } from "./section";
import { feedbackKey, FeedbackSection } from "./feedback-section";
import { DIFF_NEVER_NOTE } from "../timeline/detail-tabs";

export function RecentRow({ c, now, homeBasename, preferenceStats }: {
  c: CriticCall;
  now: Date;
  homeBasename: string | null;
  preferenceStats: CriticTelemetry["preferenceStats"];
}) {
  const tag = c.status === "fired" ? "FIRED" : c.skip_reason ?? "unknown";
  const color = STATUS_COLOR[tag] ?? tokens.color.ink3;
  // Every fired row is expandable so the user can see metadata even when
  // there's no long bubble / critique / evidence. Skipped rows stay flat.
  const expandable = c.status === "fired";
  const kindColor = c.speech_kind === "critical"
    ? tokens.color.terra
    : c.speech_kind === "warning"
      ? tokens.color.amber
      : c.speech_kind === "comment"
        ? tokens.color.moss
        : tokens.color.ink3;

  const dimmed = c.user_action !== null;
  // Diff snapshots are loaded on demand via /api/critique/:id/diff once the
  // row is opened (saves ~700KB/row of SSR HTML on busy windows). The Alpine
  // state below tracks fetch lifecycle; loadDiff() runs once on first expand.
  const diffEndpoint = c.critique_id ? `/api/critique/${c.critique_id}/diff` : "";
  const diffAlpineInit = c.critique_id
    ? `{open:false, diffText:'', diffLoading:false, diffErr:'', diffLoaded:false, loadDiff(){ if(this.diffLoaded||this.diffLoading) return; this.diffLoading=true; fetch('${diffEndpoint}').then(r => r.ok ? r.text() : r.text().then(t => Promise.reject(t || ('HTTP '+r.status)))).then(t => { this.diffText=t; this.diffLoaded=true; this.diffLoading=false; }).catch(e => { this.diffErr=String(e); this.diffLoading=false; }); }}`
    : `{open:false}`;
  return (
    <div
      x-data={diffAlpineInit}
      data-user-action={c.user_action ?? ""}
      style={{
        borderBottom: `1px solid ${tokens.color.edge}`,
        padding: "6px 4px",
        opacity: dimmed ? 0.55 : 1,
      }}
    >
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "60px 70px 130px minmax(0, 1fr) 24px",
          gap: 10,
          alignItems: "flex-start",
          paddingTop: 2,
          cursor: expandable ? "pointer" : "default",
        }}
        {...(expandable
          ? { "x-on:click": c.critique_id ? "open = !open; loadDiff()" : "open = !open" }
          : {})}
      >
        <span
          style={{
            fontFamily: tokens.font.mono,
            fontSize: 10,
            color: tokens.color.ink3,
          }}
        >
          {formatTimeAgo(c.timestamp, now)} ago
        </span>
        <span
          style={{
            fontFamily: tokens.font.mono,
            fontSize: 10,
            fontWeight: 600,
            color,
            textTransform: "uppercase",
          }}
        >
          {tag === "FIRED" ? "FIRED" : "skip"}
        </span>
        <span
          style={{
            display: "flex",
            alignItems: "center",
            gap: 6,
            fontFamily: tokens.font.mono,
            fontSize: 10,
            color: tokens.color.ink3,
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }}
        >
          {c.status === "fired" && (
            <span
              aria-label={c.speech_kind ? `kind: ${c.speech_kind}` : ""}
              title={c.speech_kind ?? ""}
              style={{
                width: 8,
                height: 8,
                borderRadius: "50%",
                background: kindColor,
                display: "inline-block",
                flexShrink: 0,
              }}
            />
          )}
          <span style={{ overflow: "hidden", textOverflow: "ellipsis" }}>
            {prettifyProject(c.project, homeBasename)}
          </span>
        </span>
        <span
          style={{
            display: "flex",
            alignItems: "flex-start",
            gap: 8,
            minWidth: 0,
          }}
        >
          {c.user_action && (
            <span
              style={{
                fontFamily: tokens.font.mono,
                fontSize: 9,
                textTransform: "uppercase",
                letterSpacing: "0.06em",
                padding: "1px 6px",
                borderRadius: tokens.radius.pill,
                background: c.user_action === "acked" ? tokens.color.moss : tokens.color.ink3,
                color: tokens.color.cream,
                flexShrink: 0,
              }}
            >
              {c.user_action === "acked" ? "✓ ack" : "✕ dismiss"}
            </span>
          )}
          <span
            style={{
              fontFamily: c.status === "fired" ? tokens.font.body : tokens.font.mono,
              fontSize: 11,
              color: c.status === "fired" ? tokens.color.ink : color,
              whiteSpace: "normal",
              wordBreak: "break-word",
              textDecoration: c.user_action === "dismissed" ? "line-through" : "none",
              minWidth: 0,
              lineHeight: 1.45,
            }}
          >
            {c.status === "fired"
              ? c.bubble_short ?? "(no bubble)"
              : c.skip_reason ?? "unknown reason"}
          </span>
        </span>
        <span
          style={{
            fontFamily: tokens.font.mono,
            fontSize: 11,
            color: tokens.color.ink3,
            textAlign: "right",
          }}
          x-text={expandable ? "open ? '▾' : '▸'" : "''"}
        >
          {expandable ? "▸" : ""}
        </span>
      </div>
      {expandable && (
        <div
          x-show="open"
          x-cloak
          style={{
            marginTop: 12,
            padding: "22px 26px 26px",
            background: tokens.color.cream,
            border: `1px solid ${tokens.color.edge}`,
            borderRadius: tokens.radius.sm,
            display: "flex",
            flexDirection: "column",
            gap: 24,
            position: "relative",
          }}
        >
          {/* Header — speech kind chip + actions on the right */}
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 16, flexWrap: "wrap" }}>
            <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
              <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
                <SpeechKindBadge severity={c.severity} critiqueText={c.critique_for_claude} />
                {c.user_action && (
                  <ChipBadge
                    label={c.user_action}
                    color={c.user_action === "acked" ? tokens.color.moss : tokens.color.ink3}
                  />
                )}
              </div>
              {/* Meta row — confidence */}
              {c.confidence && (
                <div style={{ fontFamily: tokens.font.mono, fontSize: 10, color: tokens.color.ink3 }}>
                  confidence · {c.confidence}
                </div>
              )}
            </div>
            <RowActions call={c} />
          </div>

          {c.cwd && (
            <div
              style={{
                fontFamily: tokens.font.mono,
                fontSize: 10,
                color: tokens.color.ink3,
                paddingBottom: 4,
                borderBottom: `1px solid ${tokens.color.edge}`,
              }}
              title={c.cwd}
            >
              {redactPath(c.cwd, null)}
            </div>
          )}

          {/* (bubble_short shown in the row above — no need to duplicate here) */}

          {/* How much of this review was checked. /history renders the same
              review text as /timeline, so it needs the same caveat — a sibling
              surface that dropped the mark would show an entirely-unverified
              review as pixel-identical to a fully-grounded one. Found by an
              independent reviewer; the first draft marked /timeline only. */}
          <EvidenceMark label={c.evidence_label} unverifiedCount={c.evidence_unverified} />
          <PartialDiffMark shown={c.diff_shown} total={c.diff_total} />

          {/* Bubble long — Brain's freeform narrative. Shown above the 6 blocks. */}
          {c.bubble_long && (
            <Section title="narrative · bubble_long">
              <div
                style={{
                  fontFamily: tokens.font.body,
                  fontSize: 12,
                  color: tokens.color.ink,
                  whiteSpace: "pre-wrap",
                  lineHeight: 1.55,
                }}
              >
                {c.bubble_long}
              </div>
            </Section>
          )}

          {/* ── 6 transparent-audit blocks ── */}

          {/* A — WHAT I READ */}
          <BlockA v2={c.v2} c={c} />

          {/* C — RUBRIC CHECKLIST */}
          <BlockC v2={c.v2} cwd={c.cwd} absence={c.audit_absence} />

          {/* D — WHAT ELSE I KNEW */}
          <BlockD v2={c.v2} preferenceStats={preferenceStats} critiqueId={c.critique_id} absence={c.audit_absence} />

          {/* E — HOW I DECIDED */}
          <BlockE v2={c.v2} c={c} />

          {/* F — COST: removed from /history — view cost + timing in /traces */}

          {/* Haiku diff summary (kept from old blocks — still useful context). */}
          {c.diff_summary && (
            <Section
              title={c.diff_summary.source === "haiku"
                ? "diff summary · haiku pre-pass"
                : "diff summary · heuristic (haiku unavailable)"}
            >
              {c.diff_summary.source === "heuristic" && c.summary_error && (
                <div
                  style={{
                    fontFamily: tokens.font.mono,
                    fontSize: 10,
                    color: tokens.color.terra,
                    background: tokens.color.paper,
                    border: `1px solid ${tokens.color.terra}`,
                    borderRadius: tokens.radius.sm,
                    padding: "6px 10px",
                    marginBottom: 10,
                    lineHeight: 1.5,
                    whiteSpace: "pre-wrap",
                    wordBreak: "break-word",
                  }}
                >
                  <span style={{ textTransform: "uppercase", letterSpacing: "0.06em" }}>haiku error · </span>
                  {c.summary_error}
                </div>
              )}
              <DiffSummaryView summary={c.diff_summary} />
            </Section>
          )}

          {/* Git diff snapshot — loaded on demand via /api/critique/:id/diff
              when the row is opened. The API returns a pre-rendered HTML
              fragment (same <DiffView> the SSR path uses) so side-by-side
              file rows survive without duplicating the parser client-side. */}
          {c.diff_snapshot_id && c.critique_id ? (
            <Section title="diff snapshot">
              <div
                x-show="diffLoading"
                style={{ fontFamily: tokens.font.mono, fontSize: 11, color: tokens.color.ink3, padding: "8px 0" }}
              >
                loading…
              </div>
              <div
                x-show="diffErr"
                x-text="'diff load failed: ' + diffErr"
                style={{ fontFamily: tokens.font.mono, fontSize: 11, color: tokens.color.terra, padding: "8px 0" }}
              />
              <div x-show="diffText" x-html="diffText" />
            </Section>
          ) : (
            <EmptySection title="diff snapshot" note={DIFF_NEVER_NOTE} />
          )}

          {/* User feedback — per-critique note + edit history. Saved
              append-only; empty text is valid and acts as a clear. Future
              phase wires recent entries into Brain's preference signals.
              Legacy fired rows without a critique_id (pre Bug-1 fix) get
              a synthetic key derived from session_id + timestamp so the
              feedback box is still available for ALL fired critiques. */}
          <FeedbackSection critiqueId={feedbackKey(c)} />
        </div>
      )}
    </div>
  );
}

