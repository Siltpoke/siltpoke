// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Copyright (c) 2026 Jiaqi Duan
import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { basename, join } from "node:path";
import { readProgression } from "../state/progression";
import { readState, isStale } from "../state/state";
import { loadPersonality } from "../brain/personality";
import { loadDailyRollup } from "../state/usage";
import { loadBudgetConfig } from "../state/budget-config";
import { loadTriggerConfig } from "../router/trigger-modes";
import { readStatus } from "../state/critique-status";
import { readMute } from "../state/mute";
import { readBrainHealth, brainUnhealthySignal } from "../state/brain-health";

function siltpokeHome(envHome: string | undefined): string {
  return join(envHome ?? "", ".siltpoke");
}

export interface CardOptions {
  homeBase?: string;
  now?: () => Date;
}

export interface ProjectSummary {
  cwd: string;
  short_name: string;
  calls_today: number;
  pending_critiques: number;
}

export interface MuteStatus {
  /** Indefinite mute. When true, `until_ms` is null. */
  indefinite: boolean;
  /** Epoch ms when mute expires. null when indefinite or no mute. */
  until_ms: number | null;
  /** Human-readable line shown on the card (e.g. "muted until 16:30 (35m left)"). */
  display: string;
}

export interface CardResult {
  name: string;
  species: string;
  level: number;
  xp: number;
  xp_to_next_level: number;
  xp_progress_bar: string;
  titles: string[];
  mood: string;
  bubble: string;
  trigger_mode: string;
  brain_calls_today: number;
  reflections_today: number;
  cost_today_usd: number;
  sparkline_7d: string;
  projects: ProjectSummary[];
  /** Active mute marker — null when not muted (or marker expired). */
  mute: MuteStatus | null;
  /**
   * ⚠ one-liner when Brain is unhealthy (≥2 consecutive
   * transient failures OR a permanent-class failure; 24h age-out).
   * null when healthy — clears automatically on the next success.
   */
  brain_warning: string | null;
  card_text: string;
}

function progressBar(xp: number, target: number, width: number = 20): string {
  const ratio = target > 0 ? Math.min(1, Math.max(0, xp / target)) : 0;
  const filled = Math.round(ratio * width);
  const pct = Math.round(ratio * 100);
  return `[${"█".repeat(filled)}${"░".repeat(Math.max(0, width - filled))}] ${pct}%`;
}

const SPARK_CHARS = ["▁", "▂", "▃", "▄", "▅", "▆", "▇", "█"] as const;

/**
 * Render an ASCII sparkline of brain-call counts for the last `days` days.
 * Buckets timestamps by UTC date and scales each bucket to one of 8 Unicode
 * block heights. Empty buckets render as a space so missing days are visible.
 */
export function buildSparkline(
  timestamps: readonly string[],
  now: Date,
  days: number = 7,
): string {
  const buckets = new Array<number>(days).fill(0);
  const todayKey = now.toISOString().slice(0, 10);
  const todayMs = Date.parse(`${todayKey}T00:00:00Z`);
  for (const ts of timestamps) {
    const t = Date.parse(ts);
    if (!Number.isFinite(t)) continue;
    // Align timestamp to its own UTC midnight so a 12:00 timestamp on today
    // doesn't read as -1 day relative to today's midnight reference.
    const tKey = new Date(t).toISOString().slice(0, 10);
    const tMidnightMs = Date.parse(`${tKey}T00:00:00Z`);
    const offsetDays = Math.round((todayMs - tMidnightMs) / 86_400_000);
    if (offsetDays < 0 || offsetDays >= days) continue;
    const bucketIdx = days - 1 - offsetDays;
    buckets[bucketIdx] = (buckets[bucketIdx] ?? 0) + 1;
  }
  const max = buckets.reduce((m, v) => Math.max(m, v), 0);
  if (max === 0) return " ".repeat(days);
  return buckets
    .map((v) => {
      if (v === 0) return " ";
      const ratio = v / max;
      const idx = Math.min(
        SPARK_CHARS.length - 1,
        Math.max(0, Math.round(ratio * (SPARK_CHARS.length - 1))),
      );
      return SPARK_CHARS[idx]!;
    })
    .join("");
}

