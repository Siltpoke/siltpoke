// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
// Copyright (c) 2026 Jiaqi Duan
/** @jsxImportSource hono/jsx */
import { tokens } from "../tokens/tokens";
import type { ChatSession } from "../../memory/memory";

export interface WorkingMemoryPanelProps {
  recentChats: ChatSession[];
}

const LEGEND = [
  { color: tokens.color.sky, title: "Semantic · facts & knowledge", sub: "about the repo and your preferences" },
  { color: tokens.color.violet, title: "Episodic · things that happened", sub: "what it did, how you reacted" },
  { color: tokens.color.moss, title: "Procedural · learned rules", // "personality tuning in Settings" dropped 2026-08-06: /settings is unmounted, so the
    // sentence sent a reader on the live /memory page to a 404.
    sub: "how it does things" },
];

/**
 * Right-rail working-memory card + legend (记忆之书 mockup).
 *
 * Display-only, SSR-rendered OUTSIDE the memoryBook Alpine island — no edit /
 * forget controls, no buttons. The  list is fed by real recentChats
 * (sparse OK → honest empty state). There is no real source for an 
 * current-thought, so that sub-block is intentionally omitted rather than faked.
 */
export function WorkingMemoryPanel({ recentChats }: WorkingMemoryPanelProps) {
  return (
    <aside
      class="working-memory-panel"
      style={{
        width: "268px",
        flexShrink: 0,
        display: "flex",
        flexDirection: "column",
        gap: "14px",
      }}
    >
      {/* working memory card */}
      <div
        style={{
          // Gradient 2nd stop was `#f7edea` here — one hex unit off
          // MemoryByTypeCards.tsx's working card `#f6edea` — a typo, not a
          // design decision (classification finding). Folded into
          // `memWorkingGradient2`, shared by both files, like the border.
          background: `linear-gradient(165deg,${tokens.color.memCardBg},${tokens.color.memWorkingGradient2})`,
          border: `1px solid ${tokens.color.memWorkingBorder}`,
          borderRadius: "13px",
          padding: "15px",
          overflow: "hidden",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
          <span
            style={{
              width: "26px",
              height: "26px",
              borderRadius: "7px",
              background: tokens.color.terra,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              flexShrink: 0,
            }}
          >
            <svg aria-hidden="true" width="15" height="15" viewBox="0 0 16 16" fill="none">
              <path
                d="M3 5 C3 4 4 3.5 5 3.5 H11 C12 3.5 13 4 13 5 V9 C13 10 12 10.5 11 10.5 H7 L4 13 V10.5 C3.4 10.4 3 9.8 3 9 Z"
                style={{ stroke: tokens.color.onAccent }}
                stroke-width="1.3"
                fill="none"
                stroke-linejoin="round"
              />
            </svg>
          </span>
          <div style={{ flex: 1 }}>
            <div style={{ fontSize: 13.5, fontWeight: 700, color: tokens.color.ink }}>
              Working Memory
            </div>
            <div style={{ fontFamily: tokens.font.mono, fontSize: 8.5, color: tokens.color.memWorkingInk }}>
              WORKING · current state
            </div>
          </div>
          <span
            class="bk-pulse"
            style={{
              width: "8px",
              height: "8px",
              borderRadius: "50%",
              background: tokens.color.terra,
              flexShrink: 0,
            }}
          />
        </div>

        <div style={{ marginTop: "11px" }}>
          <div
            style={{
              fontSize: 10,
              color: tokens.color.mutedCaveat,
              fontFamily: tokens.font.mono,
              marginBottom: "7px",
            }}
          >
            Cross-chat recall · {recentChats.length}
          </div>
          {recentChats.length === 0 ? (
            <p
              class="working-memory-empty"
              style={{
                fontSize: 11.5,
                color: tokens.color.ink3,
                fontStyle: "italic",
                lineHeight: 1.45,
                margin: 0,
              }}
            >
              No chat history yet — recent conversations appear here after we talk
            </p>
          ) : (
            <div style={{ display: "flex", flexDirection: "column", gap: "7px" }}>
              {recentChats.map((session) => (
                <div
                  class="working-memory-chat-row"
                  style={{
                    display: "flex",
                    gap: "7px",
                    fontSize: 11.5,
                    color: tokens.color.ink2,
                    lineHeight: 1.45,
                  }}
                >
                  <span style={{ color: tokens.color.violet, flexShrink: 0 }}>↳</span>
                  <span
                    style={{
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                      whiteSpace: "nowrap",
                    }}
                  >
                    {session.summary || "—"}
                  </span>
                </div>
              ))}
            </div>
          )}
        </div>

        <div
          style={{
            marginTop: "11px",
            paddingTop: "10px",
            borderTop: `1px dashed ${tokens.color.memWorkingDivider}`,
            fontSize: 10.5,
            color: tokens.color.ink3,
            lineHeight: 1.5,
          }}
        >
          Short-term · cleared after chat —{" "}
          <b style={{ color: tokens.color.mutedCaveat }}>not written to the Memory Book</b>. Anything useful gets
          consolidated into semantic memory.
        </div>
      </div>

      {/* legend */}
      <div
        style={{
          background: tokens.color.memLegendBg,
          border: `1px solid ${tokens.color.paperD}`,
          borderRadius: "12px",
          padding: "13px 14px",
        }}
      >
        <div
          style={{
            fontFamily: tokens.font.mono,
            fontSize: 9.5,
            letterSpacing: "0.06em",
            color: tokens.color.ink3,
            textTransform: "uppercase",
            marginBottom: "10px",
          }}
        >
          The Memory Book holds three types
        </div>
        <div style={{ display: "flex", flexDirection: "column", gap: "9px" }}>
          {LEGEND.map((l) => (
            <div style={{ display: "flex", gap: "9px", alignItems: "flex-start" }}>
              <span
                style={{
                  width: "9px",
                  height: "9px",
                  borderRadius: "50%",
                  background: l.color,
                  marginTop: "3px",
                  flexShrink: 0,
                }}
              />
              <div>
                <div style={{ fontSize: 12, fontWeight: 600, color: tokens.color.ink }}>
                  {l.title}
                </div>
                <div style={{ fontSize: 10.5, color: tokens.color.mutedCaveat }}>{l.sub}</div>
              </div>
            </div>
          ))}
        </div>
      </div>
    </aside>
  );
}
