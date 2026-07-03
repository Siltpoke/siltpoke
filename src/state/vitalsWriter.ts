// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Copyright (c) 2026 Jiaqi Duan
/**
 * Vitals JSONL writer.
 *
 * Appends a daily snapshot to vitals.jsonl on the first action of a new
 * UTC day. Retains at most VITALS_RETENTION entries (head-drop).
 */
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { Progression } from "./progression";
import { ACTION_BASE_XP } from "./progression";

export interface VitalsSnapshot {
  readonly day: string;
  readonly hp: number;
  readonly hunger: number;
  readonly energy: number;
  readonly mood: number;
  readonly bond: number;
  readonly xp_awarded: number;
}

const VITALS_RETENTION = 30;
const VITALS_FILE = "vitals.jsonl";

function vitalsPath(basePath: string): string {
  return join(basePath, VITALS_FILE);
}

function yesterdayOf(now: Date): string {
  const d = new Date(now);
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
}

async function readLines(path: string): Promise<VitalsSnapshot[]> {
  if (!existsSync(path)) return [];
  try {
    const raw = await readFile(path, "utf8");
    const lines = raw.split("\n").filter((l) => l.trim().length > 0);
    const snapshots: VitalsSnapshot[] = [];
    for (const line of lines) {
      try {
        snapshots.push(JSON.parse(line) as VitalsSnapshot);
      } catch {
        // Skip malformed lines.
      }
    }
    return snapshots;
  } catch {
    return [];
  }
}

async function writeLines(basePath: string, snapshots: VitalsSnapshot[]): Promise<void> {
  await mkdir(basePath, { recursive: true });
  const content = snapshots.map((s) => JSON.stringify(s)).join("\n") + (snapshots.length > 0 ? "\n" : "");
  await writeFile(vitalsPath(basePath), content, "utf8");
}

/**
 * Compute XP awarded on a given day from daily_actions, priced by the
 * single ACTION_BASE_XP table.
 */
function computeXpAwarded(prog: Progression, day: string): number {
  const entry = (prog.daily_actions ?? []).find((e) => e.day === day);
  if (!entry) return 0;
  return (
    entry.feed  * ACTION_BASE_XP.feed +
    entry.play  * ACTION_BASE_XP.play +
    entry.pet   * ACTION_BASE_XP.pet +
    (entry.clean ?? 0) * ACTION_BASE_XP.clean +
    (entry.sleep ?? 0) * ACTION_BASE_XP.sleep +
    entry.tease * ACTION_BASE_XP.tease
  );
}

function todayOf(now: Date): string {
  return new Date(now).toISOString().slice(0, 10);
}

function buildSnapshot(prog: Progression, day: string): VitalsSnapshot {
  return {
    day,
    hp:     prog.stats.hp,
    hunger: prog.stats.hunger,
    energy: prog.stats.energy,
    mood:   prog.stats.mood,
    bond:   prog.stats.bond,
    xp_awarded: computeXpAwarded(prog, day),
  };
}

/**
 * Append (or update) snapshots in vitals.jsonl so the dashboard sparkline
 * has live data:
 *   - Yesterday: written ONCE when the first action of a new UTC day fires
 *     (idempotent, guarded by hadActionYesterday).
 *   - Today: overwritten on every call so the latest stats land in the
 *     7-day window immediately, even before the next day rolls over.
 *     Without this, fresh installs show a flat-zero sparkline for the
 *     entire first day — confusing for new users.
 *
 * Trims file to last VITALS_RETENTION entries after writing.
 */
export async function maybeWriteSnapshot(
  prog: Progression,
  now: Date,
  basePath: string,
): Promise<void> {
  const yesterday = yesterdayOf(now);
  const today = todayOf(now);

  const path = vitalsPath(basePath);
  const existing = await readLines(path);

  // Build the next snapshot list. Replace today's entry if present so the
  // latest stats overwrite the prior snapshot for the same day.
  let next: VitalsSnapshot[] = existing.filter((s) => s.day !== today);

  // Append yesterday's snapshot once (idempotent + only if user was active).
  const hadActionYesterday = (prog.daily_actions ?? []).some(
    (e) => e.day === yesterday,
  );
  const yesterdayMissing = !existing.some((s) => s.day === yesterday);
  if (hadActionYesterday && yesterdayMissing) {
    next = [...next, buildSnapshot(prog, yesterday)];
  }

  // Always (re)write today's snapshot so the sparkline reflects current state.
  next = [...next, buildSnapshot(prog, today)];

  // Sort by day ascending so retention head-drop keeps the most recent days.
  next.sort((a, b) => (a.day < b.day ? -1 : a.day > b.day ? 1 : 0));
  const trimmed = next.slice(-VITALS_RETENTION);

  await writeLines(basePath, trimmed);
}
