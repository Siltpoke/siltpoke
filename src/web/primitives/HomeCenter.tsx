// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Copyright (c) 2026 Jiaqi Duan
/** @jsxImportSource hono/jsx */
/**
 * Design D — HomeCenter primitive.
 *
 * Dotted-grid middle panel of the Home dashboard: status pills + creature
 * + greeting + chips. Toy view + ViewToggle dropped (TamagotchiToy still
 * exported separately for a future re-enable).
 *
 * Keeps <section id="hero"> for HTMX swap target back-compat.
 */
import { tokens } from "../tokens/tokens";
import { Creature } from "../creature/Creature";
import { ActionChip } from "../atoms/ActionChip";
import type { Species, Mood } from "../creature/parts";

export interface HomeCenterPet {
  name: string;
  species: Species;
  mood: Mood;
  level: number;
}

/** Kept for back-compat with callers (Home.tsx). Unused in render today. */
export interface HomeCenterToyData {
  pet: HomeCenterPet;
  hp: number;
  pendingCritiqueCount: number;
}

export interface HomeCenterProps {
  pet: HomeCenterPet;
  statusLabels: { left: string; right: string };
  /** Kept for back-compat — only "dashboard" renders today. */
  view?: "dashboard" | "toy";
  greeting: string;
  tagline: string;
  /** Accepted for back-compat, ignored — toy view is disabled. */
  toyData?: HomeCenterToyData;
  shellName?: string;
}

const statusPillStyle = {
  display: "inline-flex",
  padding: "4px 10px",
  border: `1px solid ${tokens.color.edge}`,
  borderRadius: tokens.radius.pill,
  background: tokens.color.cream,
  fontFamily: tokens.font.mono,
  fontSize: 11,
  color: tokens.color.ink2,
} as const;

export function HomeCenter(props: HomeCenterProps) {
  const { pet, statusLabels, greeting, tagline } = props;

  return (
    <section
      id="hero"
      class="home-center"
      style={{
        position: "relative",
        border: `1px solid ${tokens.color.edge}`,
        borderRadius: tokens.radius.md,
        background: tokens.color.cream,
        backgroundImage: `radial-gradient(circle, ${tokens.color.edge} 1px, transparent 1px)`,
        backgroundSize: "8px 8px",
        display: "flex",
        flexDirection: "column",
        flex: 1,
        minHeight: 480,
      }}
    >
      {/* Top row — status pills only. Toy view + ViewToggle dropped (kept
          the component for a future re-enable). */}
      <div
        class="home-center__top"
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          padding: "12px",
        }}
      >
        <div
          class="home-center__status-pills"
          style={{ display: "flex", gap: 6 }}
        >
          <span class="home-center__pill-left" style={statusPillStyle}>
            {statusLabels.left}
          </span>
          <span class="home-center__pill-right" style={statusPillStyle}>
            {statusLabels.right}
          </span>
        </div>
      </div>

      {/* Creature — large ASCII face w/ float animation + ground shadow.
          data-mood drives the CSS rule that pauses float + shadow pulse
          when the pet is asleep — looks weird to have an idle shadow
          throbbing under a motionless sprite. */}
          <div
            class="home-center__creature"
            data-mood={pet.mood}
            style={{
              flex: 1,
              display: "flex",
              flexDirection: "column",
              alignItems: "center",
              justifyContent: "center",
              gap: 80,
              position: "relative",
            }}
          >
            <div class="pet-float">
              <Creature species={pet.species} mood={pet.mood} stage="adult" cell={12} />
            </div>
            <div
              class="pet-shadow"
              aria-hidden="true"
              style={{
                width: 120,
                height: 14,
                borderRadius: "50%",
                background: tokens.color.ink,
                filter: "blur(6px)",
              }}
            />
          </div>

          {/* Bottom row: greeting + tagline (left) + chip row (right) */}
          <div
            class="home-center__bottom"
            style={{
              display: "flex",
              justifyContent: "space-between",
              alignItems: "flex-end",
              padding: "12px 16px 16px",
              gap: tokens.space["3"],
            }}
          >
            <div class="home-center__greeting" style={{ display: "flex", flexDirection: "column", gap: 4 }}>
              <span
                style={{
                  fontFamily: tokens.font.display,
                  fontSize: 38,
                  color: tokens.color.ink,
                  lineHeight: 1,
                }}
              >
                {greeting}
              </span>
              <span
                style={{
                  fontFamily: tokens.font.body,
                  fontSize: 12,
                  color: tokens.color.ink2,
                  lineHeight: 1.4,
                  maxWidth: 240,
                  whiteSpace: "pre-wrap",
                }}
              >
                {tagline}
              </span>
            </div>

            <div
              class="home-center__chips"
              style={{
                display: "flex",
                alignItems: "center",
                gap: tokens.space["2"],
                flexWrap: "wrap",
                justifyContent: "flex-end",
              }}
            >
              <ActionChip action="feed"  label="feed"  keyCap="F" />
              <ActionChip action="play"  label="play"  keyCap="P" />
              <ActionChip action="clean" label="clean" keyCap="C" />
              <ActionChip action="pet"   label="pet"   keyCap="E" />
              <ActionChip action="sleep" label="sleep" keyCap="Z" />
              <ActionChip action="tease" label="tease" keyCap="T" />
            </div>
          </div>
    </section>
  );
}
