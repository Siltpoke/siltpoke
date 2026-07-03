// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Copyright (c) 2026 Jiaqi Duan
/** @jsxImportSource hono/jsx */
/**
 * Hero primitive.
 *
 * SSR section anchoring <section id="hero"> — the HTMX outerHTML swap
 * target for POST /api/action responses. Renders:
 *   - Mood-conditioned greeting
 *   - Tagline (level + species)
 *   - ASCII creature face (Creature component)
 *   - 3 ActionChip buttons (feed / play / pet)
 *
 * The `id="hero"` attribute is CRITICAL — hx-target="#hero" in ActionChip
 * references this exact element for the outerHTML swap on action responses.
 */
import { tokens } from "../tokens/tokens";
import { Creature } from "../creature/Creature";
import { ActionChip } from "../atoms/ActionChip";
import type { Species, Mood } from "../creature/parts";

export interface HeroProgression {
  xp: number;
  xp_to_next: number;
}

export interface HeroPetProps {
  name: string;
  species: Species;
  mood: Mood;
  level: number;
}

export interface HeroProps {
  pet: HeroPetProps;
  progression?: HeroProgression;
}

const MOOD_GREETINGS: Partial<Record<Mood, string>> = {
  happy: "hi! ✨",
  sad: "…hi.",
  sleepy: "hi~ zz",
  hungry: "hi. (hungry)",
};

function greeting(mood: Mood): string {
  return MOOD_GREETINGS[mood] ?? "hi.";
}

/**
 * Hero section — full-bleed creature + action chip row.
 *
 * `<section id="hero">` is the HTMX outerHTML swap target; the server
 * re-renders this entire section after each feed/play/pet action and
 * returns it as a text/html fragment.
 */
export function Hero(props: HeroProps) {
  const { pet, progression } = props;
  const { name, species, mood, level } = pet;

  return (
    <section
      id="hero"
      class="hero"
      style={{
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        gap: tokens.space["4"],
        padding: `${tokens.space["6"]} ${tokens.space["4"]}`,
      }}
    >
      {/* Greeting */}
      <div
        class="hero__greeting"
        style={{
          fontFamily: tokens.font.display,
          fontSize: 22,
          color: tokens.color.ink,
          letterSpacing: -0.3,
        }}
      >
        {greeting(mood)}
      </div>

      {/* Tagline */}
      <div
        class="hero__tagline"
        style={{
          fontFamily: tokens.font.mono,
          fontSize: 11,
          color: tokens.color.ink3,
          letterSpacing: 0.3,
        }}
      >
        {`L${level} ${species} · ${name}`}
      </div>

      {/* Creature face */}
      <div class="hero__creature">
        <Creature species={species} mood={mood} stage="adult" cell={12} />
      </div>

      {/* XP bar (optional) */}
      {progression && (
        <div
          class="hero__xp"
          style={{
            width: "100%",
            maxWidth: 220,
            height: 4,
            background: tokens.color.paperD,
            borderRadius: tokens.radius.pill,
            overflow: "hidden",
          }}
        >
          <div
            class="hero__xp-fill"
            style={{
              height: "100%",
              width: `${Math.min(100, Math.round((progression.xp / progression.xp_to_next) * 100))}%`,
              background: tokens.color.moss,
              borderRadius: tokens.radius.pill,
            }}
          />
        </div>
      )}

      {/* Action chip row */}
      <div
        class="hero__chips"
        style={{
          display: "flex",
          alignItems: "center",
          gap: tokens.space["2"],
          flexWrap: "wrap",
          justifyContent: "center",
        }}
      >
        <ActionChip action="feed" label="feed" icon="🍖" />
        <ActionChip action="play" label="play" icon="🎾" />
        <ActionChip action="pet" label="pet" icon="✋" />
      </div>
    </section>
  );
}
