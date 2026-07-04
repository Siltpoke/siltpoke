// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
// Copyright (c) 2026 Jiaqi Duan
import { readFile, writeFile, rename, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { randomBytes } from "node:crypto";

export interface PetDay {
  day: string;
  count: number;
}

/**
 * Per-day tally for every interactive action surfaced from the report UI:
 *   feed / play / pet — positive actions, daily-capped, grant XP
 *   tease             — negative action, uncapped; reaching 3 makes the
 *                       pet "grumpy" for the rest of the day, which drops
 *                       all positive-action XP to 1
 *   clean             — positive, daily-capped (same cap as pet), grants XP
 *   sleep             — positive, uncapped (same shape as tease), grants no base XP
 *                       (no bonus or sleep-streak rule yet)
 */
export interface DailyActions {
  day: string;
  feed: number;
  play: number;
  pet: number;
  tease: number;
  clean: number;
  sleep: number;
}

export type PetAction = "feed" | "play" | "pet" | "tease" | "clean" | "sleep";

/** 0-10 pet stats. All fields default to mid-range. */
export interface Stats {
  hp: number;
  hunger: number;
  energy: number;
  mood: number;
  bond: number;
}

/** Per-day XP awarded from dashboard interactions (separate from Brain XP). */
export interface ActionXpDay {
  day: string;
  xp: number;
}

export interface Progression {
  schemaVersion: 2;
  level: number;
  xp: number;
  xp_to_next_level: number;
  unlocked_poses: string[];
  unlocked_titles: string[];
  pet_log: PetDay[];
  daily_actions?: DailyActions[];
  stats: Stats;
  stats_last_tick_at: string;
  streak_days_persistent: number;
  streak_last_day: string | null;
  /**
   * Action-XP running totals per day, retained for PET_LOG_RETENTION_DAYS.
   * Drives the per-day XP cap so dashboard mashing can't outpace Brain XP.
   * Optional for back-compat with progression files predating the cap.
   */
  action_xp?: ActionXpDay[];
}

const DEFAULT_STATS: Stats = {
  hp: 10,
  hunger: 5,
  energy: 8,
  mood: 6,
  bond: 0,
};

export const DEFAULT_PROGRESSION: Progression = {
  schemaVersion: 2,
  level: 1,
  xp: 0,
  xp_to_next_level: 100,
  unlocked_poses: ["base"],
  unlocked_titles: ["Hatchling"],
  pet_log: [],
  daily_actions: [],
  stats: { ...DEFAULT_STATS },
  stats_last_tick_at: new Date().toISOString(),
  streak_days_persistent: 0,
  streak_last_day: null,
};

// ── Action stat effects ────────────────────────────────────────────────────────

export const STAT_EFFECTS: Record<PetAction, Partial<Stats>> = {
  feed:  { hunger: 3, mood: 1 },
  play:  { hunger: -1, energy: -2, mood: 2, bond: 1 },
  clean: { hp: 1, mood: 1 },
  pet:   { mood: 1, bond: 2 },
  sleep: { hp: 1, energy: 4 },
  tease: { mood: -2, bond: -1 },
};

function clamp(v: number): number {
  return Math.max(0, Math.min(10, v));
}

/**
 * Apply action stat deltas to stats. Pure: returns a new Stats object.
 * Clamps each field to [0, 10] after applying deltas.
 */
export function applyStatEffects(stats: Readonly<Stats>, action: PetAction): Stats {
  const delta = STAT_EFFECTS[action];
  return {
    hp:     clamp(stats.hp     + (delta.hp     ?? 0)),
    hunger: clamp(stats.hunger + (delta.hunger  ?? 0)),
    energy: clamp(stats.energy + (delta.energy  ?? 0)),
    mood:   clamp(stats.mood   + (delta.mood    ?? 0)),
    bond:   clamp(stats.bond   + (delta.bond    ?? 0)),
  };
}

// ── Streak tracking ────────────────────────────────────────────────────────────

function updateStreak(
  prog: Progression,
  today: string,
): { streak_days_persistent: number; streak_last_day: string } {
  const last = prog.streak_last_day;
  if (last === today) {
    return { streak_days_persistent: prog.streak_days_persistent, streak_last_day: today };
  }
  const yesterdayDate = new Date(`${today}T00:00:00Z`);
  yesterdayDate.setUTCDate(yesterdayDate.getUTCDate() - 1);
  const yesterdayStr = yesterdayDate.toISOString().slice(0, 10);
  if (last === yesterdayStr) {
    return { streak_days_persistent: prog.streak_days_persistent + 1, streak_last_day: today };
  }
  return { streak_days_persistent: 1, streak_last_day: today };
}

// ── Level / unlock infrastructure ─────────────────────────────────────────────

interface Unlock {
  poses?: string[];
  titles?: string[];
}

const UNLOCK_TABLE: Record<number, Unlock> = {
  2: { poses: ["peek"], titles: ["Watcher"] },
  3: { poses: ["blink"] },
  4: { poses: ["arms_crossed"] },
  5: { titles: ["Apprentice"] },
  6: { poses: ["shrug"] },
  8: { poses: ["wave"] },
  10: { titles: ["Sentinel"] },
  11: { poses: ["stretch"] },
  13: { titles: ["Veteran"] },
  18: { poses: ["zen"] },
  20: { titles: ["Sage"] },
  30: { titles: ["Oracle"] },
  50: { titles: ["Ancient"] },
  100: { titles: ["Legend"] },
};

// Aura tiers — purely cosmetic, rendered as corner glyphs around the
// face block in wrapper.ts. Not stored in unlocked_titles/poses; derived
// from level at render time. Tier name maps to the corner glyph.
export const AURA_TIERS: ReadonlyArray<{ level: number; glyph: string }> = [
  { level: 15, glyph: "★" },
  { level: 25, glyph: "✦" },
];

export function pickAuraGlyph(level: number): string | undefined {
  let glyph: string | undefined;
  for (const tier of AURA_TIERS) {
    if (level >= tier.level) glyph = tier.glyph;
  }
  return glyph;
}

export interface AddXpResult {
  next: Progression;
  delta: number;
  leveled_up: boolean;
  new_unlocks: { poses: string[]; titles: string[] };
}

// Piecewise XP curve. Onboarding stays gentle through lv5 so new users
// see unlocks quickly; the curve steepens once Apprentice is reached so
// hitting Sentinel (lv10) and beyond is months of engagement, not days.
//
//   lv1-5   : 100 · n   (Hatchling → Apprentice)
//   lv5-10  : 250 · n   (main game — Apprentice → Sentinel)
//   lv10-20 : 500 · n   (resident — Sentinel → Sage)
//   lv20+   : 1000 · n  (endgame — Sage → Oracle/Ancient/Legend)
function nextLevelTarget(level: number): number {
  if (level <= 5) return 100 * level;
  if (level <= 10) return 250 * level;
  if (level <= 20) return 500 * level;
  return 1000 * level;
}

function applyUnlocks(
  level: number,
  current: Progression,
): { poses: string[]; titles: string[]; addedPoses: string[]; addedTitles: string[] } {
  const unlock = UNLOCK_TABLE[level];
  if (!unlock) {
    return {
      poses: current.unlocked_poses,
      titles: current.unlocked_titles,
      addedPoses: [],
      addedTitles: [],
    };
  }
  const addedPoses = (unlock.poses ?? []).filter(
    (p) => !current.unlocked_poses.includes(p),
  );
  const addedTitles = (unlock.titles ?? []).filter(
    (t) => !current.unlocked_titles.includes(t),
  );
  return {
    poses: [...current.unlocked_poses, ...addedPoses],
    titles: [...current.unlocked_titles, ...addedTitles],
    addedPoses,
    addedTitles,
  };
}

export function addXp(
  progression: Progression,
  amount: number,
): AddXpResult {
  if (!Number.isFinite(amount) || amount <= 0) {
    return {
      next: progression,
      delta: 0,
      leveled_up: false,
      new_unlocks: { poses: [], titles: [] },
    };
  }
  let level = progression.level;
  let xp = progression.xp + Math.floor(amount);
  let target = progression.xp_to_next_level;
  let unlockedPoses = progression.unlocked_poses;
  let unlockedTitles = progression.unlocked_titles;
  const gainedPoses: string[] = [];
  const gainedTitles: string[] = [];
  let leveledUp = false;
  while (xp >= target) {
    xp -= target;
    level += 1;
    target = nextLevelTarget(level);
    leveledUp = true;
    const unlockResult = applyUnlocks(level, {
      ...progression,
      unlocked_poses: unlockedPoses,
      unlocked_titles: unlockedTitles,
    });
    unlockedPoses = unlockResult.poses;
    unlockedTitles = unlockResult.titles;
    gainedPoses.push(...unlockResult.addedPoses);
    gainedTitles.push(...unlockResult.addedTitles);
  }
  return {
    next: {
      ...progression,
      level,
      xp,
      xp_to_next_level: target,
      unlocked_poses: unlockedPoses,
      unlocked_titles: unlockedTitles,
    },
    delta: Math.floor(amount),
    leveled_up: leveledUp,
    new_unlocks: { poses: gainedPoses, titles: gainedTitles },
  };
}

export interface PetRecordResult {
  next: Progression;
  awarded: number;
  capped: boolean;
  pets_today: number;
}

const DEFAULT_PET_PER_DAY_CAP = 2;
const PET_XP_PER_TAP = 5;
const PET_LOG_RETENTION_DAYS = 7;

export const ACTION_BASE_XP: Record<PetAction, number> = {
  feed: 5,
  play: 3,
  pet: 5,
  tease: 0,
  clean: 5,
  sleep: 0,
};

// No per-action count cap — actions always apply stat effects and animate.
// Instead, ACTION_XP_DAILY_CAP throttles XP earned from dashboard interaction
// so leveling stays driven by Brain critiques + /siltpoke-forward on the
// long horizon. Once today's action-XP hits the cap, further clicks still
// move stats but grant 0 XP (banner shows "capped · stats only").
const _ACTION_DAILY_CAP: Record<PetAction, number | null> = {
  feed: null,
  play: null,
  pet: null,
  tease: null, // also counts toward grumpy threshold
  clean: null,
  sleep: null,
};

/** Total XP awarded from dashboard actions per day. */
export const ACTION_XP_DAILY_CAP = 100;

const TEASE_GRUMPY_THRESHOLD = 3;
const GRUMPY_XP = 1;

/**
 * Today's running action-XP total. Returns 0 when no entry for `day`.
 * Used by the cap gate in recordAction and by the badge display paths.
 */
export function actionXpToday(prog: Progression, day: string): number {
  const list = prog.action_xp ?? [];
  return list.find((e) => e.day === day)?.xp ?? 0;
}

export interface XpPanelData {
  level: number;
  nextLevel: number;
  xp: number;
  xpToNext: number;
  xpToday: number;
  xpTodayCapped: boolean;
}

/**
 * XP shape for StatsPanel — single builder for BOTH render paths (full Home
 * SSR + post-action OOB swap) so the day-key derivation and cap comparison
 * cannot drift between call sites. Day key must match what recordAction writes.
 */
export function xpPanelData(prog: Progression, now: Date): XpPanelData {
  const xpToday = actionXpToday(prog, now.toISOString().slice(0, 10));
  return {
    level: prog.level,
    nextLevel: prog.level + 1,
    xp: prog.xp,
    xpToNext: prog.xp_to_next_level,
    xpToday,
    xpTodayCapped: xpToday >= ACTION_XP_DAILY_CAP,
  };
}

function bumpActionXp(
  prog: Progression,
  day: string,
  delta: number,
): ActionXpDay[] {
  if (delta <= 0) return prog.action_xp ?? [];
  const list = prog.action_xp ?? [];
  const idx = list.findIndex((e) => e.day === day);
  const next: ActionXpDay[] =
    idx >= 0
      ? list.map((e) => (e.day === day ? { day, xp: e.xp + delta } : e))
      : [...list, { day, xp: delta }];
  return next
    .sort((a, b) => (a.day < b.day ? -1 : a.day > b.day ? 1 : 0))
    .slice(-PET_LOG_RETENTION_DAYS);
}

export interface ActionRecordResult {
  next: Progression;
  awarded: number;
  capped: boolean;
  grumpy: boolean;
  /** Today's count for the action just performed, after applying it. */
  action_count: number;
  /** Today's tease count after applying (so client can show "almost grumpy"). */
  tease_count: number;
}

function todayEntry(prog: Progression, day: string): DailyActions {
  const list = prog.daily_actions ?? [];
  const found = list.find((e) => e.day === day);
  if (found) {
    // Back-fill new fields for older persisted entries that predate clean/sleep.
    return {
      day: found.day,
      feed: found.feed,
      play: found.play,
      pet: found.pet,
      tease: found.tease,
      clean: found.clean ?? 0,
      sleep: found.sleep ?? 0,
    };
  }
  return {
    day,
    feed: 0,
    play: 0,
    pet: 0,
    tease: 0,
    clean: 0,
    sleep: 0,
  };
}

export function isGrumpy(prog: Progression, day: string): boolean {
  const entry = (prog.daily_actions ?? []).find((e) => e.day === day);
  return (entry?.tease ?? 0) >= TEASE_GRUMPY_THRESHOLD;
}

/**
 * Generalized action recorder. Every action applies its stat effect and
 * bumps its daily count. XP is gated by ACTION_XP_DAILY_CAP — once today's
 * action-XP is at cap, further clicks still update stats but award 0 XP
 * (the `capped` flag tells the UI to show "stats only · XP capped"). XP
 * also collapses to GRUMPY_XP when the pet is grumpy at the start of the
 * action (3+ teases today).
 *
 * For backward compatibility, "pet" actions also append to the legacy
 * pet_log so the `/siltpoke-pet` CLI + statusline keep working unchanged.
 */
export function recordAction(
  progression: Progression,
  day: string,
  action: PetAction,
): ActionRecordResult {
  const entry = todayEntry(progression, day);

  const nextEntry: DailyActions = {
    ...entry,
    [action]: (entry as Record<PetAction, number>)[action] + 1,
  };

  const otherDays = (progression.daily_actions ?? []).filter(
    (e) => e.day !== day,
  );
  const trimmed = [...otherDays, nextEntry]
    .sort((a, b) => (a.day < b.day ? -1 : a.day > b.day ? 1 : 0))
    .slice(-PET_LOG_RETENTION_DAYS);

  let nextProg: Progression = { ...progression, daily_actions: trimmed };

  // Keep legacy pet_log in sync for /siltpoke-pet + statusline compat.
  if (action === "pet") {
    const petLogIdx = nextProg.pet_log.findIndex((d) => d.day === day);
    const newPetLog =
      petLogIdx >= 0
        ? nextProg.pet_log.map((d) =>
            d.day === day ? { day, count: nextEntry.pet } : d,
          )
        : [...nextProg.pet_log, { day, count: nextEntry.pet }];
    nextProg = {
      ...nextProg,
      pet_log: newPetLog
        .sort((a, b) => (a.day < b.day ? -1 : a.day > b.day ? 1 : 0))
        .slice(-PET_LOG_RETENTION_DAYS),
    };
  }

  // Update persistent streak before XP award
  const streakUpdate = updateStreak(nextProg, day);
  nextProg = { ...nextProg, ...streakUpdate };

  // Apply stat effects for this action
  const newStats = applyStatEffects(nextProg.stats, action);
  nextProg = { ...nextProg, stats: newStats };

  // XP award gated by daily-action-XP cap. Pre-cap balance is read against
  // the original progression so each action sees a stable budget.
  const wasGrumpyBefore = isGrumpy(progression, day);
  const xpBase = ACTION_BASE_XP[action];
  const budgetRemaining = Math.max(0, ACTION_XP_DAILY_CAP - actionXpToday(progression, day));
  let awarded = 0;
  let xpCapped = false;
  if (xpBase > 0) {
    const xpWanted = wasGrumpyBefore ? GRUMPY_XP : xpBase;
    const xpToGrant = Math.min(xpWanted, budgetRemaining);
    if (xpToGrant > 0) {
      const xpResult = addXp(nextProg, xpToGrant);
      nextProg = xpResult.next;
      awarded = xpResult.delta;
      nextProg = { ...nextProg, action_xp: bumpActionXp(nextProg, day, awarded) };
    }
    xpCapped = xpToGrant < xpWanted;
  }

  return {
    next: nextProg,
    awarded,
    capped: xpCapped,
    grumpy: isGrumpy(nextProg, day),
    action_count: (nextEntry as Record<PetAction, number>)[action],
    tease_count: nextEntry.tease,
  };
}

export function recordPet(
  progression: Progression,
  day: string,
  dailyCap: number = DEFAULT_PET_PER_DAY_CAP,
): PetRecordResult {
  const existingIdx = progression.pet_log.findIndex((d) => d.day === day);
  const before =
    existingIdx >= 0 ? progression.pet_log[existingIdx]?.count : 0;
  if (before >= dailyCap) {
    return {
      next: progression,
      awarded: 0,
      capped: true,
      pets_today: before,
    };
  }
  const updatedCount = before + 1;
  const log: PetDay[] = progression.pet_log.map((d) =>
    d.day === day ? { day: d.day, count: updatedCount } : d,
  );
  if (existingIdx === -1) log.push({ day, count: updatedCount });
  // Sort by ISO-date string ascending and keep only the last N days.
  const trimmed = log
    .sort((a, b) => (a.day < b.day ? -1 : a.day > b.day ? 1 : 0))
    .slice(-PET_LOG_RETENTION_DAYS);
  const xpResult = addXp(
    { ...progression, pet_log: trimmed },
    PET_XP_PER_TAP,
  );
  return {
    next: xpResult.next,
    awarded: PET_XP_PER_TAP,
    capped: false,
    pets_today: updatedCount,
  };
}

const FILENAME = "progression.json";

function progressionPath(basePath: string): string {
  return join(basePath, FILENAME);
}

function isLegacyProgression(value: unknown): boolean {
  if (typeof value !== "object" || value === null) return false;
  const p = value as Record<string, unknown>;
  const dailyActionsOK =
    p.daily_actions === undefined || Array.isArray(p.daily_actions);
  return (
    (p.schemaVersion === 1 || p.schemaVersion === 2) &&
    typeof p.level === "number" &&
    typeof p.xp === "number" &&
    typeof p.xp_to_next_level === "number" &&
    Array.isArray(p.unlocked_poses) &&
    Array.isArray(p.unlocked_titles) &&
    Array.isArray(p.pet_log) &&
    dailyActionsOK
  );
}

/**
 * Migrate a v1 (or malformed v2) parsed object up to v2 Progression.
 * No retroactive decay — stats start from defaults.
 */
function migrateToV2(parsed: Record<string, unknown>, now: Date): Progression {
  const petLog: PetDay[] = Array.isArray(parsed.pet_log)
    ? (parsed.pet_log as PetDay[])
    : [];

  // streak_last_day: latest pet_log entry day, or null
  const sortedLog = [...petLog].sort((a, b) =>
    a.day < b.day ? -1 : a.day > b.day ? 1 : 0,
  );
  const streak_last_day =
    sortedLog.length > 0 ? (sortedLog[sortedLog.length - 1]?.day) : null;

  // streak_days_persistent: min(7, pet_log.length) as carry-over approximation
  const streak_days_persistent = Math.min(7, petLog.length);

  // Determine whether parsed.stats is a valid Stats object
  const rawStats = parsed.stats as Record<string, unknown> | undefined;
  const hasValidStats =
    rawStats !== null &&
    typeof rawStats === "object" &&
    typeof rawStats.hp === "number" &&
    typeof rawStats.hunger === "number" &&
    typeof rawStats.energy === "number" &&
    typeof rawStats.mood === "number" &&
    typeof rawStats.bond === "number";

  const stats: Stats = hasValidStats
    ? {
        hp:     rawStats?.hp as number,
        hunger: rawStats?.hunger as number,
        energy: rawStats?.energy as number,
        mood:   rawStats?.mood as number,
        bond:   rawStats?.bond as number,
      }
    : { ...DEFAULT_STATS };

  return {
    schemaVersion: 2,
    level:             typeof parsed.level === "number" ? parsed.level : 1,
    xp:                typeof parsed.xp === "number" ? parsed.xp : 0,
    xp_to_next_level:  typeof parsed.xp_to_next_level === "number" ? parsed.xp_to_next_level : 100,
    unlocked_poses:    Array.isArray(parsed.unlocked_poses) ? (parsed.unlocked_poses as string[]) : ["base"],
    unlocked_titles:   Array.isArray(parsed.unlocked_titles) ? (parsed.unlocked_titles as string[]) : ["Hatchling"],
    pet_log:           petLog,
    daily_actions:     Array.isArray(parsed.daily_actions) ? (parsed.daily_actions as DailyActions[]) : [],
    stats,
    stats_last_tick_at: now.toISOString(),
    streak_days_persistent,
    streak_last_day,
  };
}

export async function readProgression(
  basePath: string,
): Promise<Progression> {
  const path = progressionPath(basePath);
  if (!existsSync(path)) return { ...DEFAULT_PROGRESSION, stats_last_tick_at: new Date().toISOString() };
  try {
    const raw = await readFile(path, "utf8");
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    if (!isLegacyProgression(parsed)) return { ...DEFAULT_PROGRESSION, stats_last_tick_at: new Date().toISOString() };
    // Migration: v1 OR v2 missing stats fields → migrate
    const needsMigration =
      parsed.schemaVersion !== 2 ||
      typeof (parsed.stats_last_tick_at) !== "string" ||
      typeof (parsed.streak_days_persistent) !== "number" ||
      !("streak_last_day" in parsed);
    if (needsMigration) {
      return migrateToV2(parsed, new Date());
    }
    // v2 with possibly missing stats object
    if (
      typeof (parsed.stats as Record<string, unknown> | undefined)?.hp !== "number"
    ) {
      return migrateToV2(parsed, new Date());
    }
    return parsed as unknown as Progression;
  } catch {
    return { ...DEFAULT_PROGRESSION, stats_last_tick_at: new Date().toISOString() };
  }
}

export async function writeProgression(
  basePath: string,
  progression: Progression,
): Promise<void> {
  try {
    await mkdir(basePath, { recursive: true });
    const finalPath = progressionPath(basePath);
    const tmpPath = `${finalPath}.tmp.${process.pid}.${Date.now()}.${randomBytes(4).toString("hex")}`;
    await writeFile(tmpPath, JSON.stringify(progression, null, 2), "utf8");
    await rename(tmpPath, finalPath);
  } catch {
    // never crash caller
  }
}
