// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
// Copyright (c) 2026 Jiaqi Duan
/** @jsxImportSource hono/jsx */
import type { PreviewStory } from "../routes/preview";
import { tokens } from "../tokens/tokens";
import { RetroDevice } from "./RetroDevice";
import { Creature } from "../creature/Creature";

/**
 * Canonical LCD interior — ports the layout from tamagotchi-toy.html
 * verbatim. Flex column with `justify-content: space-between`, padding 8
 * (already on the LCD wrapper), three rows: stats, creature + speech
 * bubble, footer.
 */
function StatuslineMock() {
  return (
    <div
      style={{
        height: "100%",
        display: "flex",
        flexDirection: "column",
        justifyContent: "space-between",
      }}
    >
      {/* top stats — heart + XP bar / level / balance */}
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          fontFamily: tokens.font.display,
          fontSize: 11,
          fontWeight: 700,
          color: tokens.color.lcdInk,
        }}
      >
        <span>♥ ████░</span>
        <span>L12</span>
        <span>$0.42</span>
      </div>

      {/* creature + speech bubble */}
      <div
        style={{
          display: "flex",
          justifyContent: "center",
          flex: 1,
          alignItems: "center",
          position: "relative",
        }}
      >
        <Creature
          species="cat"
          mood="happy"
          stage="juvenile"
          cell={5}
          color={tokens.color.lcdInk}
        />
        <span
          style={{
            position: "absolute",
            top: 0,
            right: -2,
            background: tokens.color.cream,
            padding: "3px 6px",
            border: `2px solid ${tokens.color.ink}`,
            fontFamily: tokens.font.display,
            fontSize: 10,
            color: tokens.color.ink,
            fontWeight: 600,
            borderRadius: 4,
          }}
        >
          fix it!
        </span>
      </div>

      {/* footer — name + clock */}
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          fontFamily: tokens.font.display,
          fontSize: 10,
          fontWeight: 700,
          color: tokens.color.lcdInk,
        }}
      >
        <span>siltpoke</span>
        <span>14:32</span>
      </div>
    </div>
  );
}

/**
 * Shell color picker — pill-shaped pickle with backdrop blur + radial-
 * gradient swatches. Mirrors tamagotchi-toy.html canonical.
 */
const SHELL_SWATCHES = [
  { id: "blush", top: tokens.color.egg, bot: tokens.color.egg2 },
  { id: "mint", top: "#cde8c7", bot: "#8eb89c" },
  { id: "sun", top: "#f6dd8a", bot: "#c79a3a" },
  { id: "sky", top: "#c8dde8", bot: tokens.color.sky },
  { id: "lilac", top: "#d8c8e0", bot: "#9c7fb0" },
  { id: "charcoal", top: "#3a322a", bot: tokens.color.ink },
];

function ShellSwatchRow(props: { selected: string }) {
  return (
    <div
      style={{
        background: "rgba(255,255,255,.55)",
        padding: "8px 12px",
        borderRadius: 999,
        display: "flex",
        alignItems: "center",
        gap: 10,
        border: "1px solid rgba(0,0,0,.08)",
        marginTop: 16,
      }}
    >
      <span
        style={{
          fontFamily: tokens.font.mono,
          fontSize: 10,
          letterSpacing: "0.1em",
          color: tokens.color.ink3,
          textTransform: "uppercase",
        }}
      >
        shell
      </span>
      <div style={{ display: "flex", gap: 6 }}>
        {SHELL_SWATCHES.map((s) => {
          const active = s.id === props.selected;
          return (
            <span
              style={{
                width: 22,
                height: 22,
                borderRadius: "50%",
                background: `radial-gradient(120% 120% at 50% 30%, ${s.top} 60%, ${s.bot} 100%)`,
                border: active
                  ? `2px solid ${tokens.color.ink}`
                  : "1px solid rgba(0,0,0,.15)",
                boxShadow: active
                  ? "0 0 0 2px rgba(0,0,0,.06)"
                  : "inset 0 -2px 0 rgba(0,0,0,.08)",
                transform: active ? "scale(1.08)" : "scale(1)",
                display: "inline-block",
              }}
              title={s.id}
            />
          );
        })}
      </div>
      <span
        style={{
          fontFamily: tokens.font.mono,
          fontSize: 10,
          color: tokens.color.ink2,
          minWidth: 56,
        }}
      >
        {props.selected}
      </span>
    </div>
  );
}

const stories: PreviewStory[] = [
  {
    name: "live statusline + shell picker (canonical preview)",
    render: () => (
      <div
        style={{
          padding: 22,
          display: "inline-flex",
          flexDirection: "column",
          alignItems: "center",
          gap: 16,
          background: "#ddd0b6",
          borderRadius: 12,
        }}
      >
        <RetroDevice
          chrome="SILTPOKE · v0.4.1"
          buttonCaptions={{ a: "feed", b: "play", c: "scold" }}
        >
          <StatuslineMock />
        </RetroDevice>
        <ShellSwatchRow selected="blush" />
      </div>
    ),
  },
  {
    name: "egg stage creature inside LCD",
    render: () => (
      <div style={{ padding: 22, display: "inline-block", background: "#ddd0b6", borderRadius: 12 }}>
        <RetroDevice chrome="SILTPOKE · HATCH">
          <div
            style={{
              height: "100%",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
            }}
          >
            <Creature
              species="robot"
              mood="happy"
              stage="egg"
              cell={6}
              color={tokens.color.lcdInk}
            />
          </div>
        </RetroDevice>
      </div>
    ),
  },
  {
    name: "adult stage — neutral mood",
    render: () => (
      <div style={{ padding: 22, display: "inline-block", background: "#ddd0b6", borderRadius: 12 }}>
        <RetroDevice chrome="SILTPOKE · L15">
          <div
            style={{
              height: "100%",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
            }}
          >
            <Creature
              species="robot"
              mood="neutral"
              stage="adult"
              cell={5}
              color={tokens.color.lcdInk}
            />
          </div>
        </RetroDevice>
      </div>
    ),
  },
];

export default stories;
