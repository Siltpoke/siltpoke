// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
// Copyright (c) 2026 Jiaqi Duan
/** @jsxImportSource hono/jsx */
import { tokens } from "../tokens/tokens";
import { MemorySegs } from "./MemoryAlpineRow";

/**
 * Modal overlay for the by-type drill-down.
 * Shown when modalType !== '' in x-data="memoryBook".
 *   - real types → list of that type's memories (newest-first).
 *   - working    → cross-chat recall (display-only, from recentChats).
 * ESC closes via x-on:keydown.escape.window (window survives hx-boost morph).
 */
export function MemoryModal() {
  return (
    <div
      class="memory-modal-backdrop"
      x-show="modalType !== ''"
      x-cloak
      {...{ "x-on:click.self": "closeModal()" }}
      {...{ "x-on:keydown.escape.window": "closeModal()" }}
      style={{
        position: "fixed",
        top: 0,
        left: 0,
        right: 0,
        bottom: 0,
        width: "100%",
        height: "100%",
        background: "rgba(31,27,22,0.42)",
        padding: "24px",
        overflowY: "auto",
        zIndex: 100,
      }}
    >
      <div
        class="memory-modal bk-rise"
        style={{
          width: "min(620px, 100%)",
          background: tokens.color.cream,
          border: `1px solid ${tokens.color.edge}`,
          borderRadius: "16px",
          boxShadow: tokens.shadow.lg,
          overflow: "hidden",
        }}
      >
        {/* accent bar */}
        <div x-bind:style="{ background: modalColor() }" style={{ height: "4px" }} />
        {/* header */}
        <div
          style={{
            display: "flex",
            alignItems: "flex-start",
            gap: "11px",
            padding: "18px 22px 15px",
            borderBottom: `1px solid ${tokens.color.paperD}`,
          }}
        >
          <div style={{ flex: 1 }}>
            <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
              <span
                class="memory-modal-title"
                x-text="modalTitle()"
                style={{ fontSize: 18, fontWeight: 700, color: tokens.color.ink }}
              />
              <span
                x-text="modalEn()"
                x-bind:style="{ color: modalColor(), border: '1px solid ' + modalColor() }"
                style={{
                  fontFamily: tokens.font.mono,
                  fontSize: 10,
                  borderRadius: tokens.radius.pill,
                  padding: "1px 7px",
                }}
              />
            </div>
            <div
              x-text="modalDesc()"
              style={{ fontSize: 12.5, color: tokens.color.ink3, marginTop: "3px" }}
            />
          </div>
          <button
            type="button"
            x-on:click="closeModal()"
            style={{
              background: "transparent",
              border: "none",
              cursor: "pointer",
              fontSize: 20,
              color: tokens.color.ink3,
              lineHeight: 1,
              padding: "2px 4px",
              flexShrink: 0,
            }}
          >
            ×
          </button>
        </div>

        {/* ── list view (real types) ── */}
        <div x-show="modalType !== 'working'">
          <div
            class="memory-modal-empty"
            x-show="memoriesForModal().length === 0"
            x-text="modalEmptyMessage()"
            style={{
              padding: "32px 22px",
              textAlign: "center",
              color: tokens.color.ink3,
              fontFamily: tokens.font.mono,
              fontSize: 12,
            }}
          />
          <div
            style={{
              maxHeight: "calc(100vh - 250px)",
              overflowY: "auto",
              padding: "15px 22px",
              display: "flex",
              flexDirection: "column",
              gap: "10px",
            }}
          >
            <template x-for="event in memoriesForModal()" x-bind:key="event.id">
              <div
                class="memory-modal-row"
                x-bind:style="{ background: event.cardBg, borderLeft: '3px solid ' + event.typeColor }"
                style={{
                  border: `1px solid ${tokens.color.paperD}`,
                  borderRadius: "10px",
                  padding: "11px 14px",
                }}
              >
                <div style={{ display: "flex", alignItems: "center", gap: "7px", marginBottom: "6px" }}>
                  <span
                    x-text="event.dateLabel"
                    style={{ fontFamily: tokens.font.mono, fontSize: 9.5, color: tokens.color.ink3 }}
                  />
                  {/* ★ 重申 ×N — reaffirmation badge (recall_count > 0). Inline
                      span → x-show display toggle is safe. Morph-safe. */}
                  <span
                    class="memory-modal-reaffirm"
                    x-show="event.summary.reaffirmCount > 0"
                    x-text="'★ Reaffirmed ×' + event.summary.reaffirmCount"
                    style={{
                      fontFamily: tokens.font.mono,
                      fontSize: 9.5,
                      fontWeight: 600,
                      color: tokens.color.amber,
                    }}
                  />
                  <span
                    x-text="event.statusLabel"
                    x-bind:style="{ color: event.statusInk, background: event.statusBg, border: '1px solid ' + event.statusBd }"
                    style={{
                      marginLeft: "auto",
                      fontFamily: tokens.font.mono,
                      fontSize: 9,
                      fontWeight: 600,
                      borderRadius: tokens.radius.pill,
                      padding: "1px 8px",
                    }}
                  />
                </div>
                <div
                  style={{
                    fontSize: 13.5,
                    color: tokens.color.ink,
                    fontFamily: tokens.font.body,
                    lineHeight: 1.5,
                    fontWeight: 500,
                  }}
                >
                  <MemorySegs />
                </div>
                {/* Supersede links intentionally NOT shown in the read-only modal —
                    the full 替代了/被替代 relationship lives in the timeline card's
                    expanded action-log (smoke 2026-06-26: avoid duplication). */}
              </div>
            </template>
          </div>
          <div
            style={{
              padding: "11px 22px 14px",
              borderTop: `1px solid ${tokens.color.paperD}`,
              fontSize: 11,
              color: tokens.color.ink3,
            }}
          >
            Active memories of this type · newest to oldest.
          </div>
        </div>

        {/* ── working view (cross-chat recall, display-only) ── */}
        <div x-show="modalType === 'working'">
          <div style={{ padding: "18px 22px" }}>
          <div
            style={{
              background: "#fffdf8",
              border: `1px solid ${tokens.color.paperD}`,
              borderLeft: "3px solid #9d86c2",
              borderRadius: "10px",
              padding: "13px 14px",
            }}
          >
            <div style={{ fontSize: 12, fontWeight: 600, color: tokens.color.ink, marginBottom: "8px" }}>
              Cross-chat recall · <span x-text="recentChats.length" />
            </div>
            <template x-if="recentChats.length === 0">
              <div style={{ fontSize: 12, color: tokens.color.ink3, fontStyle: "italic" }}>
                No cross-chat recall yet — after we talk more, this will remember what you mentioned.
              </div>
            </template>
            <div style={{ display: "flex", flexDirection: "column", gap: "7px" }}>
              <template x-for="chat in recentChats" x-bind:key="chat.started_at">
                <div style={{ fontSize: 12, color: tokens.color.ink2, display: "flex", gap: "7px" }}>
                  <span style={{ color: "#9d86c2", flexShrink: 0 }}>↳</span>
                  <span x-text="chat.summary" />
                </div>
              </template>
            </div>
          </div>
          </div>
          <div
            style={{
              padding: "11px 22px 14px",
              borderTop: `1px solid ${tokens.color.paperD}`,
              fontSize: 11,
              color: tokens.color.ink3,
              lineHeight: 1.5,
            }}
          >
            💡 Short-term · cleared after chat —{" "}
            <b style={{ color: "#9a8c74" }}>not written to the Memory Book</b>. Anything useful gets
            consolidated into semantic memory.
          </div>
        </div>
      </div>
    </div>
  );
}
