// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
// Copyright (c) 2026 Jiaqi Duan
/** @jsxImportSource hono/jsx */
import type { Child } from "hono/jsx";
import { tokens } from "../tokens/tokens";

// ── PhoneFrame — private helper, NOT exported ────────────────────────────────
interface PhoneFrameProps {
  children: Child;
}

function PhoneFrame({ children }: PhoneFrameProps) {
  return (
    <div
      style={{
        width: 230,
        height: 460,
        padding: 8,
        background: tokens.color.ink,
        borderRadius: 32,
        boxShadow: "0 12px 30px rgba(0,0,0,.18)",
        display: "flex",
        flexDirection: "column",
      }}
    >
      <div
        style={{
          flex: 1,
          background: tokens.color.cream,
          borderRadius: 24,
          overflow: "hidden",
          display: "flex",
          flexDirection: "column",
          position: "relative",
        }}
      >
        {/* Notch */}
        <div
          style={{
            position: "absolute",
            top: 6,
            left: "50%",
            transform: "translateX(-50%)",
            width: 70,
            height: 14,
            background: tokens.color.ink,
            borderRadius: 10,
            zIndex: 2,
          }}
        />
        {/* Status bar — padding clears the 14px notch (top:6 + 14 + 6 gap = 26) */}
        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            padding: "26px 18px 6px",
            fontFamily: tokens.font.mono,
            fontSize: 9.5,
            color: tokens.color.ink2,
          }}
        >
          <span>14:32</span>
          <span>● ●●● 87%</span>
        </div>
        {children}
      </div>
    </div>
  );
}

// ── Wizard — exported shell ──────────────────────────────────────────────────
export interface WizardProps {
  step: number;
  totalSteps: number;
  children: Child;
  prevHref?: string;
  nextHref?: string;
}

export function Wizard(props: WizardProps) {
  const { step, totalSteps, children, prevHref, nextHref } = props;

  const isFirst = step <= 1;
  const isLast = step >= totalSteps;

  const navButtonBase: Record<string, string | number> = {
    fontFamily: tokens.font.mono,
    fontSize: 11,
    padding: "6px 14px",
    borderRadius: 6,
    border: `1px solid ${tokens.color.edge}`,
    background: tokens.color.paper,
    color: tokens.color.ink2,
    textDecoration: "none",
    cursor: "pointer",
  };

  const disabledStyle: Record<string, string | number> = {
    ...navButtonBase,
    color: tokens.color.edge,
    cursor: "default",
    pointerEvents: "none",
  };

  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        gap: 16,
        padding: 24,
      }}
    >
      <PhoneFrame>{children}</PhoneFrame>

      {/* Step counter */}
      <div
        style={{
          fontFamily: tokens.font.mono,
          fontSize: 11,
          color: tokens.color.ink3,
          letterSpacing: 1,
        }}
      >
        Step {step} of {totalSteps}
      </div>

      {/* Prev / Next navigation */}
      <div style={{ display: "flex", gap: 12 }}>
        {isFirst ? (
          <span style={disabledStyle} aria-disabled="true">
            ← prev
          </span>
        ) : (
          <a href={prevHref} hx-boost="true" style={navButtonBase}>
            ← prev
          </a>
        )}

        {isLast ? (
          <span style={disabledStyle} aria-disabled="true">
            next →
          </span>
        ) : (
          <a href={nextHref} hx-boost="true" style={navButtonBase}>
            next →
          </a>
        )}
      </div>
    </div>
  );
}
