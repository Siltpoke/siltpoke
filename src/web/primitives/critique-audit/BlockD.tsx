// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
// Copyright (c) 2026 Jiaqi Duan
/** @jsxImportSource hono/jsx */
/**
 * Block D — WHAT ELSE I KNEW
 *
 * Surfaces preference-log / few-shot / repo-memory signals that fed
 * into the critic's decision. Lazy-loads few-shot examples per row.
 *
 * Extracted from CritiqueAuditBlocks.tsx.
 */
import type { AuditAbsenceKind } from "../../../state/audit-absence";
import { tokens } from "../../tokens/tokens";
import type { V2SidecarData } from "../../../state/api";
import { AuditSection, PlaceholderNote, auditAbsenceNote, subLabelStyle } from "./shared";

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
  /**
   * Why this row has no audit data, from `CriticCall.audit_absence`. REQUIRED,
   * not optional: an optional prop would let a call site fall back to a default
   * sentence, and a fixed default sentence for every absence is exactly the
   * defect this replaces.
   */
  absence: AuditAbsenceKind;
}

// Shared body-box look for the preference-history and few-shot panels
// (mono, paper background, hairline border). FewShotPanel needs a slightly
// larger internal gap for its extra loading/error rows, so it spreads this
// base and overrides `gap`.
const subPanelBoxStyle = {
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
} as const;

function SignalSourcesRow({ sources }: { sources: readonly string[] }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
      <div style={subLabelStyle}>signal sources fired this review</div>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
        {sources.map((s, i) => (
          <span
            key={i}
            style={{
              fontFamily: tokens.font.mono,
              fontSize: 10,
              color: tokens.color.sky,
              background: `color-mix(in srgb, ${tokens.color.sky} 9%, transparent)`,
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

/**
 * What the four counters above are.
 *
 * Added because the panel showed `ack 0 · dismiss 0 · forward 0 · feedback 0`
 * and nothing else — four bare words and four zeros (the maintainer, 2026-08-19:
 * ). Block C, one section up,
 * lists its rules by name, so a reader sees WHAT was checked even when nothing
 * fired; this panel gave no vocabulary at all, and a `0` with no vocabulary
 * reads as "no data" when it means "you have never done this".
 *
 * It names the four ACTIONS and stops there. It still does NOT say what they
 * feed — but the reason has changed. The two files were measured on 2026-08-19:
 * `preference-log.jsonl` (what these counters read) and `feedback-archive.jsonl`
 * (what `consolidate.ts`'s dismissal loader reads) are different records, not
 * rival paths — the archive is the durable verdict store, this log is the raw
 * signal stream that also feeds the few-shot index. What that measurement found
 * was a write bug, not an ambiguity: dismiss/ack/forward appended here without
 * awaiting, so their CLI's process.exit(0) killed the write and three of these
 * four counters were structurally pinned at zero. Fixed at the write side.
 * A sentence about what the signals TEACH still needs the downstream consumers
 * measured end to end, so the legend stays descriptive until then.
 */
function SignalLegend() {
  const rows: readonly [string, string][] = [
    ["ack", "you marked it seen"],
    ["dismiss", "you said the review was wrong"],
    ["forward", "you acted on it"],
    ["feedback", "you wrote why"],
  ];
  return (
    <div data-preference-legend style={{ display: "flex", flexWrap: "wrap", gap: "2px 10px", color: tokens.color.ink3 }}>
      {rows.map(([name, what]) => (
        <span key={name}>
          <strong>{name}</strong> — {what}
        </span>
      ))}
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
      <span style={subLabelStyle}>preference history (last 30d)</span>
      <div style={subPanelBoxStyle}>
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
        {/* OUTSIDE the stats branch on purpose. The legend explains what the
            four actions ARE, which does not depend on whether any have been
            recorded — and an empty log is exactly when a reader most needs it.
            Rendering it only alongside counts was the first version, and its
            covering test caught that the no-stats path had no vocabulary at
            all. */}
        <SignalLegend />
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
      <span style={subLabelStyle}>repo-memory conventions</span>
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
      <span style={subLabelStyle}>few-shot retrieval (similar past critiques)</span>
      <div style={{ ...subPanelBoxStyle, gap: 4 }}>
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

/**
 * Block D degrades PER PANEL, not all-or-nothing.
 *
 * The sidecar gates what actually DEPENDS on it, and the test for that is the
 * data path, not the prop signature. `signal_sources` and the repo-memory
 * panel read `v2` directly. **Few-shot takes only `critique_id` and still
 * belongs behind the gate**: `/api/critique/:id/few-shot` builds its query text
 * out of the sidecar (`critique_for_claude ?? reasoning ?? bubble_long ??
 * bubble_short ?? ""`) and returns `examples: []` the moment that is empty, so
 * on a sidecar-less row the panel can only ever render "no similar past
 * reviews" — after paying for a request. The first version of this split read
 * the prop list, concluded few-shot was independent, and shipped exactly that.
 * `tests/web/routes/timeline-tabs.test.ts` caught it: `FewShotPanel` uses
 * `x-init="load()"`, and that suite pins the page to exactly ONE such loader at
 * page load, so the change turned a lazy page into one that fans out a fetch
 * per rendered row.
 *
 * What is left unconditional is preference history alone, which really is a
 * 30-day aggregate over a different file and never touched `v2`. An early
 * `if (!v2) return <note>` had been taking it down too, so a row without a
 * sidecar rendered the absence sentence and nothing else.
 *
 * Found by opening the page (the maintainer, 2026-08-19: "这个地方 没有东西诶 这也是
 * 正常的吗"). Half of it was normal and half was not, which is exactly why it
 * needed a human looking rather than a passing test — and Block C, one section
 * up, already degraded the honest way: it keeps rendering the rubric checklist
 * with dots beside every rule. Two sibling blocks, two different degrade
 * behaviours, one of them hiding data it had.
 */
export function BlockD({ v2, preferenceStats = null, critiqueId = null, absence }: BlockDProps) {
  const hasSignals = (v2?.signal_sources.length ?? 0) > 0;

  return (
    <AuditSection id="D" label="D · WHAT ELSE I KNEW">
      {!v2 && <PlaceholderNote text={auditAbsenceNote(absence, "D")} />}
      {v2 && hasSignals ? <SignalSourcesRow sources={v2.signal_sources} /> : null}
      <PreferenceHistoryPanel preferenceStats={preferenceStats} critiqueId={critiqueId} />
      {v2 && critiqueId && <FewShotPanel critiqueId={critiqueId} />}
      {v2 && <RepoMemoryConventionsPanel v2={v2} />}
      {v2 && !hasSignals && (
        <PlaceholderNote text="no inline signals (foundation only — not fully wired yet)" />
      )}
    </AuditSection>
  );
}
