// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
// Copyright (c) 2026 Jiaqi Duan
/** @jsxImportSource hono/jsx */
import { tokens } from "../tokens/tokens";

/**
 * Verb + glyph labels per FactEvent action type.
 * Exported so the island wiring can re-use the same labels without drift.
 * Also embedded inline in the Alpine x-text expression for the expanded rail.
 * 'created' kept for forward-compat even though created rows are omitted.
 */
export const ACTION_LABELS: Record<string, string> = {
  created: "🌱 Created",
  approved: "✓ Activated",
  reaffirmed: "★ Reaffirmed",
  retired: "○ Retired",
  reactivated: "↺ Reactivated",
};

// Inline Alpine expression for glyph + verb lookup in the expanded rail.
// Falls back to logRow.action if action is unexpected (future-proofing).
const ACTION_LABEL_EXPR =
  "({created:'🌱 Created',approved:'✓ Activated',reaffirmed:'★ Reaffirmed',retired:'○ Retired',reactivated:'↺ Reactivated'})[logRow.action] || logRow.action";

// Inline Alpine expression for the supersede sub-line x-text.
const SUPERSEDE_LABEL_EXPR =
  "(logRow.supersedeType === 'supersedes' ? '⇄ Supersedes' : '↩ Superseded') + " +
  "'「' + (logRow.supersedeText || '') + '」'";

/**
 * MemoryActionLog — SSR primitive for the per-fact action-log footer.
 *
 * Collapsed (default): nothing rendered — the 「详情展开▾」 toggle button now lives
 *   on the `.memory-row-why` row in MemoryAlpineRow (right-aligned). This
 *   component only renders the expandable rail; Alpine `event.expanded` is set by
 *   the toggle in the enclosing x-for scope and read by the rail here.
 *
 * Expanded (x-show="event.expanded"):
 *   Vertical rail, newest→oldest. One row per event:
 *     「<verb> — <YYYY-MM-DD HH:mm>」
 *   The 创建 row is OMITTED — its time lives on the timeline-axis gutter.
 *   Reaffirms: individual rows per event; ★重申 ×N for legacy (no timestamps).
 *   Supersede sub-lines: ⇄/↩ button injected by injectSupersedeRows,
 *   recognized by logRow.isSupersede flag; click jumpToFact(logRow.supersedeId).
 *
 * Data contract (island wiring must provide per event):
 *   event.logRows  — LogRow[] from decorateRow; may include supersede sub-rows
 *   event.expanded — boolean toggle
 *   event.id       — from the outer x-for loop in MemoryAlpineRow
 *
 * Morph-safe: all handlers via x-on:click — no addEventListener.
 * Accessible: aria-expanded + aria-controls on the toggle button.
 */
export function MemoryActionLog() {
  return (
    <div class="memory-action-log">
      {/* ── Expanded timeline rail ────────────────────────────
          x-show hides/shows without DOM removal (morph-safe).
          id is dynamic (x-bind) so aria-controls on the toggle resolves. */}
      <div
        class="memory-action-log-rail"
        x-show="event.expanded"
        x-bind:id="'memory-log-' + event.id"
        style={{
          marginTop: "6px",
          paddingLeft: "10px",
          borderLeft: `2px solid ${tokens.color.edge}`,
          overflow: "hidden",
        }}
      >
        {/* x-for iterates LogRow[] (newest→oldest) from decorateRow.
            Each item is a timed event OR a supersede sub-row (isSupersede).
            Key: id + action + dateLabel + supersedeType to survive morph. */}
        <template
          x-for="logRow in event.logRows"
          x-bind:key="event.id + ':' + logRow.action + ':' + logRow.dateLabel + ':' + (logRow.supersedeType || '')"
        >
          <div>
            {/* ── Timed event row (visible when NOT a supersede sub-row) ───── */}
            <div
              class="memory-action-log-event"
              x-show="!logRow.isSupersede"
              style={{
                display: "flex",
                alignItems: "baseline",
                gap: "4px",
                padding: "2px 0",
                fontFamily: tokens.font.mono,
                fontSize: 9.5,
              }}
            >
              {/* Glyph + past-tense verb */}
              <span
                class="memory-action-log-verb"
                x-text={ACTION_LABEL_EXPR}
                style={{
                  color: tokens.color.ink2,
                  flexShrink: 0,
                }}
              />
              {/* Separator + date+time label; omit separator when dateLabel is '' */}
              <span
                class="memory-action-log-event-date"
                x-text="logRow.dateLabel ? ' — ' + logRow.dateLabel : ''"
                style={{
                  color: tokens.color.ink3,
                }}
              />
            </div>

            {/* ── Supersede sub-line: ⇄ 替代了 or ↩ 被替代 ─────────────
                Indented, keyboard-accessible button. Click jumpToFact.
                Hover title = full partner text. Display truncated ~40 chars. */}
            <button
              class="memory-action-log-supersede-link"
              type="button"
              x-show="logRow.isSupersede"
              x-on:click="jumpToFact(logRow.supersedeId)"
              x-bind:title="logRow.supersedeText || ''"
              x-text={SUPERSEDE_LABEL_EXPR}
              style={{
                display: "block",
                background: "none",
                border: "none",
                padding: "2px 0 2px 12px",
                textAlign: "left",
                cursor: "pointer",
                fontFamily: tokens.font.mono,
                fontSize: 9.5,
                fontWeight: 500,
                color: "#5a86a0",
                textDecoration: "underline",
                textUnderlineOffset: "2px",
                textDecorationStyle: "dotted",
              }}
            />
          </div>
        </template>
      </div>
    </div>
  );
}
