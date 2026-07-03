// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Copyright (c) 2026 Jiaqi Duan
/** @jsxImportSource hono/jsx */
/**
 * Home screen — Design D layout.
 *
 * 2-col grid layout:
 *   LEFT:  HOME header + HomeCenter (dotted-grid panel + creature + chips)
 *   RIGHT: StatsPanel + VitalsPanel + CritiqueInbox
 *
 * TopBar is no longer mounted here (dropped per brief — brand + pet meta live
 * in sidebar chip and Home content header).
 */
import { Dashboard } from "../shells/Dashboard";
import { HomeCenter } from "../primitives/HomeCenter";
import { StatsPanel } from "../primitives/StatsPanel";
import { BudgetGauge, SkipHistogram } from "./Critic";
import { BiasAuditPanel } from "../primitives/BiasAuditPanel";
import { ModelsPanel } from "../primitives/ModelsPanel";
import { Pill } from "../atoms/Pill";
import { CANONICAL_NAV } from "../routes/nav";
import { tokens } from "../tokens/tokens";
import type { HomeData } from "./Home.data";

export type { HomeData };

export interface HomeProps {
  data: HomeData;
  /** Which Home view to render. Defaults to "dashboard". */
  view?: "dashboard" | "toy";
  /** Tamagotchi shell color name (only used in toy view). Default "blush". */
  shellName?: string;
}

export function Home({ data, view = "dashboard", shellName = "blush" }: HomeProps) {
  // Build live nav meta from real data — null entries are omitted (no meta shown).
  const navMetaOverrides: Partial<Record<import("../client/stores/navState").Section, string>> = {};
  if (data.navMeta.memory !== null) navMetaOverrides.memory = data.navMeta.memory;

  // Header subtitle data — fall back to species when no user-set title.
  const petTitle = data.petTitle || data.pet.species;
  const startDate = data.startDate ?? "today";

  return (
    <Dashboard
      navSections={CANONICAL_NAV}
      activeSection="home"
      level={data.pet.level}
      navMetaOverrides={navMetaOverrides}
    >
      {/* Ephemeral Brain-health strip — exists in the DOM
          ONLY while unhealthy (≥2 consecutive failures or permanent class);
          disappears automatically once the next Brain call succeeds. */}
      {data.brainHealth.show && (
        <div
          id="brain-health-strip"
          style={{
            margin: "16px 16px 0",
            padding: "8px 14px",
            background: `${tokens.color.terra}18`,
            border: `1px solid ${tokens.color.terra}`,
            borderRadius: 6,
            fontFamily: tokens.font.mono,
            fontSize: 11,
            color: tokens.color.terra,
            lineHeight: 1.5,
          }}
        >
          {data.brainHealth.line}
        </div>
      )}
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "minmax(0, 1fr) 380px",
          gap: "16px",
          padding: "16px",
          height: "100%",
          boxSizing: "border-box",
          alignItems: "stretch",
        }}
      >
        {/* LEFT column — HOME header + HomeCenter */}
        <div
          style={{
            display: "flex",
            flexDirection: "column",
            gap: "12px",
            minWidth: 0,
          }}
        >
          {/* HOME header — Design D: flex row with left info + right floating chip */}
          <div
            class="home-header"
            style={{
              display: "flex",
              justifyContent: "space-between",
              alignItems: "flex-start",
            }}
          >
            {/* Left side: kicker / title / subtitle */}
            <div>
              <span
                style={{
                  fontFamily: tokens.font.mono,
                  fontSize: 10,
                  color: tokens.color.ink3,
                  letterSpacing: "0.08em",
                  textTransform: "uppercase",
                  display: "block",
                  marginBottom: 4,
                }}
              >
                HOME · today
              </span>
              <h1
                style={{
                  margin: "0 0 4px",
                  fontFamily: tokens.font.display,
                  fontSize: 36,
                  fontWeight: 400,
                  color: tokens.color.ink,
                  lineHeight: 1,
                  letterSpacing: 0,
                }}
              >
                {data.pet.name}
              </h1>
              <div
                style={{
                  fontFamily: tokens.font.body,
                  fontSize: 13,
                  color: tokens.color.ink3,
                }}
              >
                {petTitle} · L{data.pet.level} · since {startDate} · {data.together} together
              </div>
            </div>

            {/* Right side: status chips — well-fed + quiet-hours flag. */}
            <div style={{ display: "flex", gap: 6 }}>
              {data.telemetry.gateState.checks.some(
                (c) => c.name === "quiet hours" && !c.pass,
              ) && (
                <Pill
                  bg={`${tokens.color.amber}22`}
                  color={tokens.color.amber}
                  border={tokens.color.amber}
                >
                  quiet hours
                </Pill>
              )}
              {data.stats.hunger > 4 && (
                <Pill
                  bg={`${tokens.color.moss}22`}
                  color={tokens.color.moss}
                  border={tokens.color.moss}
                >
                  well-fed
                </Pill>
              )}
            </div>
          </div>

          {/* HomeCenter — Design D dashboard view OR Design A tamagotchi shell */}
          <HomeCenter
            pet={data.pet}
            statusLabels={{
              left: `awake · ${data.pet.mood}`,
              right: `last poke · ${data.meta.lastPokeAt}`,
            }}
            view={view}
            greeting="hi."
            tagline={data.latestCritique?.text ?? "siltpoke is watching."}
            toyData={{
              pet: data.pet,
              hp: data.stats.hp,
              pendingCritiqueCount: data.pendingCritiqueCount,
            }}
            shellName={shellName}
          />
        </div>

        {/* RIGHT column — Stats / Vitals / Critique stacked panels */}
        <div
          style={{
            display: "flex",
            flexDirection: "column",
            gap: "12px",
            minWidth: 0,
          }}
        >
          <div id="stats-panel">
            <StatsPanel stats={data.stats} xp={{ ...data.xp, xpToday: data.xp.xpToday ?? 0 }} />
          </div>
          {/* Operational telemetry — moved here from the standalone /stats
              page so Home is a single-stop dashboard. GateCheckList dropped:
              quiet-hours surfaces as a header pill, budget as BUDGET card —
              the gate panel ended up purely redundant. */}
          <BudgetGauge   telemetry={data.telemetry} />
          <SkipHistogram telemetry={data.telemetry} />
          {/* OBSERVABILITY section (per-critique signals live in History detail; only dual-model + bias-audit panels remain on Home) */}
          <ModelsPanel modelsInfo={data.modelsInfo} />
          <BiasAuditPanel config={data.biasAuditConfig} delta={data.biasAuditDelta} />
        </div>
      </div>
    </Dashboard>
  );
}
