// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Copyright (c) 2026 Jiaqi Duan
/** @jsxImportSource hono/jsx */
/**
 * Timeline detail-pane tabs beyond Critic: Diff / Trace / Feedback.
 *
 * Loading pattern (mirrors /history's row-expansion diff loader in
 * recent-row.tsx): the page embeds NO diff bodies and NO trace data.
 * Each tab that needs heavy content owns a small nested Alpine scope with
 * a once-latched loader; an x-effect gated on
 * `tab === <id> && selected === <this pane>` fires the fetch on FIRST
 * open only (the gate on `selected` stops one tab click from fanning out
 * a fetch per embedded pane). Both endpoints return pre-rendered HTML
 * fragments injected via x-html — same contract as
 * GET /api/critique/:id/diff.
 */

import type { CriticCall } from "../../../state/api";
import { tokens } from "../../tokens/tokens";
import { DiffSummaryView } from "../critic/diff";
import { FeedbackSection, feedbackKey } from "../critic/feedback-section";
import { EmptySection, Section } from "../critic/section";
import { turnKey } from "./format";

const noteStyle = {
  fontFamily: tokens.font.body,
  fontSize: 12,
  fontStyle: "italic" as const,
  color: tokens.color.ink3,
  lineHeight: 1.6,
  padding: "8px 0",
};

const monoLine = {
  fontFamily: tokens.font.mono,
  fontSize: 11,
  padding: "8px 0",
};

/** Contingency copy — snapshot recorded but since GC'd (endpoint 404). */
export const DIFF_GONE_NOTE =
  "diff snapshot no longer on disk — it was recorded but has been cleaned up since. The summary above is the surviving record.";

/** Copy for turns that never had a snapshot (matches /history's note). */
export const DIFF_NEVER_NOTE =
  "no snapshot — git diff vs HEAD was empty (changes already committed) OR entry pre-dates the snapshot writer.";

/**
 * Once-latched fetch-to-HTML loader shared by the Diff and Trace tabs.
 * `notFound` handling: 404 flips the `missing` flag instead of erroring
 * (the Diff endpoint 404s when the snapshot was GC'd — contingency handling).
 */
function fragmentLoader(prefix: string, endpoint: string): string {
  return `{
    ${prefix}Html: '',
    ${prefix}Loading: false,
    ${prefix}Loaded: false,
    ${prefix}Missing: false,
    ${prefix}Err: '',
    load_${prefix}() {
      if (this.${prefix}Loaded || this.${prefix}Loading) return;
      this.${prefix}Loading = true;
      fetch(${JSON.stringify(endpoint)}).then(r => {
        if (r.status === 404) { this.${prefix}Missing = true; this.${prefix}Loaded = true; return ''; }
        if (!r.ok) return r.text().then(t => Promise.reject(t || ('HTTP ' + r.status)));
        return r.text().then(t => { this.${prefix}Loaded = true; return t; });
      }).then(t => {
        if (t) this.${prefix}Html = t;
        this.${prefix}Loading = false;
      }).catch(e => { this.${prefix}Err = String(e); this.${prefix}Loading = false; });
    }
  }`;
}

/**
 * x-effect gate: run `action` on the first open of THIS tab for THIS
 * selected pane. The `selected` half stops one tab click from fanning out
 * an action per embedded pane.
 */
function openGate(tabId: string, paneKey: string, action: string): string {
  return `if (tab === ${JSON.stringify(tabId)} && selected === ${JSON.stringify(paneKey)}) ${action}`;
}

function FragmentStates({ prefix, missingNote }: { prefix: string; missingNote: string }) {
  return (
    <>
      <div x-show={`${prefix}Loading`} style={{ ...monoLine, color: tokens.color.ink3 }}>
        loading…
      </div>
      <div
        x-show={`${prefix}Err`}
        x-text={`'load failed: ' + ${prefix}Err`}
        style={{ ...monoLine, color: tokens.color.terra }}
      />
      <div x-show={`${prefix}Missing`} x-cloak style={noteStyle} data-fragment-missing={prefix}>
        {missingNote}
      </div>
      <div x-show={`${prefix}Html`} x-html={`${prefix}Html`} />
    </>
  );
}