interface BrainCallRow {
  timestamp?: string;
  cwd?: string;
  skipped?: string;
}

async function readBrainCallTimestamps(
  homeBase: string,
): Promise<{ ts: string; cwd: string }[]> {
  const path = join(homeBase, "brain-calls.jsonl");
  if (!existsSync(path)) return [];
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch {
    return [];
  }
  const rows: { ts: string; cwd: string }[] = [];
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    try {
      const parsed = JSON.parse(line) as BrainCallRow;
      if (parsed.skipped) continue; // skip-decision entries aren't real calls
      if (parsed.timestamp && parsed.cwd) {
        rows.push({ ts: parsed.timestamp, cwd: parsed.cwd });
      }
    } catch {
      // ignore malformed lines
    }
  }
  return rows;
}

interface HistoryEntry {
  critique_id?: string;
  path?: string;
}

async function countPendingCritiques(projectBase: string): Promise<number> {
  const historyPath = join(projectBase, "critiques", "history.jsonl");
  if (!existsSync(historyPath)) return 0;
  let raw: string;
  try {
    raw = await readFile(historyPath, "utf8");
  } catch {
    return 0;
  }
  let pending = 0;
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    let entry: HistoryEntry;
    try {
      entry = JSON.parse(line) as HistoryEntry;
    } catch {
      continue;
    }
    if (!entry.path) continue;
    const status = await readStatus(entry.path);
    if (status === "pending") pending += 1;
  }
  return pending;
}

async function buildPerProjectSummary(
  rows: { ts: string; cwd: string }[],
  todayKey: string,
): Promise<ProjectSummary[]> {
  const byCwd = new Map<string, number>();
  for (const row of rows) {
    if (!row.ts.startsWith(todayKey)) continue;
    byCwd.set(row.cwd, (byCwd.get(row.cwd) ?? 0) + 1);
  }
  // Also surface projects with pending critiques but no calls today.
  const allCwds = new Set<string>(byCwd.keys());
  for (const row of rows) allCwds.add(row.cwd);

  const summaries: ProjectSummary[] = [];
  for (const cwd of allCwds) {
    const projectBase = join(cwd, ".siltpoke");
    const pending = await countPendingCritiques(projectBase);
    const calls = byCwd.get(cwd) ?? 0;
    if (calls === 0 && pending === 0) continue;
    summaries.push({
      cwd,
      short_name: basename(cwd) || cwd,
      calls_today: calls,
      pending_critiques: pending,
    });
  }
  summaries.sort((a, b) => {
    if (b.pending_critiques !== a.pending_critiques) {
      return b.pending_critiques - a.pending_critiques;
    }
    return b.calls_today - a.calls_today;
  });
  return summaries;
}

function formatMuteDisplay(mute: { indefinite: boolean; until_ms: number | null }, now: Date): string {
  if (mute.indefinite) return "muted (indefinite — /siltpoke-unmute to resume)";
  if (mute.until_ms === null) return "muted";
  const remainingMs = mute.until_ms - now.getTime();
  if (remainingMs <= 0) return ""; // expired — caller treats as not-muted
  const d = new Date(mute.until_ms);
  const hh = String(d.getHours()).padStart(2, "0");
  const mn = String(d.getMinutes()).padStart(2, "0");
  const mins = Math.round(remainingMs / 60_000);
  const remainingLabel =
    mins >= 1440 ? `${Math.floor(mins / 1440)}d left`
      : mins >= 60 ? `${Math.floor(mins / 60)}h ${mins % 60}m left`
      : `${mins}m left`;
  return `muted until ${hh}:${mn} (${remainingLabel})`;
}

