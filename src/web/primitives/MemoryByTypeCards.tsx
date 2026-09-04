// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
// Copyright (c) 2026 Jiaqi Duan
/** @jsxImportSource hono/jsx */
import type { Child } from "hono/jsx";
import { tokens } from "../tokens/tokens";
import { MemorySegs } from "./MemoryAlpineRow";

interface CardCfg {
  type: "semantic" | "episodic" | "procedural" | "working";
  title: string;
  en: string;
  color: string;
  gradient: string;
  border: string;
  enColor: string;
  footerDivider: string;
  /** Alpine expr → big count number. */
  countExpr: string;
  unit: string;
  footer: string;
  icon: Child;
}

const ICON: Record<string, Child> = {
  semantic: (
    <svg aria-hidden="true" width="17" height="17" viewBox="0 0 16 16" fill="none">
      <circle cx="5" cy="5" r="2.2" style={{ stroke: tokens.color.onAccent }} stroke-width="1.3" />
      <circle cx="11" cy="7" r="1.8" style={{ stroke: tokens.color.onAccent }} stroke-width="1.3" />
      <circle cx="6.5" cy="11" r="1.8" style={{ stroke: tokens.color.onAccent }} stroke-width="1.3" />
      <path d="M6.7 5.6 L9.4 6.6 M6.3 9.4 L9.8 8" style={{ stroke: tokens.color.onAccent }} stroke-width="1.2" />
    </svg>
  ),
  episodic: (
    <svg aria-hidden="true" width="17" height="17" viewBox="0 0 16 16" fill="none">
      <path
        d="M4 3 V13 M4 4.5 H11 L9.4 6.2 L11 8 H4"
        style={{ stroke: tokens.color.onAccent }}
        stroke-width="1.3"
        stroke-linejoin="round"
        fill="none"
      />
    </svg>
  ),
  procedural: (
    <svg aria-hidden="true" width="17" height="17" viewBox="0 0 16 16" fill="none">
      <path d="M3 5 H9 M3 8 H13 M3 11 H7" style={{ stroke: tokens.color.onAccent }} stroke-width="1.4" stroke-linecap="round" />
      <circle cx="11.5" cy="5" r="1.5" style={{ stroke: tokens.color.onAccent }} stroke-width="1.3" />
    </svg>
  ),
  working: (
    <svg aria-hidden="true" width="17" height="17" viewBox="0 0 16 16" fill="none">
      <path
        d="M3 5 C3 4 4 3.5 5 3.5 H11 C12 3.5 13 4 13 5 V9 C13 10 12 10.5 11 10.5 H7 L4 13 V10.5 C3.4 10.4 3 9.8 3 9 Z"
        style={{ stroke: tokens.color.onAccent }}
        stroke-width="1.3"
        fill="none"
        stroke-linejoin="round"
      />
    </svg>
  ),
};

