// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
// Copyright (c) 2026 Jiaqi Duan
/** @jsxImportSource hono/jsx */
/**
 * TamagotchiToy — Design A shell view.
 *
 * Egg-shaped pink-blush shell with inner LCD screen, 3 round action buttons,
 * and a color-swap picker below. Drives ?shell=<name> URL query for
 * color persistence across reloads.
 */
import { tokens } from "../tokens/tokens";
import { Creature } from "../creature/Creature";
import type { Species, Mood } from "../creature/parts";

export interface TamagotchiToyPet {
  name: string;
  species: Species;
  mood: Mood;
  level: number;
}

export interface TamagotchiToyData {
  pet: TamagotchiToyPet;
  hp: number;            // 0-10
  pendingCritiqueCount: number;
}

export interface TamagotchiToyProps {
  data: TamagotchiToyData;
  shellName?: string;   // "blush" default
}

interface ShellSpec {
  name: string;
  color: string;
}

const SHELLS: readonly ShellSpec[] = [
  { name: "blush",     color: "#f6c8c8" },
  { name: "butter",    color: "#f3dc8e" },
  { name: "sage",      color: "#b8c2a4" },
  { name: "sky",       color: "#a8c6dc" },
  { name: "lavender",  color: "#d4c5e8" },
  { name: "charcoal",  color: "#3a3530" },
];

function resolveShell(name: string | undefined): ShellSpec {
  return SHELLS.find((s) => s.name === name) ?? SHELLS[0]!;
}

function clockHHMM(now: Date = new Date()): string {
  const h = String(now.getHours()).padStart(2, "0");
  const m = String(now.getMinutes()).padStart(2, "0");
  return `${h}:${m}`;
}

function hpMeter(hp: number, total: number = 6): string {
  const filled = Math.max(0, Math.min(total, Math.round((hp / 10) * total)));
  return "▮".repeat(filled) + "▯".repeat(total - filled);
}