function formatCard(r: Omit<CardResult, "card_text">): string {
  const titles = r.titles.length > 0 ? r.titles.join(", ") : "(none)";
  const lines: string[] = [
    `┌─ Siltpoke ─────────────────────────────────────`,
    `│ ${r.name} the ${r.species}`,
    `│ level ${r.level}  ${r.xp_progress_bar}  (${r.xp}/${r.xp_to_next_level} XP)`,
    `│ titles: ${titles}`,
    `│ mood: ${r.mood}${r.bubble ? `  "${r.bubble}"` : ""}`,
  ];
  if (r.mute !== null) {
    lines.push(`│ ${r.mute.display}`);
  }
  if (r.brain_warning !== null) {
    lines.push(`│ ${r.brain_warning}`);
  }
  lines.push(
    `│ today: ${r.brain_calls_today} brain calls, ${r.reflections_today} reflections, $${r.cost_today_usd.toFixed(4)} spent`,
    `│ mode: ${r.trigger_mode}`,
    `│ last 7d: ${r.sparkline_7d}`,
  );
  if (r.projects.length > 0) {
    lines.push(`│`);
    lines.push(`│ projects:`);
    const nameWidth = r.projects.reduce(
      (m, p) => Math.max(m, p.short_name.length),
      0,
    );
    for (const p of r.projects) {
      const name = p.short_name.padEnd(nameWidth, " ");
      lines.push(
        `│   ${name}  ${p.calls_today} call${p.calls_today === 1 ? "" : "s"} today  ·  ${p.pending_critiques} pending`,
      );
    }
  }
  lines.push(`└────────────────────────────────────────────────`);
  return lines.join("\n");
}

export async function runCard(opts: CardOptions = {}): Promise<CardResult> {
  const homeBase = opts.homeBase ?? siltpokeHome(process.env.HOME);
  const now = (opts.now ?? (() => new Date()))();

  const [personality, progression, state, budgetConfig, triggerConfig] =
    await Promise.all([
      loadPersonality(homeBase),
      readProgression(homeBase),
      readState(homeBase),
      loadBudgetConfig(homeBase),
      loadTriggerConfig(homeBase),
    ]);

  const rollup = await loadDailyRollup(
    homeBase,
    now,
    budgetConfig.resetAtMinutes,
  );

  const stateFresh =
    state !== null && !isStale(state, undefined, now.getTime());
  const mood = stateFresh ? state.mood : "idle";
  const bubble = stateFresh ? state.bubble_short : "";

  const brainRows = await readBrainCallTimestamps(homeBase);
  const sparkline = buildSparkline(
    brainRows.map((r) => r.ts),
    now,
  );
  const projects = await buildPerProjectSummary(
    brainRows,
    now.toISOString().slice(0, 10),
  );

  // v1.1-I — surface active mute status on the card so the user doesn't
  // forget. Expired markers count as not-muted (file may linger).
  const muteFile = readMute(homeBase);
  let mute: MuteStatus | null = null;
  if (muteFile !== null) {
    const isActive = muteFile.indefinite || (muteFile.until_ms !== null && muteFile.until_ms > now.getTime());
    if (isActive) {
      const display = formatMuteDisplay(muteFile, now);
      mute = {
        indefinite: muteFile.indefinite,
        until_ms: muteFile.until_ms,
        display,
      };
    }
  }

  // Shared unhealthy predicate (same as dashboard strip).
  const brainSignal = brainUnhealthySignal(readBrainHealth(homeBase), now);

  const base: Omit<CardResult, "card_text"> = {
    name: personality.name,
    species: personality.species,
    level: progression.level,
    xp: progression.xp,
    xp_to_next_level: progression.xp_to_next_level,
    xp_progress_bar: progressBar(
      progression.xp,
      progression.xp_to_next_level,
    ),
    titles: progression.unlocked_titles,
    mood,
    bubble,
    trigger_mode: triggerConfig.mode,
    brain_calls_today: rollup.brain_calls,
    reflections_today: rollup.reflections,
    cost_today_usd: rollup.total_cost_usd,
    sparkline_7d: sparkline,
    projects,
    mute,
    brain_warning: brainSignal.show ? brainSignal.line : null,
  };

  return { ...base, card_text: formatCard(base) };
}

if (import.meta.main) {
  const r = await runCard();
  process.stdout.write(`${r.card_text}\n`);
  process.exit(0);
}