// footerDivider: memory-book-helpers.ts's TYPE_META is silent on this role
// (it's a MemoryByTypeCards-only concern), so unlike color/enColor there is
// no separate "canonical file" to defer to here — all four cards now share
// ONE derivation (color-mix of the card's own accent into `paper`, matching
// the semantic card's pre-existing `tokens.color.paperD` treatment in
// spirit). Before this change, semantic alone used the real `paperD` token
// while episodic/procedural/working each carried a hand-picked near-white
// literal (`#ece4ee`/`#e6ecdd`/`#efe0dc`) — a latent inconsistency the
// classification flagged (3 of 4 types silently diverged from the one that
// already used the token system).
const CARDS: CardCfg[] = [
  {
    type: "semantic",
    title: "Semantic Memory",
    en: "SEMANTIC · facts & knowledge",
    color: tokens.color.sky,
    gradient: `linear-gradient(165deg,${tokens.color.memCardBg},${tokens.color.memTypeGradient2Semantic})`,
    // A color-mix(sky, paper) derivation was tried first and rejected —
    // even the best-fit weight visibly shifted the border's hue (review
    // round 1, Important 6). `memTypeBorderSemantic` is the literal
    // `#cdd9e0` already live today, given a dark counterpart instead.
    border: tokens.color.memTypeBorderSemantic,
    enColor: tokens.color.memTypeInkSemantic,
    footerDivider: "color-mix(in srgb, var(--color-sky) 20%, var(--color-paper))",
    countExpr: "countActiveByType('semantic')",
    unit: "facts",
    footer: "Open this type →",
    icon: ICON.semantic,
  },
  {
    type: "episodic",
    title: "Episodic Memory",
    en: "EPISODIC · things that happened",
    color: tokens.color.violet,
    // 1st gradient stop was `#fffdf9` here — one hex unit off the other
    // three cards' `#fffdf8` — a typo, not a design decision (classification
    // finding). Folded into `memCardBg` like its siblings.
    gradient: `linear-gradient(165deg,${tokens.color.memCardBg},${tokens.color.memTypeGradient2Episodic})`,
    // Same rejection as the semantic card's border above — even the
    // best-fit color-mix(violet, paper) weight lost the lavender cast for a
    // grey one (`#ddd2d7` vs the real `#ddd0e2`). `memTypeBorderEpisodic` is
    // the literal already live today.
    border: tokens.color.memTypeBorderEpisodic,
    enColor: tokens.color.memTypeInkEpisodic,
    footerDivider: "color-mix(in srgb, var(--color-violet) 20%, var(--color-paper))",
    countExpr: "countActiveByType('episodic')",
    unit: "interactions",
    footer: "Open this type →",
    icon: ICON.episodic,
  },
  {
    type: "procedural",
    title: "Procedural Memory",
    en: "PROCEDURAL · learned rules",
    color: tokens.color.moss,
    gradient: `linear-gradient(165deg,${tokens.color.memCardBg},${tokens.color.memTypeGradient2Procedural})`,
    // Same rejection as its siblings above — `memTypeBorderProcedural` is
    // the literal `#d2dcc6` already live today.
    border: tokens.color.memTypeBorderProcedural,
    // Consolidates a 3-way drift the classification found: this file had
    // `#6f8a54`, MemoryFilterBar.tsx independently had the same `#6f8a54`,
    // and memory-book-helpers.ts (TYPE_META's canonical source) had a THIRD
    // value, `#5e7048`. All three now defer to the canonical file's value.
    enColor: tokens.color.memTypeInkProcedural,
    footerDivider: "color-mix(in srgb, var(--color-moss) 20%, var(--color-paper))",
    countExpr: "countActiveByType('procedural')",
    unit: "rules",
    footer: "Open this type →",
    icon: ICON.procedural,
  },
  {
    type: "working",
    title: "Working Memory",
    en: "WORKING · short-term + recall",
    color: tokens.color.terra,
    gradient: `linear-gradient(165deg,${tokens.color.memCardBg},${tokens.color.memWorkingGradient2})`,
    border: tokens.color.memWorkingBorder,
    enColor: tokens.color.memWorkingInk,
    footerDivider: "color-mix(in srgb, var(--color-terra) 20%, var(--color-paper))",
    countExpr: "workingCount",
    unit: "cross-chat recalls",
    footer: "See current state →",
    icon: ICON.working,
  },
];

