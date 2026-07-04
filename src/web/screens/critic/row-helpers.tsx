// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
// Copyright (c) 2026 Jiaqi Duan
/** @jsxImportSource hono/jsx */
/**
 * Row-level helpers shared between RecentTable (the list) and RecentRow
 * (the expanded detail card): RowActions + SpeechKindBadge + ChipBadge.
 *
 * Extracted from src/web/screens/critic/recent-table.tsx to
 * complete the cycle-break alongside section.tsx. Before: recent-table
 * exported these and recent-row imported them → cycle. Now: both import
 * from here.
 */
import { tokens } from "../../tokens/tokens";
import type { CriticCall } from "../../../state/api";
import { feedbackKey } from "./feedback-section";

export function RowActions({ call }: { call: CriticCall }) {
  if (call.status !== "fired") return null;
  const payload = JSON.stringify({ session_id: call.session_id, timestamp: call.timestamp });
  const current = call.user_action;
  // Disable buttons while in-flight; reload on success.
  // Clicking an already-active button sends "clear" to undo.
  // For ack/dismiss (not clear), also snapshot the current feedback textarea
  // text into the per-critique feedback log with action=ack|dismiss so the
  // note travels with the verdict.
  // Use the same synthetic fallback as the FeedbackSection so ack/dismiss
  // snapshots target the right log entry on legacy rows that lack a real
  // critique_id.
  // The snapshot POST is additionally gated on the textarea being MOUNTED
  // (`ta &&`): on /timeline the FeedbackSection lazy-mounts behind a
  // <template x-if> latch, so an ack/dismiss before the Feedback tab was
  // ever opened would find no textarea and post text:'' — which the
  // feedback log's latest-entry-wins display reads as "note cleared".
  // No-op on /history, where the section is always mounted.
  const cid = JSON.stringify(feedbackKey(call));
  const handler = (action: "dismiss" | "ack" | "clear", label: string) =>
    `event.stopPropagation();` +
    `const btn=event.currentTarget;btn.disabled=true;btn.innerText='saving…';` +
    `const cid=${cid};` +
    `const ta=cid?document.querySelector('[data-feedback-textarea="'+cid+'"]'):null;` +
    `const fbText=ta?ta.value:'';` +
    `const tasks=[fetch('/api/critic/action',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({...${payload},action:'${action}'})})];` +
    `if(cid && ta && (${JSON.stringify(action)}==='ack'||${JSON.stringify(action)}==='dismiss'))` +
    `tasks.push(fetch('/api/critique/'+cid+'/feedback',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({text:fbText,action:${JSON.stringify(action)}})}));` +
    `Promise.all(tasks).then(rs=>{for(const r of rs)if(!r.ok)throw new Error('save failed');location.reload()})` +
    `.catch(e=>{btn.disabled=false;btn.innerText='${label}';alert(e.message)})`;
  const btn = (label: string, action: "dismiss" | "ack", color: string, isActive: boolean) => {
    // When this action is the current active state, click sends "clear" to undo.
    const effective = isActive ? "clear" : action;
    const visibleLabel = isActive ? `✓ ${label}` : label;
    return (
      <button
        type="button"
        class={`critic-row-action critic-row-action-${action}`}
        title={isActive ? `click to undo ${action}` : `mark this critique as ${action}`}
        x-on:click={handler(effective, visibleLabel)}
        style={{
          fontFamily: tokens.font.mono,
          fontSize: 9,
          textTransform: "uppercase",
          letterSpacing: "0.05em",
          padding: "2px 8px",
          borderRadius: tokens.radius.pill,
          border: `1px solid ${color}`,
          background: isActive ? color : tokens.color.paper,
          color: isActive ? tokens.color.cream : color,
          cursor: "pointer",
          fontWeight: isActive ? 700 : 500,
        }}
      >
        {visibleLabel}
      </button>
    );
  };
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 6, alignItems: "flex-end" }}>
      <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
        {btn("ack", "ack", tokens.color.moss, current === "acked")}
        {btn("dismiss", "dismiss", tokens.color.terra, current === "dismissed")}
      </div>
      <span
        style={{
          fontFamily: tokens.font.mono,
          fontSize: 9,
          color: tokens.color.ink3,
          whiteSpace: "nowrap",
          textAlign: "right",
          lineHeight: 1.4,
        }}
      >
        ack = seen · dismiss = bad critique · click again to undo
      </span>
    </div>
  );
}

/**
 * Classify what kind of speech a fired critic produced:
 *   - "comment" → severity info, no critique text → just chit-chat / narrative
 *   - "warning" → severity warn OR has critique text → flagging something
 *   - "critical" → severity fail → must-fix call-out
 *
 * Surfaced as a colored pill at the top of the expand panel so the user
 * can answer "is this a critique or just a comment?" at a glance.
 */
export function SpeechKindBadge({
  severity,
  critiqueText,
}: {
  severity: string | null;
  critiqueText: string | null;
}) {
  // Brain schema severity enum: info | low | medium | high.
  // - high           → critical (red)
  // - medium / med   → warning  (amber)
  // - low / info / ∅ → comment  (moss)   — `low` previously mapped to warning
  //                                       which produced amber badges on
  //                                       happy "all green" bubbles whose
  //                                       severity field was just the default
  //                                       Brain output, not a real issue.
  const sev = (severity ?? "").toLowerCase();
  let kind: "comment" | "warning" | "critical";
  let bg: string;
  if (sev === "high") {
    kind = "critical";
    bg = tokens.color.terra;
  } else if (sev === "medium" || sev === "med") {
    kind = "warning";
    bg = tokens.color.amber;
  } else {
    kind = "comment";
    bg = tokens.color.moss;
  }
  // critiqueText reference avoids unused-var lint while we keep the prop for
  // future re-introduction if/when bubble + critique re-align.
  void critiqueText;
  return (
    <span
      class="critic-speech-kind"
      data-kind={kind}
      style={{
        fontFamily: tokens.font.mono,
        fontSize: 9,
        fontWeight: 700,
        textTransform: "uppercase",
        letterSpacing: "0.06em",
        background: bg,
        color: tokens.color.cream,
        borderRadius: tokens.radius.pill,
        padding: "1px 7px",
      }}
    >
      {kind}
    </span>
  );
}

export function ChipBadge({ label, color }: { label: string; color: string }) {
  return (
    <span
      style={{
        fontFamily: tokens.font.mono,
        fontSize: 10,
        color,
        background: tokens.color.paper,
        border: `1px solid ${tokens.color.edge}`,
        borderRadius: tokens.radius.pill,
        padding: "1px 7px",
      }}
    >
      {label}
    </span>
  );
}
