// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
// Copyright (c) 2026 Jiaqi Duan
/** @jsxImportSource hono/jsx */
import { MemoryActionLog } from "./MemoryActionLog";
import { tokens } from "../tokens/tokens";

/**
 * Inline text body with `code` highlighting — splits on backticks via the
 * island's `event.segs` (precomputed in decorateRow). Reused by the timeline
 * row and the modal card. The loop var `event` comes from the enclosing
 * `<template x-for>` scope. Morph-safe (x-for / x-text / x-show only).
 */
export function MemorySegs() {
  return (
    <span>
      <template x-for="(seg, i) in event.segs" x-bind:key="i">
        <span>
          <code
            x-show="seg.isCode"
            x-text="seg.t"
            style={{
              fontFamily: tokens.font.mono,
              fontSize: 12,
              color: "#6366b8",
              background: "rgba(99,102,184,.09)",
              padding: "1px 5px",
              borderRadius: "4px",
            }}
          />
          <span x-show="!seg.isCode" x-text="seg.t" />
        </span>
      </template>
    </span>
  );
}

const xBindCard =
  "{ background: event.cardBg, borderLeft: '3px solid ' + event.typeColor }";
const xBindTypePill =
  "{ color: event.typeColor, background: event.typeBg," +
  " border: '1px solid ' + event.typeBd }";
const xBindStatus =
  "{ color: event.statusInk, background: event.statusBg," +
  " border: '1px solid ' + event.statusBd }";

/**
 * Timeline row — `[time gutter] [colored rail dot+line] [card]` per the
 * 记忆之书 mockup. All values come from the decorated `event` loop var.
 * Keeps the structural classes (.memory-row / -time / -text / -why / -type /
 * -status) the E2E depends on. No per-row forget button — the forget action
 * moved to the by-type composer.
 */
