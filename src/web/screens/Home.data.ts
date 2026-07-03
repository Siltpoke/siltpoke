// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Copyright (c) 2026 Jiaqi Duan
/**
 * Home.data.ts — single data-resolution function for the rich Home screen.
 *
 * Pulls pet identity / progression / statusline / 7-day vitals / recent facts
 * / TopBar badges in one async call. All helpers are exported for unit testing.
 */

import { readFile, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { readMemory, type Fact } from "../../memory/memory";
import { readProgression, xpPanelData, type DailyActions } from "../../state/api";
import { readVitalsSeries } from "../../state/api";
import { readCriticTelemetry, type CriticTelemetry } from "../../state/api";
import { computeBiasAuditDelta, type BiasAuditDelta } from "../../critic/bias-audit/delta-computer";
import { homedir } from "node:os";
import type { Species, Mood } from "../creature/parts";
import type { Critique } from "../primitives/CritiqueInbox";
import type { VitalsData, VitalsValues } from "../primitives/VitalsPanel";
import { relativeAgo } from "../primitives/CompactFactoidRow";
import type { RubricSummary } from "../primitives/RubricActivityPanel";
import type { FewShotStats } from "../primitives/FewShotPanel";
import type { RepoMemoryStats } from "../primitives/RepoMemoryPanel";
import type { ModelsInfo } from "../primitives/ModelsPanel";
import {
  readBrainHealthAsync,
  brainUnhealthySignal,
  type UnhealthySignal,
} from "../../state/brain-health";
// MOCK_CRITIQUES is intentionally NOT imported here — production path uses
// real data (empty when no telemetry). Import from mocks/critiques.ts in
// preview stories / test fixtures only.

// ── Types ─────────────────────────────────────────────────────────────────────

export interface HomeData {
  pet: { name: string; species: Species; mood: Mood; level: number };
  progression: {
    xp: number;
    xp_to_next: number;
    streak_days: number;
    together_time: string;
  };
  /** Multi-line statusline text (for StatuslinePanel — kept for compat). */
  statusline: string;
  /** 4-5 line ASCII statusline preview for HomeCenter box. */
  statuslinePreview: string;
  vitals: VitalsData;
  vitalsValues: VitalsValues;
  /** Real hp/hunger/energy/mood/bond stats — always present. */
  stats: { hp: number; hunger: number; energy: number; mood: number; bond: number };
  xp: { level: number; nextLevel: number; xp: number; xpToNext: number; xpToday: number; xpTodayCapped: boolean };
  /** XP awarded per day for the last 7 days (oldest → newest, zeros for missing days). */
  xpAwardedSeries: number[];
  /** 10 most recent facts (any status). */
  facts: Fact[];
  /** Up to 10 most recent critiques. Empty array when no telemetry/critique store. */
  critiques: Critique[];
  pendingCritiqueCount: number;
  /** Latest critique for the chat bubble. null when no critiques. */
  latestCritique: Critique | null;
  topbarBadges: {
    /** True if last feed action is approximated within 6h — see wellFedFromActions(). */
    wellFed: boolean;
    /**
     * Terse human-friendly duration only (e.g. "22 hrs" / "3 days" / "never").
     * The badge label ("dressed") is composed at the renderer layer, so the
     * value field stays clean for downstream UI use (TopBar, future widgets).
     */
    sinceDressed: string;
    /** Count of facts whose created_at falls in the same UTC day as `now`. */
    todayCount: number;
  };
  meta: {
    /** Real: derived from memory.personality_drift.snark mapped to 0-100%. */
    snarkPercent: number;
    /** Real: derived from latest pet_log entry day. "never" when empty. */
    lastPokeAt: string;
  };
  /** "Nd" — derived from streak_days_persistent (uncapped). */
  together: string;
  /** Optional user-set display title from memory.user_profile.name. */
  petTitle: string;
  /**
   * Real start date — formatted short "MMM d" (e.g. "may 14") from the oldest
   * pet_log entry. Null when no pet_log entries exist (pet never poked).
   */
  startDate: string | null;
  /**
   * Live nav trailing-meta strings for Dashboard sidebar injection.
   * Derived from real memory on every render — null when count is 0.
   */
  navMeta: {
    memory: string | null;
  };
  /**
   * Critic telemetry — drives the Gate / Budget / SkipHistogram cards under
   * the StatsPanel. Moved out of the standalone /stats page so the Home
   * dashboard surfaces operational state alongside the pet panel.
   */
  telemetry: CriticTelemetry;
  /**
   * Bias audit config from config.json (enabled flag only; safe to read as
   * unknown and fallback to disabled).
   */
  biasAuditConfig: { enabled: boolean };
  /** 7-day Haiku vs Ollama disagreement delta. */
  biasAuditDelta: BiasAuditDelta;
  /** Rubric FP calibration summary — null when calibration file not found. */
  rubricSummary: RubricSummary | null;
  /** Few-shot index stats — null when index not found. */
  fewShotStats: FewShotStats | null;
  /** Repo-memory index stats — null when index not built. */
  repoMemoryStats: RepoMemoryStats | null;
  /** Dual-model info for ModelsPanel. */
  modelsInfo: ModelsInfo;
  /**
   * Ephemeral Brain-health strip data. show=true only while
   * unhealthy (≥2 consecutive failures OR permanent class, 24h age-out);
   * clears automatically on the next Brain success.
   */
  brainHealth: UnhealthySignal;
}

export interface HomeDeps {
  /** Siltpoke project root (contains .siltpoke/, progression.json, memory.json, etc.). */
  basePath: string;
  /** Injectable for deterministic tests. Defaults to `new Date()`. */
  now?: Date;
}

// ── Constants ─────────────────────────────────────────────────────────────────

/** 6 hours in milliseconds — threshold for wellFed badge. */
export const WELL_FED_THRESHOLD_MS = 6 * 60 * 60 * 1000;

// ── Internal helpers (exported for unit testing) ──────────────────────────────

/**
 * Normalize a numeric series to exactly 7 elements.
 *
 * - Shorter than 7: prepend leading zeros so "today" stays at index 6.
 * - Longer than 7: take the tail (last 7 elements).
 * - Length 7: identity (returns a new array with same values).
 */
export function pad7d(values: number[]): number[] {
  if (values.length === 7) return [...values];
  if (values.length > 7) return values.slice(values.length - 7);
  const zeros = Array<number>(7 - values.length).fill(0);
  return [...zeros, ...values];
}

/**
 * Approximation: returns true if today's `daily_actions.feed` entry is > 0.
 *
 * NOTE: `DailyActions` is keyed by day string ("YYYY-MM-DD") — there is no
 * exact last-fed timestamp in the data model. This approximation treats any
 * feed action recorded today as "fed within 6h" (the true threshold from
 * WELL_FED_THRESHOLD_MS). A future pass should wire a real `last_fed_at` timestamp
 * if tighter precision is required.
 */
export function wellFedFromActions(
  daily_actions: DailyActions[] | undefined,
  now: Date,
): boolean {
  if (!daily_actions || daily_actions.length === 0) return false;
  const todayKey = now.toISOString().slice(0, 10);
  const todayEntry = daily_actions.find((e) => e.day === todayKey);
  return (todayEntry?.feed ?? 0) > 0;
}

/**
 * Terse human-friendly "time since dressed" badge text.
 *
 * Source: config.json file mtime is used as the "last dressed" approximation
 * (Q10A: dressing has no dedicated action in the current data model; config
 * writes happen when species/appearance is changed via /api/config).
 *
 * Format: "8 mins" / "22 hrs" / "3 days" / "never" (when configMtimeMs is null).
 */
export function sinceLastDressed(
  configMtimeMs: number | null,
  now: Date,
): string {
  if (configMtimeMs === null) return "never";
  // Clamp negative diffs to 0 — a future-dated mtime (e.g. fresh file write
  // captured before the injected `now` cursor in tests, or a clock-skewed
  // file system) would otherwise emit "-N mins" which is nonsense to the
  // user. Treat clock anomalies as "just dressed" / "0 mins".
  const diffMs = Math.max(0, now.getTime() - configMtimeMs);
  const diffMins = Math.floor(diffMs / 60_000);
  if (diffMins < 60) return `${diffMins} ${diffMins === 1 ? "min" : "mins"}`;
  const diffHrs = Math.floor(diffMins / 60);
  if (diffHrs < 48) return `${diffHrs} ${diffHrs === 1 ? "hr" : "hrs"}`;
  const diffDays = Math.floor(diffHrs / 24);
  return `${diffDays} ${diffDays === 1 ? "day" : "days"}`;
}

/**
 * Count facts whose `created_at` ISO string falls on the same UTC calendar
 * day as `now`.
 */
export function factsCreatedToday(facts: Fact[], now: Date): number {
  const todayPrefix = now.toISOString().slice(0, 10); // "YYYY-MM-DD"
  return facts.filter((f) => f.created_at.startsWith(todayPrefix)).length;
}

// ── Config helper (local to this module) ─────────────────────────────────────

async function loadConfigWithMtime(
  basePath: string,
): Promise<{ cfg: Record<string, unknown>; mtimeMs: number | null }> {
  const configPath = join(basePath, "config.json");
  if (!existsSync(configPath)) return { cfg: {}, mtimeMs: null };
  try {
    const [raw, stats] = await Promise.all([
      readFile(configPath, "utf8"),
      stat(configPath),
    ]);
    const cfg = JSON.parse(raw) as Record<string, unknown>;
    return { cfg, mtimeMs: stats.mtimeMs };
  } catch {
    return { cfg: {}, mtimeMs: null };
  }
}

// ── Rubric calibration parser ─────────────────────────────────────────────────

/**
 * Parse the rubric FP calibration markdown file and return a RubricSummary.
 * Reads the "Per-rule trigger counts" table. Returns null on any error.
 */
export async function loadRubricSummary(
  calibrationPath: string,
): Promise<RubricSummary | null> {
  if (!existsSync(calibrationPath)) return null;
  try {
    const text = await readFile(calibrationPath, "utf8");
    // Match table rows: | rule-id | count | ... |
    const rows: Array<{ rule_id: string; count: number }> = [];
    for (const line of text.split("\n")) {
      // Skip header/separator lines (contains "Rule" or dashes)
      if (line.includes("Rule") || line.includes("---")) continue;
      const match = line.match(/^\|\s*([a-z][a-z0-9-]+)\s*\|\s*(\d+)\s*\|/);
      if (match) {
        rows.push({ rule_id: match[1]!, count: Number(match[2]) });
      }
    }
    if (rows.length === 0) return null;
    const sorted = [...rows].sort((a, b) => b.count - a.count);
    return {
      totalRules: rows.length,
      topByTriggers: sorted.slice(0, 3),
    };
  } catch {
    return null;
  }
}

// ── Few-shot stats loader ─────────────────────────────────────────────────────

/**
 * Load few-shot index stats from the JSON file.
 * Detects embedder type by checking if node_modules/fastembed exists.
 */
export async function loadFewShotStats(
  indexPath: string,
  daemonCwd: string,
): Promise<FewShotStats | null> {
  if (!existsSync(indexPath)) return null;
  try {
    const raw = await readFile(indexPath, "utf8");
    const entries = JSON.parse(raw) as Array<{ embedding?: number[] }>;
    const firstEmbedding = entries[0]?.embedding;
    const dim = Array.isArray(firstEmbedding) ? firstEmbedding.length : 384;
    const hasFastembed = existsSync(join(daemonCwd, "node_modules", "fastembed"));
    return {
      entries: entries.length,
      dim,
      embedder: hasFastembed ? "fastembed" : "stub",
    };
  } catch {
    return null;
  }
}

// ── Repo-memory stats loader ──────────────────────────────────────────────────

/**
 * Load repo-memory index stats from index.json.
 * Returns null when file does not exist.
 */
export async function loadRepoMemoryStats(
  indexPath: string,
): Promise<RepoMemoryStats | null> {
  if (!existsSync(indexPath)) return null;
  try {
    const raw = await readFile(indexPath, "utf8");
    const index = JSON.parse(raw) as {
      files: Array<unknown>;
      conventions: Array<{ id: string; confidence: number }>;
    };
    const conventions = index.conventions ?? [];
    const sorted = [...conventions].sort((a, b) => b.confidence - a.confidence);
    const top = sorted[0] ?? null;
    return {
      files: (index.files ?? []).length,
      topConvention: top ? { id: top.id, confidence: top.confidence } : null,
    };
  } catch {
    return null;
  }
}

// ── Statusline composer ───────────────────────────────────────────────────────

function buildStatusline(opts: {
  petName: string;
  species: Species;
  mood: Mood;
  level: number;
  xp: number;
  xp_to_next: number;
  streak_days: number;
}): string {
  // Simple multi-line readable statusline.
  // composeOutput requires face/inner ASCII args not easily available here
  // without a full ASCII render pass — manual template is cleaner here.
  return [
    `siltpoke · ${opts.species}`,
    `mood:   ${opts.mood}`,
    `level:  ${opts.level} · ${opts.xp} / ${opts.xp_to_next} XP`,
    `streak: ${opts.streak_days} days`,
  ].join("\n");
}

function buildStatuslinePreview(opts: {
  level: number;
  xp: number;
  xp_to_next: number;
}): string {
  return [
    "  ___",
    " /o o\\",
    "`-----'",
    "siltpoke",
    "Sentinel",
    `L${opts.level} ${opts.xp}/${opts.xp_to_next}`,
  ].join("\n");
}

// ── Mood derivation ───────────────────────────────────────────────────────────

function deriveMoodFromProgression(
  streak: number,
  wellFed: boolean,
): Mood {
  if (wellFed && streak > 0) return "happy";
  if (streak > 3) return "happy";
  if (!wellFed) return "hungry";
  return "neutral";
}

// ── Main resolver ─────────────────────────────────────────────────────────────

export async function getHomeData(deps: HomeDeps): Promise<HomeData> {
  const now = deps.now ?? new Date();
  const { basePath } = deps;

  const home = homedir();
  const fewShotIndexPath = join(home, ".siltpoke", "few-shot-index.json");
  const repoMemoryIndexPath = join(home, ".siltpoke", "repo-memory", "index.json");
  // Calibration file is repo-relative — resolve from basePath into docs/.
  const calibrationPath = join(basePath, "docs", "RUBRIC-CALIBRATION.md");

  // Parallel reads — all independent.
  const [
    memory,
    progression,
    { cfg, mtimeMs },
    vitalsSeries,
    telemetry,
    biasAuditDelta,
    rubricSummary,
    fewShotStats,
    repoMemoryStats,
    brainHealthState,
  ] = await Promise.all([
    readMemory(basePath),
    readProgression(basePath),
    loadConfigWithMtime(basePath),
    readVitalsSeries(basePath, 7, now),
    readCriticTelemetry(basePath, now, { limit: 200, homeDir: home }),
    computeBiasAuditDelta({ now }),
    loadRubricSummary(calibrationPath),
    loadFewShotStats(fewShotIndexPath, basePath),
    loadRepoMemoryStats(repoMemoryIndexPath),
    readBrainHealthAsync(basePath),
  ]);

  // ── Pet identity ─────────────────────────────────────────────────────────

  const KNOWN_SPECIES: readonly Species[] = [
    "cat", "bunny", "robot", "bun", "otter", "alien", "slime", "crab",
  ];
  const speciesRaw = typeof cfg.species === "string" ? cfg.species : "";
  const species: Species = (KNOWN_SPECIES as readonly string[]).includes(speciesRaw)
    ? (speciesRaw as Species)
    : "slime";
  const name = typeof cfg.name === "string" ? cfg.name : "siltpoke";

  // ── Streak ───────────────────────────────────────────────────────────────

  // Use persistent streak counter (uncapped, tracks consecutive days).
  const streak_days = progression.streak_days_persistent;

  // ── Well-fed badge ───────────────────────────────────────────────────────

  const wellFed = wellFedFromActions(progression.daily_actions, now);

  // ── Mood ─────────────────────────────────────────────────────────────────

  const mood = deriveMoodFromProgression(streak_days, wellFed);

  // ── Pet shape ────────────────────────────────────────────────────────────

  const pet = { name, species, mood, level: progression.level };

  // ── Progression shape ────────────────────────────────────────────────────

  // Use streak_days_persistent (uncapped real counter).
  const together_time =
    progression.streak_days_persistent === 0
      ? "0 days"
      : `${progression.streak_days_persistent} days`;

  const progressionData = {
    xp: progression.xp,
    xp_to_next: progression.xp_to_next_level,
    streak_days,
    together_time,
  };

  // ── XP shape (for StatsPanel) ─────────────────────────────────────────────

  const xpData = xpPanelData(progression, now);

  // ── Stats: real hp/hunger/energy/mood/bond from progression.stats.
  const statsData = { ...progression.stats };

  // ── Vitals: real 7-day series from vitals.jsonl.
  const vitalsData: VitalsData = {
    mood:   vitalsSeries.mood,
    hunger: vitalsSeries.hunger,
    energy: vitalsSeries.energy,
    bond:   vitalsSeries.bond,
  };

  // Format stat fraction: integer when whole, 1-decimal otherwise (drops trailing .0).
  // Decay produces continuous floats — render trimmed for human display.
  const fmt = (n: number): string => {
    const rounded = Math.round(n * 10) / 10;
    return Number.isInteger(rounded) ? `${rounded}/10` : `${rounded.toFixed(1)}/10`;
  };
  const vitalsValues: VitalsValues = {
    // mood: label-only from derived mood (no /10 scale)
    mood:   mood,
    // hunger: fed/hungry from today's feed actions
    hunger: wellFed ? "fed" : "hungry",
    // energy: numeric display from real stats (1-decimal cap)
    energy: fmt(progression.stats.energy),
    // bond: numeric display from real stats (1-decimal cap)
    bond:   fmt(progression.stats.bond),
  };

  // ── Critiques: empty — no real critique store yet.
  // MOCK_CRITIQUES is not imported here (production path must be real).
  // CritiqueInbox renders "no critiques yet" empty state.
  // A future pass wires a real critique source (telemetry reader or critique JSONL).

  const critiques: Critique[] = [];
  const pendingCritiqueCount = 0;
  const latestCritique: Critique | null = null;

  // ── Vitals (legacy shape — kept for vitals.actions backward compat) ───────
  //
  // Build a sorted list of the last 7 daily_actions entries by day string.
  // Actions series = sum(feed+play+pet) per day.

  const allDays = [...(progression.daily_actions ?? [])].sort((a, b) =>
    a.day < b.day ? -1 : a.day > b.day ? 1 : 0,
  );
  const last7Days = allDays.slice(-7);
  const rawActions = last7Days.map((d) => d.feed + d.play + d.pet);

  // ── Facts: 10 most recent (by created_at desc) ───────────────────────────

  const allFacts = memory?.facts ?? [];
  const facts = [...allFacts]
    .sort((a, b) =>
      a.created_at > b.created_at ? -1 : a.created_at < b.created_at ? 1 : 0,
    )
    .slice(0, 10);

  // ── TopBar badges ────────────────────────────────────────────────────────

  const sinceDressed = sinceLastDressed(mtimeMs, now);
  const todayCount = factsCreatedToday(allFacts, now);

  const topbarBadges = {
    wellFed,
    sinceDressed,
    todayCount,
  };

  // ── Statusline (legacy multi-line text) ───────────────────────────────────

  const statusline = buildStatusline({
    petName: name,
    species,
    mood,
    level: progression.level,
    xp: progression.xp,
    xp_to_next: progression.xp_to_next_level,
    streak_days,
  });

  // ── Statusline preview (HomeCenter box) ───────────────────────────────────

  const statuslinePreview = buildStatuslinePreview({
    level: progression.level,
    xp: progression.xp,
    xp_to_next: progression.xp_to_next_level,
  });

  // ── Meta — wired to real progression + memory ────────────────────────────

  // snark: personality_drift.snark is an int in [-3, 3]. Map to a percent
  // (0 → 50%, +3 → 95%, -3 → 5%) — a friendly display surface for the user.
  // memory may be null when memory.json is missing — fall back to 0.
  const snarkRaw = memory?.personality_drift?.snark ?? 0;
  const snarkPercent = Math.max(0, Math.min(100, Math.round(50 + (snarkRaw / 3) * 45)));

  // Latest "poke" = latest pet_log entry (most recent day on which the pet
  // was poked). Fall back to "never" if pet_log is empty.
  const latestPetDay = progression.pet_log.length > 0
    ? progression.pet_log[progression.pet_log.length - 1]?.day
    : null;
  const lastPokeAt = latestPetDay
    ? relativeAgo(`${latestPetDay}T00:00:00Z`, now)
    : "never";

  const meta = { snarkPercent, lastPokeAt };

  // Together time = streak_days_persistent (real uncapped counter).
  const togetherDays = progression.streak_days_persistent;
  const together = togetherDays > 0 ? `${togetherDays}d` : "0d";

  // petTitle: optional user-set display title (per user_profile.name).
  // Falls back to empty string when unset / memory missing.
  const petTitle = typeof memory?.user_profile?.name === "string"
    ? memory.user_profile.name
    : "";

  // startDate: oldest pet_log entry, formatted "MMM d" lowercase ("may 14").
  // null when no entries (pet never poked).
  const startDate = (() => {
    const days = progression.pet_log.map((e) => e.day).sort();
    if (days.length === 0) return null;
    const oldest = days[0]!;
    const d = new Date(`${oldest}T00:00:00Z`);
    if (Number.isNaN(d.getTime())) return null;
    const MONTHS = ["jan","feb","mar","apr","may","jun","jul","aug","sep","oct","nov","dec"];
    return `${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()}`;
  })();

  // ── Nav meta — real counts for sidebar trailing-meta injection ────────────

  // facts count: plural-aware ("1 fact" / "N facts"), null when 0 (no meta shown).
  const factsCount = allFacts.length;
  const memoryMeta: string | null = factsCount > 0
    ? `${factsCount} ${factsCount === 1 ? "fact" : "facts"}`
    : null;

  const navMeta = { memory: memoryMeta };

  // Legacy actions series still computed for rawActions pad7d (shape compat).
  const _rawActionsPadded = pad7d(rawActions); // suppress unused-var

  // ── Bias audit config ─────────────────────────────────────────────────────
  // Read enabled flag from config.json biasAudit field; default disabled.
  const biasAuditCfgRaw = cfg.biasAudit;
  const biasAuditConfig: { enabled: boolean } = {
    enabled: typeof biasAuditCfgRaw === "object" &&
      biasAuditCfgRaw !== null &&
      (biasAuditCfgRaw as Record<string, unknown>).enabled === true,
  };

  // ── Models info ───────────────────────────────────────────────────────────
  // Read verifier mode from config.json (default "conditional").
  const verifierRaw = cfg.verifier;
  const verifierMode: "off" | "conditional" | "always" =
    verifierRaw === "off" || verifierRaw === "always" ? verifierRaw : "conditional";

  const modelsInfo: ModelsInfo = {
    primary: { name: "Claude Haiku 4.5", provider: "Anthropic" },
    biasAudit: {
      name: "Qwen2.5-Coder-7B-Q4",
      provider: "Local Ollama",
      enabled: biasAuditConfig.enabled,
    },
    verifierMode,
  };

  return {
    pet,
    progression: progressionData,
    statusline,
    statuslinePreview,
    vitals: vitalsData,
    vitalsValues,
    stats: statsData,
    xp: xpData,
    xpAwardedSeries: vitalsSeries.xp_awarded,
    facts,
    critiques,
    pendingCritiqueCount,
    latestCritique,
    topbarBadges,
    meta,
    together,
    petTitle,
    startDate,
    navMeta,
    telemetry,
    biasAuditConfig,
    biasAuditDelta,
    rubricSummary,
    fewShotStats,
    repoMemoryStats,
    modelsInfo,
    // Same predicate as the state-card ⚠ line.
    brainHealth: brainUnhealthySignal(brainHealthState, now),
  };
}