/** Haiku structured summary — same section /history renders inline. */
function DiffSummaryBlock({ c }: { c: CriticCall }) {
  if (!c.diff_summary) {
    return (
      <EmptySection
        title="diff summary"
        note="no haiku summary for this turn — the summarizer pre-pass didn't run (legacy entry) or had nothing to summarize."
      />
    );
  }
  return (
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
          <span style={{ textTransform: "uppercase", letterSpacing: "0.06em" }}>
            haiku error ·{" "}
          </span>
          {c.summary_error}
        </div>
      )}
      <DiffSummaryView summary={c.diff_summary} />
    </Section>
  );
}

/**
 * Diff tab: summary inline (small structured data, same as /history),
 * per-file diff strictly on demand from GET /api/critique/:id/diff.
 */
export function DiffTab({ c }: { c: CriticCall }) {
  const key = turnKey(c);
  const canLoad = Boolean(c.critique_id && c.diff_snapshot_id);
  const body = canLoad ? (
    <div
      x-data={fragmentLoader("diff", `/api/critique/${c.critique_id}/diff`)}
      x-effect={openGate("diff", key, "load_diff()")}
    >
      <Section title="diff snapshot">
        <FragmentStates prefix="diff" missingNote={DIFF_GONE_NOTE} />
      </Section>
    </div>
  ) : (
    <EmptySection title="diff snapshot" note={DIFF_NEVER_NOTE} />
  );
  return (
    <div
      x-show={'tab === "diff"'}
      x-cloak
      style={{ display: "flex", flexDirection: "column", gap: 24 }}
    >
      <DiffSummaryBlock c={c} />
      {body}
    </div>
  );
}

/**
 * Trace tab: linked trace(s) via the critique_id join, loaded on
 * demand as a server-rendered fragment from GET /api/critique/:id/trace
 * (waterfall + per-brain-span costs + cache-savings banner). All empty /
 * degraded states are rendered server-side INTO the fragment, so the only
 * client-side contingency left is a legacy turn with no critique_id.
 */
export function TraceTab({ c }: { c: CriticCall }) {
  const key = turnKey(c);
  const body = c.critique_id ? (
    <div
      x-data={fragmentLoader("trace", `/api/critique/${c.critique_id}/trace`)}
      x-effect={openGate("trace", key, "load_trace()")}
    >
      <FragmentStates
        prefix="trace"
        missingNote="trace lookup unavailable — the daemon build serving this page pre-dates the trace fragment endpoint."
      />
    </div>
  ) : (
    <div style={noteStyle} data-trace-note="no-critique-id">
      no trace join possible — this turn pre-dates per-row critique ids, so its spans (if any)
      cannot be linked.
    </div>
  );
  return (
    <div x-show={'tab === "trace"'} x-cloak>
      {body}
    </div>
  );
}

/**
 * Feedback tab: the existing per-critique note (append-only history,
 * GET/POST /api/critique/:id/feedback) composed as-is. ack / dismiss live
 * in the pane header (RowActions) and write through /api/critic/action —
 * the hint line below points there.
 *
 * LAZY MOUNT: FeedbackSection carries `x-init="load()"` — mounted eagerly
 * (as /history does) every embedded pane would fire a feedback GET at page
 * load (~200 on a busy window). Here it sits inside `<template x-if>`
 * behind a one-way LATCH: plain `x-if="tab === ... && selected === ..."`
 * would UNMOUNT on switch-away and re-run x-init (a refetch) on every
 * return, so the openGate x-effect instead flips `fbMounted` true once on
 * first open and it never goes false — mount once, fetch once, stay
 * mounted (visibility is the outer x-show's job). /history untouched.
 */
export function FeedbackTab({ c }: { c: CriticCall }) {
  const key = turnKey(c);
  return (
    <div
      x-show={'tab === "feedback"'}
      x-cloak
      x-data="{ fbMounted: false }"
      x-effect={openGate("feedback", key, "fbMounted = true")}
      style={{ display: "flex", flexDirection: "column", gap: 14 }}
    >
      <template x-if="fbMounted">
        <div>
          <FeedbackSection critiqueId={feedbackKey(c)} />
        </div>
      </template>
      <div style={{ ...noteStyle, padding: "0 0 4px" }}>
        ack / dismiss buttons are in the header above — they save any note text along with the
        verdict.
      </div>
    </div>
  );
}
