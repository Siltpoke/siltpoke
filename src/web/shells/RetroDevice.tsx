// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Copyright (c) 2026 Jiaqi Duan
/** @jsxImportSource hono/jsx */
import type { Child } from "hono/jsx";
import { tokens } from "../tokens/tokens";

// ── ToyButton — private helper, NOT exported ─────────────────────────────────
interface ToyButtonProps {
  label: string;
  size?: number;
  color?: string;
  ink?: string;
}

function ToyButton({
  label,
  size = 36,
  color = tokens.color.terra,
  ink = "#fff",
}: ToyButtonProps) {
  return (
    <div
      style={{
        width: size,
        height: size,
        borderRadius: "50%",
        background: color,
        color: ink,
        fontFamily: tokens.font.display,
        fontWeight: 700,
        fontSize: Math.round(size * 0.42),
        boxShadow:
          "inset 0 -3px 0 rgba(0,0,0,.22), 0 3px 0 rgba(0,0,0,.08)",
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        userSelect: "none",
      }}
    >
      {label}
    </div>
  );
}

// ── RetroDevice — exported shell ─────────────────────────────────────────────
export interface RetroDeviceProps {
  children: Child;
  width?: number;
  height?: number;
  /** Small-caps mode pill below the lanyard (e.g. "SILTPOKE · V0.4.1"). */
  chrome?: string;
  /**
   * Per-button captions rendered as their own row below A / B / C.
   * Omitted slots simply don't render. Pixel positions follow the
   * canonical tamagotchi-toy.html: buttons at bottom:40, captions
   * at bottom:22.
   */
  buttonCaptions?: { a?: string; b?: string; c?: string };
}

/**
 * Pixel-positioned egg-toy chrome. Pixel coordinates are sourced from
 * tamagotchi-toy.html (canonical reference design) rather than computed
 * from ratios — the design depends on the exact spacing between lanyard,
 * mode pill, LCD top, button row, and caption row.
 *
 * Default dimensions 280×340; resizing is supported but layout coordinates
 * stay pixel-fixed (callers wanting a different look should fork the shell).
 */
export function RetroDevice(props: RetroDeviceProps) {
  const {
    children,
    width = 280,
    height = 340,
    chrome,
    buttonCaptions,
  } = props;

  return (
    <div
      style={{
        position: "relative",
        width,
        height,
        isolation: "isolate",
      }}
    >
      {/* Egg shell — radial gradient + asymmetric border-radius */}
      <div
        style={{
          position: "absolute",
          inset: 0,
          background: `radial-gradient(120% 120% at 50% 30%, ${tokens.color.egg} 60%, ${tokens.color.egg2} 100%)`,
          borderRadius: "46% 46% 44% 44% / 56% 56% 40% 40%",
          boxShadow:
            "inset 0 -10px 0 rgba(0,0,0,.10), inset 0 8px 0 rgba(255,255,255,.5), 0 12px 28px rgba(0,0,0,.15)",
        }}
      />

      {/* Lanyard ring — INSIDE the egg at pixel top:32 (canonical) */}
      <div
        style={{
          position: "absolute",
          top: 32,
          left: "50%",
          transform: "translateX(-50%)",
          width: 16,
          height: 22,
          border: `2.5px solid ${tokens.color.ink}`,
          borderRadius: 8,
          background: "transparent",
        }}
      />

      {/* Mode pill — below the lanyard */}
      {chrome && (
        <div
          style={{
            position: "absolute",
            top: 62,
            left: "50%",
            transform: "translateX(-50%)",
            fontFamily: tokens.font.mono,
            fontSize: 9,
            letterSpacing: "0.12em",
            color: tokens.color.ink3,
            textTransform: "uppercase",
          }}
        >
          {chrome}
        </div>
      )}

      {/* LCD screen — fixed 200×160 at top:85 (canonical).
          box-sizing: border-box is critical — the canonical HTML applies
          it globally via `.sp-art *`; without it the `padding: 8` adds
          16px to both dimensions, pushing LCD bottom into the button row
          (smoke F-S2). */}
      <div
        class="sp-lcd"
        style={{
          position: "absolute",
          left: "50%",
          top: 85,
          transform: "translateX(-50%)",
          width: 200,
          height: 160,
          boxSizing: "border-box",
          background: tokens.color.lcd,
          borderRadius: 6,
          boxShadow: `inset 0 0 0 2px ${tokens.color.ink}`,
          overflow: "hidden",
          padding: 8,
          display: "flex",
          flexDirection: "column",
        }}
      >
        {children}
      </div>

      {/* A / B / C buttons — bottom:40 */}
      <div
        style={{
          position: "absolute",
          left: 0,
          right: 0,
          bottom: 40,
          display: "flex",
          justifyContent: "center",
          gap: 20,
        }}
      >
        <ToyButton label="A" size={36} color={tokens.color.terra} />
        <ToyButton
          label="B"
          size={42}
          color={tokens.color.amber}
          ink={tokens.color.ink}
        />
        <ToyButton label="C" size={36} color={tokens.color.terra} />
      </div>

      {/* Button captions — separate row at bottom:28 (tight under buttons) */}
      {buttonCaptions && (
        <div
          style={{
            position: "absolute",
            left: 0,
            right: 0,
            bottom: 28,
            display: "flex",
            justifyContent: "center",
            gap: 26,
            fontFamily: tokens.font.mono,
            fontSize: 9,
            color: tokens.color.ink3,
          }}
        >
          <span style={{ width: 36, textAlign: "center" }}>
            {buttonCaptions.a ?? ""}
          </span>
          <span style={{ width: 42, textAlign: "center" }}>
            {buttonCaptions.b ?? ""}
          </span>
          <span style={{ width: 36, textAlign: "center" }}>
            {buttonCaptions.c ?? ""}
          </span>
        </div>
      )}
    </div>
  );
}