export function MemoryAlpineRow() {
  return (
    <div
      class="memory-row"
      x-bind:data-event-id="event.id"
      style={{ display: "flex", gap: "12px" }}
    >
      {/* time gutter */}
      <div
        class="memory-row-time"
        x-text="event.time"
        style={{
          width: "42px",
          flexShrink: 0,
          textAlign: "right",
          fontFamily: tokens.font.mono,
          fontSize: 10,
          color: tokens.color.ink3,
          paddingTop: "14px",
        }}
      />
      {/* rail: connector line + colored dot */}
      <div
        style={{
          position: "relative",
          width: "14px",
          flexShrink: 0,
          display: "flex",
          justifyContent: "center",
        }}
      >
        <div
          style={{
            position: "absolute",
            top: "6px",
            bottom: "-13px",
            width: "2px",
            background: "#e7ddc8",
          }}
        />
        <div
          x-bind:style="{ background: event.typeColor }"
          style={{
            position: "relative",
            marginTop: "14px",
            width: "11px",
            height: "11px",
            borderRadius: "50%",
            border: `2px solid ${tokens.color.cream}`,
            zIndex: 1,
          }}
        />
      </div>
      {/* card */}
      <div
        x-bind:style={xBindCard}
        style={{
          flex: 1,
          minWidth: 0,
          position: "relative",
          background: "#fffdf8",
          border: `1px solid ${tokens.color.paperD}`,
          borderRadius: "10px",
          padding: "11px 14px",
        }}
      >
        {/* ── Top-right absolute stack: status badge + action buttons ───
            All action buttons are DIRECT children of this one flex row so
            alignItems:center aligns every pill on the same axis.
            Root cause of prior misalignment: layout.tsx had
              .memory-pending-actions { margin-top: 8px }
            which pushed approve/reject 4px below the badge in a 30px
            alignItems:center container. Fix = remove margin-top from the class.
            x-show elements carry NO inline display value to avoid the Alpine
            removeProperty('display') clobber trap; .memory-pending-actions
            gets display:flex from its CSS class in layout.tsx instead.
            Morph-safe: x-on:click / x-show only, no addEventListener. */}
        <div
          style={{
            position: "absolute",
            top: "11px",
            right: "14px",
            display: "flex",
            flexDirection: "row",
            alignItems: "center",
            gap: "8px",
          }}
        >
          {/* status badge */}
          <span
            class="memory-row-status"
            x-text="event.statusLabel"
            x-bind:style={xBindStatus}
            style={{
              fontFamily: tokens.font.mono,
              fontSize: 10,
              fontWeight: 600,
              borderRadius: tokens.radius.pill,
              padding: "0 10px",
              lineHeight: "20px",
            }}
          />
          {/* 🗑 删除 — active facts only; soft-retire (row stays → 退休).
              No inline display — x-show show-path calls removeProperty('display'),
              so adding display here would be clobbered; button default is safe. */}
          <button
            class="memory-row-delete"
            type="button"
            x-show="event.status === 'active'"
            x-on:click="deleteFact(event.id)"
            style={{
              fontFamily: tokens.font.mono,
              fontSize: 10,
              fontWeight: 600,
              color: tokens.color.terra,
              background: "transparent",
              border: `1px solid ${tokens.color.terra}`,
              borderRadius: tokens.radius.pill,
              padding: "0 10px",
              lineHeight: "20px",
              cursor: "pointer",
            }}
          >
            Delete
          </button>
          {/* ↩ 撤回退休 — retired facts only; undoes the retire (→ active).
              No inline display — same x-show safety rationale as 删除. */}
          <button
            class="memory-row-reactivate"
            type="button"
            x-show="event.status === 'retired'"
            x-on:click="reactivateFact(event.id)"
            style={{
              fontFamily: tokens.font.mono,
              fontSize: 10,
              fontWeight: 600,
              color: tokens.color.moss,
              background: "transparent",
              border: `1px solid ${tokens.color.moss}`,
              borderRadius: tokens.radius.pill,
              padding: "0 10px",
              lineHeight: "20px",
              cursor: "pointer",
            }}
          >
            ↩ Undo retire
          </button>
          {/* ✓ 确认 / ✕ 拒绝 — pending facts only.
              display:flex comes from the CSS class .memory-pending-actions
              (in layout.tsx) — NOT from an inline style — so Alpine x-show's
              show-path (removeProperty('display')) restores flex, not block.
              gap:6px is also in the class. No margin-top (that was the
              root cause of the ~4px badge↔button misalignment). */}
          <div
            class="memory-row-pending-actions memory-pending-actions"
            x-show="event.status === 'pending'"
          >
            <button
              class="memory-row-approve"
              type="button"
              x-on:click="approveFact(event.id)"
              style={{
                fontFamily: tokens.font.mono,
                fontSize: 10,
                fontWeight: 600,
                color: tokens.color.cream,
                background: tokens.color.moss,
                border: `1px solid ${tokens.color.moss}`,
                borderRadius: tokens.radius.pill,
                padding: "0 12px",
                lineHeight: "20px",
                cursor: "pointer",
              }}
            >
              ✓ Confirm
            </button>
            <button
              class="memory-row-reject"
              type="button"
              x-on:click="rejectFact(event.id)"
              style={{
                fontFamily: tokens.font.mono,
                fontSize: 10,
                fontWeight: 600,
                color: tokens.color.terra,
                background: "transparent",
                border: `1px solid ${tokens.color.terra}`,
                borderRadius: tokens.radius.pill,
                padding: "0 12px",
                lineHeight: "20px",
                cursor: "pointer",
              }}
            >
              ✕ Reject
            </button>
          </div>
        </div>
        {/* type pill + ★重申 badge (status badge moved to absolute top-right) */}
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: "8px",
            marginBottom: "7px",
          }}
        >
          <span
            class="memory-row-type"
            x-text="event.typeLabel"
            x-bind:style={xBindTypePill}
            style={{
              fontFamily: tokens.font.mono,
              fontSize: 9.5,
              fontWeight: 600,
              borderRadius: tokens.radius.pill,
              padding: "2px 9px",
            }}
          />
          {/* ★ 重申 ×N — subtle reaffirmation badge (recall_count > 0). A span
              defaults to inline, so x-show toggling display is safe here (no
              flex container → the inline-display clobber gotcha doesn't apply).
              Morph-safe: x-show / x-text only. */}
          <span
            class="memory-row-reaffirm"
            x-show="event.summary.reaffirmCount > 0"
            x-text="'★ Reaffirmed ×' + event.summary.reaffirmCount"
            style={{
              fontFamily: tokens.font.mono,
              fontSize: 9.5,
              fontWeight: 600,
              color: tokens.color.amber,
            }}
          />
          {/* Provenance badge — shows HOW siltpoke learned this fact.
              Only rendered for semantic events that carry a known stream
              (user = hand-typed; commit = auto-learned; chat/etc = other paths).
              Seed/legacy facts (stream=null) show nothing — unlabeled is honest.
              Span defaults to inline → x-show is safe (no flex-display clobber). */}
          <span
            class="memory-row-stream"
            x-show="event.streamBadge"
            x-text="event.streamBadge"
            x-bind:style="{ color: event.streamBadgeColor }"
            style={{
              fontFamily: tokens.font.mono,
              fontSize: 9.5,
              fontWeight: 600,
            }}
          />
          {/* Kind badge — siltpoke's 🎯 style / 🪪 profile / ❓ untagged
              classification. CLICKABLE to re-tag (style↔profile; untagged→style):
              the click moves the critic's recall input (style facts shape
              critiques; profile facts stay chat-only). Fact rows only (kindBadge
              is null for episodic/procedural). Span = inline → x-show safe.
              Dashed pill border (currentColor, so it follows the kind colour)
              signals "click to re-tag" — the bare text read as a static label;
              the dashed outline distinguishes it from the solid-bordered Delete
              action and enlarges the otherwise tiny hit target. Border stays
              inline (no display:inline-block) so x-show's removeProperty('display')
              can't clobber it — same rationale as the Delete button above. */}
          <span
            class="memory-row-kind"
            x-show="event.kindBadge"
            x-text="event.kindBadge"
            x-bind:style="{ color: event.kindBadgeColor, borderColor: event.kindBadgeColor }"
            x-on:click="cycleFactKind(event)"
            x-bind:title="event.kind === 'style' ? 'style — shapes your code critiques. Click → profile' : event.kind === 'profile' ? 'profile — chat-only, kept out of code reviews. Click → style' : 'untagged. Click → style'"
            style={{
              fontFamily: tokens.font.mono,
              fontSize: 9.5,
              fontWeight: 600,
              cursor: "pointer",
              border: "1px dashed currentColor",
              borderRadius: tokens.radius.pill,
              padding: "1px 6px",
            }}
          />
        </div>
        {/* text body with inline code */}
        <div
          class="memory-row-text"
          style={{
            fontSize: 13,
            color: tokens.color.ink,
            fontFamily: tokens.font.body,
            lineHeight: 1.55,
          }}
        >
          <MemorySegs />
        </div>
        {/* why — always shown; honest muted fallback when no save_reason
            (e.g. facts captured before Change A recorded a reason). */}
        <div
          class="memory-row-why"
          style={{
            display: "flex",
            alignItems: "center",
            gap: "6px",
            marginTop: "10px",
            paddingTop: "9px",
            borderTop: `1px solid ${tokens.color.edge}`,
          }}
        >
          <span
            x-bind:style="{ color: event.typeColor }"
            style={{
              fontFamily: tokens.font.mono,
              fontSize: 10,
              flexShrink: 0,
            }}
          >
            Why
          </span>
          <span
            x-text="event.why !== null ? event.why : 'no source recorded (early memory)'"
            x-bind:style="event.why !== null ? { fontStyle: 'normal', color: '#8a7c64' } : { fontStyle: 'italic', color: '#a8997d' }"
            style={{ fontSize: 11, color: tokens.color.ink3 }}
          />
          {/* 详情展开▾/收起▴ toggle — right-aligned on the 为什么 row.
              Gate: hidden when logRows is empty (create-only fact).
              Shares the same Alpine `event` scope as the rail below.
              Morph-safe: x-on:click only. */}
          <button
            class="memory-action-log-toggle"
            type="button"
            x-show="event.logRows.length > 0"
            x-on:click="event.expanded = !event.expanded"
            x-bind:aria-expanded="event.expanded ? 'true' : 'false'"
            x-bind:aria-controls="'memory-log-' + event.id"
            x-text="event.expanded ? 'Collapse ▴' : 'Details ▾'"
            style={{
              marginLeft: "auto",
              fontFamily: tokens.font.mono,
              fontSize: 9.5,
              color: tokens.color.ink3,
              background: "transparent",
              border: "none",
              cursor: "pointer",
              padding: "0",
              lineHeight: 1,
            }}
          />
        </div>
        {/* Action-log footer — expandable rail
            (newest→oldest). Toggle moved to 为什么 row above.
            Supersede sub-lines rendered inside the log via logRow.isSupersede.
            Morph-safe (x-on:click). */}
        <MemoryActionLog />
      </div>
    </div>
  );
}
