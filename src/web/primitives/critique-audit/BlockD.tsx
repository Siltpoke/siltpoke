// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
// Copyright (c) 2026 Jiaqi Duan
/** @jsxImportSource hono/jsx */
/**
 * Block D — SIGNALS APPLIED
 *
 * Surfaces preference-log / few-shot / repo-memory signals that fed
 * into the critic's decision. Lazy-loads few-shot examples per row.
 *
 * Extracted from CritiqueAuditBlocks.tsx.
 */
import { tokens } from "../../tokens/tokens";
import type { V2SidecarData } from "../../../state/api";
import { AuditSection, PlaceholderNote, V2_MISSING_NOTE } from "./shared";

export interface BlockDPreferenceStats {
  total: number;
  ack: number;
  dismiss: number;
  forward: number;
  feedback: number;
  byCritique: Record<string, { ack: number; dismiss: number; forward: number; feedback: number }>;
  windowStart: string | null;
  windowEnd: string | null;
}

export interface BlockDProps {
  v2: V2SidecarData | null;
  /** Aggregate stats across the preference-log (last 30d). Shared across all rows. */
  preferenceStats?: BlockDPreferenceStats | null;
  /** This row's critique_id (used for per-critique signal breakdown + few-shot fetch). */
  critiqueId?: string | null;
}

function SignalSourcesRow({ sources }: { sources: readonly string[] }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
      <div
        style={{
          fontFamily: tokens.font.mono,
          fontSize: 9,
          color: tokens.color.ink3,
          textTransform: "uppercase",
          letterSpacing: "0.06em",
        }}
      >
        signal sources fired this review
      </div>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
        {sources.map((s, i) => (
          <span
            key={i}
            style={{
              fontFamily: tokens.font.mono,
              fontSize: 10,
              color: tokens.color.sky,
              background: `${tokens.color.sky}18`,
              border: `1px solid ${tokens.color.sky}`,
              borderRadius: tokens.radius.sm,
              padding: "1px 6px",
            }}
          >
            {s}
          </span>
        ))}
      </div>
    </div>
  );
}

function PreferenceHistoryPanel({
  preferenceStats,
  critiqueId,
}: {
  preferenceStats: BlockDPreferenceStats | null;
  critiqueId: string | null;
}) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 3 }}>
      <span
        style={{
          fontFamily: tokens.font.mono,
          fontSize: 9,
          color: tokens.color.ink3,
          textTransform: "uppercase",
          letterSpacing: "0.06em",
        }}
      >
        preference history (last 30d)
      </span>
      <div
        style={{
          fontFamily: tokens.font.mono,
          fontSize: 10,
          color: tokens.color.ink2,
          background: tokens.color.paper,
          border: `1px solid ${tokens.color.edge}`,
          borderRadius: tokens.radius.sm,
          padding: "5px 8px",
          display: "flex",
          flexDirection: "column",
          gap: 3,
        }}
      >
        {preferenceStats ? (
          <>
            <div>
              global: <strong>{preferenceStats.total}</strong> signals ·
              {" "}<span style={{ color: tokens.color.moss }}>ack {preferenceStats.ack}</span> ·
              {" "}<span style={{ color: tokens.color.terra }}>dismiss {preferenceStats.dismiss}</span> ·
              {" "}<span style={{ color: tokens.color.sky }}>forward {preferenceStats.forward}</span> ·
              {" "}feedback {preferenceStats.feedback}
            </div>
            {critiqueId && preferenceStats.byCritique[critiqueId] ? (
              <div style={{ color: tokens.color.ink3 }}>
                this critique: ack {preferenceStats.byCritique[critiqueId]?.ack} ·
                {" "}dismiss {preferenceStats.byCritique[critiqueId]?.dismiss} ·
                {" "}forward {preferenceStats.byCritique[critiqueId]?.forward} ·
                {" "}feedback {preferenceStats.byCritique[critiqueId]?.feedback}
              </div>
            ) : (
              <div style={{ color: tokens.color.ink3 }}>
                this review: no signals yet — use ack / dismiss / feedback box below
              </div>
            )}
          </>
        ) : (
          <span style={{ color: tokens.color.ink3 }}>preference-log empty or unavailable</span>
        )}
      </div>
    </div>
  );
}

