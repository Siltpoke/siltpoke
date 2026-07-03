// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Copyright (c) 2026 Jiaqi Duan
/** @jsxImportSource hono/jsx */
/**
 * Dashboard route JSX helpers.
 *
 * Separated from dashboard.ts so JSX can be used (Bun/TS only processes
 * JSX in .tsx files via the pragma). Imported by dashboard.ts for the
 * `Accept: text/html` branch of POST /api/action.
 *
 * Wave 1.5b: renderHeroFragment now renders HomeCenter (instead of Hero)
 * so the HTMX swap target (#hero) returns consistent markup with the full
 * Home page layout. Hero.tsx is kept but no longer rendered on the main page.
 */
import { HomeCenter } from "../../web/primitives/HomeCenter";
import { Hero } from "../../web/primitives/Hero";
import { StatsPanel } from "../../web/primitives/StatsPanel";
import { VitalsPanel } from "../../web/primitives/VitalsPanel";
import type { Species, Mood } from "../../web/creature/parts";
import type { ActionRecordResult, Progression } from "../../state/progression";
import { xpPanelData } from "../../state/progression";
import { wellFedFromActions } from "../../web/screens/Home.data";
import { readVitalsSeries } from "../../state/vitalsReader";

export interface PetPropsForHero {
  name: string;
  species: Species;
  mood: Mood;
  level: number;
}

/**
 * Map an ActionRecordResult to a display mood.
 *
 * Priority:
 *   grumpy (tease threshold)     → sad
 *   per-action reaction          → feed=happy, play=wow, pet=happy,
 *                                  clean=happy, sleep=sleepy, tease=snark
 *   capped (cap hit)             → use stats-derived mood (no fake sleepy)
 *   stats-based fallback         → hunger<3 hungry; energy<3 sleepy;
 *                                  mood<3 sad; mood>=7 happy; else neutral
 *
 * Capped used to force "sleepy" which made every interaction visually identical
 * once the user hit the daily cap on every action — confusing because stats
 * were still healthy. Now capped actions reflect actual creature state.
 */
function moodFromStats(stats: ActionRecordResult["next"]["stats"]): Mood {
  if (stats.hunger < 3) return "hungry";
  if (stats.energy < 3) return "sleepy";
  if (stats.mood < 3)   return "sad";
  if (stats.mood >= 7)  return "happy";
  return "neutral";
}

const ACTION_REACTION: Record<string, Mood> = {
  feed:  "wow",     // ⊙.⊙ — excited about food
  pet:   "happy",   // ^.^ — cozy
  play:  "hungry",  // >.< — squinty excitement (visually distinct)
  clean: "neutral", // o.o — calm / refreshed
  sleep: "sleepy",  // -.- — zzz
  tease: "snark",   // ¬.¬ — annoyed
};

export function deriveMood(result: ActionRecordResult, action?: string): Mood {
  // Action reaction wins over capped / grumpy / stats so every click produces
  // a distinct visible expression. Grumpy still bites gameplay-side (XP drops
  // to 1), and the "capped" pop badge tells the user when stats didn't move.
  // Mood here is purely the per-click reaction.
  if (action && action in ACTION_REACTION) return ACTION_REACTION[action]!;
  if (result.grumpy) return "sad";
  return moodFromStats(result.next.stats);
}

/**
 * Build Hero props from the action result + saved config values.
 *
 * Spec name. `petPropsForHero` is kept as a deprecated alias for any
 * preview-story / test call sites until Wave 2 cleanup.
 */
export function toPetProps(
  result: ActionRecordResult,
  name: string,
  species: Species,
  action?: string,
): PetPropsForHero {
  return {
    name,
    species,
    mood: deriveMood(result, action),
    level: result.next.level,
  };
}

/** @deprecated Use toPetProps. Kept as alias for back-compat. */
export const petPropsForHero = toPetProps;

/**
 * Render the HomeCenter section as an HTML string fragment.
 *
 * Wave 1.5b: Returns HomeCenter (with id="hero") so the HTMX outerHTML swap
 * produces markup consistent with the full Home page render. This preserves
 * the hx-target="#hero" contract in ActionChip.
 *
 * Uses Hono JSX's `String()` coercion — Hono's JSX runtime serializes a
 * JSX node to an HTML string via the toString hook. This is the same
 * coercion `c.html(<JSX/>)` performs internally. Verified against
 * hono@^4 — pin or revisit if upgrading to hono 5+.
 *
 * The caller wraps this in a raw Response with text/html content-type
 * so the HX-Trigger header can be co-set on the same response.
 */
export function renderHeroFragment(
  petProps: PetPropsForHero,
  _progression: { xp: number; xp_to_next: number },
): string {
  return String(
    <HomeCenter
      pet={petProps}
      statusLabels={{
        left: `awake · ${petProps.mood}`,
        right: "last poke · just now",
      }}
      view="dashboard"
      greeting="hi."
      tagline="siltpoke is watching."
    />,
  );
}

/**
 * Render the StatsPanel as an out-of-band HTMX swap fragment.
 *
 * Why: /api/action's primary swap target is #hero, but feed/play/clean/pet/sleep
 * also mutate hp/hunger/energy/mood/bond/XP — those live in StatsPanel which
 * sits OUTSIDE #hero. Without an OOB swap the panel stays stale until full
 * page reload. The wrapper id matches the initial render in Home.tsx.
 *
 * hx-swap-oob="true" tells HTMX: "swap THIS element by id, regardless of the
 * primary target." Must be on the OUTER node of the OOB fragment.
 */
export function renderStatsPanelOOB(progression: Progression, now: Date): string {
  const inner = String(
    <StatsPanel stats={progression.stats} xp={xpPanelData(progression, now)} />,
  );
  return `<div id="stats-panel" hx-swap-oob="true">${inner}</div>`;
}

/**
 * Render the VitalsPanel as an out-of-band swap fragment.
 *
 * Mirrors renderStatsPanelOOB: Vitals also sits outside #hero so it would
 * otherwise stay stale after /api/action. Pulls the same 7-day series the
 * full page renders, plus derives the same fed/hungry + numeric strings.
 */
export async function renderVitalsPanelOOB(
  basePath: string,
  progression: Progression,
  now: Date,
): Promise<string> {
  const series = await readVitalsSeries(basePath, 7, now);
  const wellFed = wellFedFromActions(progression.daily_actions, now);

  const fmt = (n: number): string => `${Math.round(n)}/10`;
  const vitalsValues = {
    mood:   wellFed ? "happy" : "neutral",
    hunger: wellFed ? "fed" : "hungry",
    energy: fmt(progression.stats.energy),
    bond:   fmt(progression.stats.bond),
  };
  const vitalsData = {
    mood:   series.mood,
    hunger: series.hunger,
    energy: series.energy,
    bond:   series.bond,
  };

  const inner = String(<VitalsPanel vitals={vitalsData} values={vitalsValues} />);
  return `<div id="vitals-panel" hx-swap-oob="true">${inner}</div>`;
}

/**
 * Render the Hero section as an HTML string fragment (legacy fallback).
 *
 * @deprecated Wave 1.5b — no current call sites. Kept temporarily for
 * back-compat in case any external consumer imports Hero shape directly.
 * Slated for deletion alongside `Hero.tsx` in a Wave 2 dead-code cleanup
 * commit. New code MUST use `renderHeroFragment` (which renders HomeCenter).
 */
export function renderHeroFragmentLegacy(
  petProps: PetPropsForHero,
  progression: { xp: number; xp_to_next: number },
): string {
  return String(<Hero pet={petProps} progression={progression} />);
}