function SampleItems(cfg: CardCfg) {
  if (cfg.type === "working") {
    return (
      <div style={{ display: "flex", flexDirection: "column", gap: "6px", minHeight: "50px" }}>
        <template x-if="recentChats.length === 0">
          <div style={{ fontSize: 12, color: tokens.color.ink3, fontStyle: "italic" }}>
            No cross-chat recall yet — appears here after a few chats
          </div>
        </template>
        <template x-for="chat in recentChats.slice(0, 2)" x-bind:key="chat.started_at">
          <div style={{ display: "flex", alignItems: "center", gap: "7px", fontSize: 12, color: tokens.color.memSampleInk }}>
            <span style={{ width: "6px", height: "6px", borderRadius: "50%", background: tokens.color.violet, flexShrink: 0 }} />
            <span
              x-text="chat.summary"
              style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}
            />
          </div>
        </template>
      </div>
    );
  }
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "6px", minHeight: "50px" }}>
      <template x-if={`samples('${cfg.type}').length === 0`}>
        <div style={{ fontSize: 12, color: tokens.color.ink3, fontStyle: "italic" }}>
          This type is empty
        </div>
      </template>
      <template x-for={`event in samples('${cfg.type}')`} x-bind:key="event.id">
        <div style={{ display: "flex", alignItems: "center", gap: "7px", fontSize: 12, color: tokens.color.memSampleInk }}>
          <span
            x-bind:style="{ background: event.typeColor }"
            style={{ width: "6px", height: "6px", borderRadius: "50%", flexShrink: 0 }}
          />
          <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
            <MemorySegs />
          </span>
        </div>
      </template>
    </div>
  );
}

/**
 * By-type view — 2×2 grid of gradient cards (语义/情景/程序/工作). Clicking a
 * card opens the modal. The working card pulses + counts cross-chat recall.
 * Counts driven by the ancestor x-data="memoryBook" scope.
 */
export function MemoryByTypeCards() {
  return (
    <div>
      <div
        style={{
          fontSize: 12,
          color: tokens.color.ink3,
          lineHeight: 1.5,
          marginBottom: "14px",
        }}
      >
        Four windows by memory type — open any one to see all memories of that type in a modal.
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "14px" }}>
        {CARDS.map((cfg) => (
          <div
            key={cfg.type}
            class={`memory-type-card memory-type-card-${cfg.type} bk-card`}
            x-on:click={`openModal('${cfg.type}')`}
            style={{
              position: "relative",
              background: cfg.gradient,
              border: `1px solid ${cfg.border}`,
              borderRadius: "14px",
              padding: "17px",
              cursor: "pointer",
              overflow: "hidden",
            }}
          >
            <span
              style={{
                position: "absolute",
                left: 0,
                top: 0,
                bottom: 0,
                width: "4px",
                background: cfg.color,
              }}
            />
            {/* header */}
            <div style={{ display: "flex", alignItems: "center", gap: "10px" }}>
              <span
                style={{
                  width: "30px",
                  height: "30px",
                  borderRadius: "8px",
                  background: cfg.color,
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  flexShrink: 0,
                }}
              >
                {cfg.icon}
              </span>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 15, fontWeight: 700, color: tokens.color.ink }}>
                  {cfg.title}
                </div>
                <div
                  style={{
                    fontFamily: tokens.font.mono,
                    fontSize: 8.5,
                    letterSpacing: "0.5px",
                    color: cfg.enColor,
                  }}
                >
                  {cfg.en}
                </div>
              </div>
              {cfg.type === "working" ? (
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
              ) : (
                <span
                  style={{
                    fontFamily: tokens.font.mono,
                    fontSize: 9,
                    fontWeight: 600,
                    color: tokens.color.memStatusActiveInk,
                    flexShrink: 0,
                  }}
                >
                  ● lit
                </span>
              )}
            </div>
            {/* big count */}
            <div style={{ display: "flex", alignItems: "baseline", gap: "6px", margin: "13px 0 11px" }}>
              <span
                x-text={cfg.countExpr}
                style={{
                  fontFamily: tokens.font.display,
                  fontSize: 30,
                  fontWeight: 600,
                  color: tokens.color.ink,
                  lineHeight: 0.9,
                }}
              >
                0
              </span>
              <span style={{ fontSize: 11.5, color: tokens.color.ink3 }}>{cfg.unit}</span>
            </div>
            {SampleItems(cfg)}
            {/* footer */}
            <div
              style={{
                marginTop: "11px",
                borderTop: `1px solid ${cfg.footerDivider}`,
                paddingTop: "10px",
                fontSize: 11.5,
                fontWeight: 600,
                color: cfg.enColor,
              }}
            >
              {cfg.footer}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