function RepoMemoryConventionsPanel({ v2 }: { v2: V2SidecarData }) {
  const fired = v2.rubric_triggers.some(
    (t) => t.rule_id === "repo-memory-convention" || t.rule_id === "repo-memory-inconsistency",
  );
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 3 }}>
      <span
        style={{
          fontFamily: tokens.font.mono,
          fontSize: 9,
          color: tokens.color.ink3,
          textTransform: "uppercase",
          letterSpacing: "0.06em",
        }}
      >
        repo-memory conventions
      </span>
      <div
        style={{
          fontFamily: tokens.font.mono,
          fontSize: 10,
          color: tokens.color.ink3,
          background: tokens.color.paper,
          border: `1px solid ${tokens.color.edge}`,
          borderRadius: tokens.radius.sm,
          padding: "4px 8px",
        }}
      >
        {fired
          ? "repo-memory rule fired — see Block C for trigger detail"
          : "no repo-memory signals fired this review"}
      </div>
    </div>
  );
}

/**
 * FewShotPanel — lazy-loaded panel rendering top-K similar past
 * critiques. Each card owns its own Alpine x-data scope so multiple
 * panels on /history fetch independently and don't share state.
 */
function FewShotPanel({ critiqueId }: { critiqueId: string }) {
  const endpoint = `/api/critique/${critiqueId}/few-shot`;
  const alpine = `{
    loaded: false,
    loading: false,
    err: '',
    examples: [],
    async load() {
      if (this.loaded || this.loading) return;
      this.loading = true; this.err = '';
      try {
        const r = await fetch('${endpoint}');
        if (!r.ok) throw new Error('HTTP ' + r.status);
        const j = await r.json();
        this.examples = Array.isArray(j.examples) ? j.examples : [];
        this.loaded = true;
      } catch (e) { this.err = String(e); }
      this.loading = false;
    }
  }`;
  return (
    <div
      x-data={alpine}
      x-init="load()"
      style={{ display: "flex", flexDirection: "column", gap: 3 }}
    >
      <span
        style={{
          fontFamily: tokens.font.mono,
          fontSize: 9,
          color: tokens.color.ink3,
          textTransform: "uppercase",
          letterSpacing: "0.06em",
        }}
      >
        few-shot retrieval (similar past critiques)
      </span>
      <div
        style={{
          fontFamily: tokens.font.mono,
          fontSize: 10,
          color: tokens.color.ink2,
          background: tokens.color.paper,
          border: `1px solid ${tokens.color.edge}`,
          borderRadius: tokens.radius.sm,
          padding: "5px 8px",
          display: "flex",
          flexDirection: "column",
          gap: 4,
        }}
      >
        <span x-show="loading" style={{ color: tokens.color.ink3 }}>loading…</span>
        <span x-show="err" x-text="'load failed: ' + err" style={{ color: tokens.color.terra }} />
        <span x-show="loaded && examples.length === 0" style={{ color: tokens.color.ink3 }}>
          no similar past reviews (sim ≥ 0.3)
        </span>
        <template x-for="(ex, idx) in examples" x-bind:key="idx">
          <div
            style={{
              display: "flex",
              gap: 8,
              alignItems: "baseline",
              borderLeft: `2px solid ${tokens.color.edge}`,
              paddingLeft: 6,
            }}
          >
            <span x-text="(ex.similarity * 100).toFixed(0) + '%'" style={{ color: tokens.color.sky, minWidth: 32 }} />
            <span x-text="ex.critique_id" style={{ color: tokens.color.ink3, minWidth: 80 }} />
            <span x-text="ex.summary" style={{ color: tokens.color.ink, flex: 1 }} />
          </div>
        </template>
      </div>
    </div>
  );
}

export function BlockD({ v2, preferenceStats = null, critiqueId = null }: BlockDProps) {
  if (!v2) {
    return (
      <AuditSection id="D" label="D · SIGNALS APPLIED">
        <PlaceholderNote text={V2_MISSING_NOTE} />
      </AuditSection>
    );
  }

  const hasSignals = v2.signal_sources.length > 0;

  return (
    <AuditSection id="D" label="D · SIGNALS APPLIED">
      {hasSignals ? <SignalSourcesRow sources={v2.signal_sources} /> : null}
      <PreferenceHistoryPanel preferenceStats={preferenceStats} critiqueId={critiqueId} />
      {critiqueId && <FewShotPanel critiqueId={critiqueId} />}
      <RepoMemoryConventionsPanel v2={v2} />
      {!hasSignals && (
        <PlaceholderNote text="no inline signals (foundation only — not fully wired yet)" />
      )}
    </AuditSection>
  );
}
