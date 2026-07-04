// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
// Copyright (c) 2026 Jiaqi Duan
/** @jsxImportSource hono/jsx */
import { tokens } from "../tokens/tokens";

export interface TopBarBadge {
  /** Stable key for React-style list reconciliation. */
  id: string;
  /** Short uppercase tag, e.g. "WELL-FED". */
  label: string;
  /** Optional human value tail, e.g. "22 hrs". */
  value?: string;
  /** "good" (moss) | "warn" (amber) | "neutral" (ink3). */
  tone?: "good" | "warn" | "neutral";
}

export interface ProfileChipData {
  /** Display initials or short label rendered inside the chip. */
  initials: string;
  /** Full name used for accessible label + tooltip; falls back to initials. */
  name?: string;
}

export interface TopBarProps {
  brand: string;
  petName: string;
  petMeta: string;
  badges: readonly TopBarBadge[];
  profile?: ProfileChipData;
}

const TONE_COLORS: Record<NonNullable<TopBarBadge["tone"]>, { fg: string; bg: string }> = {
  good: { fg: tokens.color.moss, bg: tokens.color.cream },
  // Distinct bg keeps warn visually separable from good at 10px.
  warn: { fg: tokens.color.amber, bg: tokens.color.paperD },
  neutral: { fg: tokens.color.ink3, bg: tokens.color.cream },
};

/**
 * Page-top horizontal bar.
 *
 * Layout (left → right):
 *   [brand]   [petName · petMeta]   [...badges]   [profileChip]
 *
 * Badges are SSR-once values (no live polling).
 * Profile chip is optional — omitted prop = right slot collapses.
 */
export function TopBar(props: TopBarProps) {
  const { brand, petName, petMeta, badges, profile } = props;
  return (
    <header
      class="topbar"
      style={{
        display: "flex",
        alignItems: "center",
        gap: 16,
        padding: "10px 18px",
        background: tokens.color.cream,
        borderBottom: `1px solid ${tokens.color.edge}`,
        minHeight: 48,
      }}
    >
      {/* Brand */}
      <div
        class="topbar__brand"
        style={{
          fontFamily: tokens.font.display,
          fontSize: 18,
          color: tokens.color.ink,
          letterSpacing: -0.2,
        }}
      >
        {brand}
      </div>

      {/* Pet meta */}
      <div
        class="topbar__pet"
        style={{
          display: "flex",
          alignItems: "baseline",
          gap: 6,
          fontFamily: tokens.font.body,
        }}
      >
        <span
          class="topbar__pet-name"
          style={{
            fontSize: 13,
            fontWeight: 600,
            color: tokens.color.ink,
          }}
        >
          {petName}
        </span>
        <span
          class="topbar__pet-meta"
          style={{
            fontSize: 11,
            color: tokens.color.ink3,
            fontFamily: tokens.font.mono,
          }}
        >
          {petMeta}
        </span>
      </div>

      {/*
        Badges — flex-grow spacer absorbs the gap to push profile to right.
        id="topbar-badges" is kept on the wrapper as a future HTMX hook target
        for when live polling lands — the server would OOB-swap only this
        container.
      */}
      <div
        id="topbar-badges"
        class="topbar__badges"
        style={{
          display: "flex",
          alignItems: "center",
          gap: 6,
          marginLeft: "auto",
        }}
      >
        {badges.map((b) => {
          const colors = TONE_COLORS[b.tone ?? "neutral"];
          return (
            <span
              key={b.id}
              class="topbar__badge"
              data-badge-id={b.id}
              data-badge-tone={b.tone ?? "neutral"}
              style={{
                display: "inline-flex",
                alignItems: "center",
                gap: 4,
                padding: "3px 8px",
                borderRadius: tokens.radius.pill,
                border: `1px solid ${tokens.color.edge}`,
                background: colors.bg,
                color: colors.fg,
                fontFamily: tokens.font.mono,
                fontSize: 10,
                letterSpacing: 0.4,
                textTransform: "uppercase",
                fontWeight: 600,
              }}
            >
              <span class="topbar__badge-label">{b.label}</span>
              {b.value && (
                <span
                  class="topbar__badge-value"
                  style={{
                    color: tokens.color.ink2,
                    fontWeight: 500,
                    textTransform: "none",
                    letterSpacing: 0,
                  }}
                >
                  {b.value}
                </span>
              )}
            </span>
          );
        })}
      </div>

      {/* Profile chip */}
      {profile && (
        <div
          class="topbar__profile"
          title={profile.name ?? profile.initials}
          aria-label={`Profile: ${profile.name ?? profile.initials}`}
          data-profile-name={profile.name ?? ""}
          style={{
            display: "inline-flex",
            alignItems: "center",
            justifyContent: "center",
            width: 28,
            height: 28,
            borderRadius: tokens.radius.pill,
            background: tokens.color.paperD,
            border: `1px solid ${tokens.color.edge}`,
            color: tokens.color.ink,
            fontFamily: tokens.font.mono,
            fontSize: 11,
            fontWeight: 600,
          }}
        >
          {profile.initials}
        </div>
      )}
    </header>
  );
}