export function TamagotchiToy(props: TamagotchiToyProps) {
  const { data, shellName } = props;
  const shell = resolveShell(shellName);
  const now = clockHHMM();
  const hpDisplay = hpMeter(data.hp);
  const showCritique = data.pendingCritiqueCount > 0;

  return (
    <div
      class="tamagotchi-toy"
      style={{
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        gap: 16,
        padding: 24,
        boxSizing: "border-box",
        width: "100%",
        minHeight: "100%",
      }}
    >
      {/* Top dome */}
      <div
        class="tamagotchi-toy__dome"
        style={{
          width: 14,
          height: 14,
          borderRadius: "50%",
          background: tokens.color.ink,
          opacity: 0.7,
        }}
      />

      {/* Shell oval */}
      <div
        class="tamagotchi-toy__shell"
        data-shell={shell.name}
        style={{
          width: 320,
          minHeight: 460,
          background: shell.color,
          borderRadius: "160px 160px 200px 200px / 220px 220px 260px 260px",
          padding: "32px 28px 36px",
          boxSizing: "border-box",
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          gap: 16,
          boxShadow: "0 8px 24px rgba(31,27,22,0.18), inset 0 1px 0 rgba(255,255,255,0.4)",
        }}
      >
        {/* Header strip */}
        <div
          class="tamagotchi-toy__header"
          style={{
            fontFamily: tokens.font.mono,
            fontSize: 9,
            letterSpacing: "0.1em",
            textTransform: "uppercase",
            color: tokens.color.ink2,
            opacity: 0.7,
          }}
        >
          siltpoke · v0.4.1
        </div>

        {/* LCD screen */}
        <div
          class="tamagotchi-toy__lcd"
          style={{
            width: "100%",
            minHeight: 200,
            background: tokens.color.lcd,
            color: tokens.color.lcdInk,
            border: `2px solid ${tokens.color.ink}`,
            borderRadius: 8,
            padding: "10px 12px",
            display: "flex",
            flexDirection: "column",
            justifyContent: "space-between",
            fontFamily: tokens.font.mono,
            fontSize: 11,
            position: "relative",
          }}
        >
          {/* Top row: hp + level + spend + fix-it pill */}
          <div
            class="tamagotchi-toy__lcd-top"
            style={{
              display: "flex",
              justifyContent: "space-between",
              alignItems: "center",
              gap: 6,
              fontSize: 10,
            }}
          >
            <span style={{ display: "inline-flex", alignItems: "center", gap: 4 }}>
              <span>♥</span>
              <span style={{ letterSpacing: "0.06em" }}>{hpDisplay}</span>
            </span>
            <span>L{data.pet.level}</span>
            <span>$0.42</span>
            {showCritique && (
              <span
                class="tamagotchi-toy__fix-it"
                style={{
                  background: tokens.color.cream,
                  color: tokens.color.terra,
                  border: `1px solid ${tokens.color.terra}`,
                  borderRadius: tokens.radius.sm,
                  padding: "1px 5px",
                  fontSize: 9,
                  fontFamily: tokens.font.mono,
                }}
              >
                fix it!
              </span>
            )}
          </div>

          {/* Creature face center */}
          <div
            class="tamagotchi-toy__creature"
            style={{
              flex: 1,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              padding: "16px 0",
            }}
          >
            <Creature
              species={data.pet.species}
              mood={data.pet.mood}
              stage="adult"
              cell={8}
            />
          </div>

          {/* Bottom row: name + clock */}
          <div
            class="tamagotchi-toy__lcd-bottom"
            style={{
              display: "flex",
              justifyContent: "space-between",
              alignItems: "center",
              fontSize: 9,
              letterSpacing: "0.06em",
            }}
          >
            <span>{data.pet.name.toLowerCase()}</span>
            <span>{now}</span>
          </div>
        </div>

        {/* 3 round action buttons */}
        <div
          class="tamagotchi-toy__buttons"
          style={{
            display: "flex",
            justifyContent: "space-around",
            alignItems: "flex-start",
            width: "100%",
            gap: 16,
            marginTop: 8,
          }}
        >
          {[
            { letter: "A", action: "feed",  label: "feed",  bg: tokens.color.terra },
            { letter: "B", action: "play",  label: "play",  bg: tokens.color.amber },
            { letter: "C", action: "tease", label: "scold", bg: tokens.color.terra },
          ].map((b) => (
            <div
              key={b.action}
              style={{
                display: "flex",
                flexDirection: "column",
                alignItems: "center",
                gap: 4,
              }}
            >
              <button
                class="tamagotchi-toy__button"
                data-action={b.action}
                hx-post="/api/action"
                hx-vals={JSON.stringify({ action: b.action })}
                hx-swap="none"
                type="button"
                style={{
                  width: 44,
                  height: 44,
                  borderRadius: "50%",
                  background: b.bg,
                  color: tokens.color.cream,
                  border: "none",
                  fontFamily: tokens.font.mono,
                  fontSize: 14,
                  fontWeight: 700,
                  cursor: "pointer",
                  boxShadow: "0 2px 4px rgba(31,27,22,0.25), inset 0 -2px 0 rgba(0,0,0,0.15)",
                }}
              >
                {b.letter}
              </button>
              <span
                style={{
                  fontFamily: tokens.font.mono,
                  fontSize: 10,
                  color: tokens.color.ink2,
                }}
              >
                {b.label}
              </span>
            </div>
          ))}
        </div>
      </div>

      {/* Shell color picker */}
      <div
        class="tamagotchi-toy__shell-picker"
        style={{
          display: "flex",
          alignItems: "center",
          gap: 12,
          marginTop: 8,
        }}
      >
        <span
          style={{
            fontFamily: tokens.font.mono,
            fontSize: 10,
            color: tokens.color.ink3,
            letterSpacing: "0.1em",
            textTransform: "uppercase",
          }}
        >
          shell
        </span>
        <div style={{ display: "inline-flex", gap: 6 }}>
          {SHELLS.map((s) => {
            const isActive = s.name === shell.name;
            return (
              <a
                key={s.name}
                href={`?view=toy&shell=${s.name}`}
                class="tamagotchi-toy__swatch"
                data-shell={s.name}
                title={s.name}
                style={{
                  width: 22,
                  height: 22,
                  borderRadius: "50%",
                  background: s.color,
                  border: isActive
                    ? `2px solid ${tokens.color.ink}`
                    : `1px solid ${tokens.color.edge}`,
                  display: "inline-block",
                  cursor: "pointer",
                  boxSizing: "border-box",
                }}
              />
            );
          })}
        </div>
        <span
          style={{
            fontFamily: tokens.font.mono,
            fontSize: 11,
            color: tokens.color.ink2,
          }}
        >
          {shell.name}
        </span>
      </div>
    </div>
  );
}
