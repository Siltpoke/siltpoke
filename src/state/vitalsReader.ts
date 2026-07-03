// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Copyright (c) 2026 Jiaqi Duan
/**
 * Vitals JSONL reader.
 *
 * Reads vitals.jsonl and returns 7-day zero-padded series for each stat.
 */
import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { VitalsSnapshot } from "./vitalsWriter";

export interface VitalsSeries {
  hp: number[];
  hunger: number[];
  energy: number[];
  mood: number[];
  bond: number[];
  xp_awarded: number[];
}

const VITALS_FILE = "vitals.jsonl";

function vitalsPath(basePath: string): string {
  return join(basePath, VITALS_FILE);
}

async function readSnapshots(basePath: string): Promise<VitalsSnapshot[]> {
  const path = vitalsPath(basePath);
  if (!existsSync(path)) return [];
  try {
    const raw = await readFile(path, "utf8");
    const snapshots: VitalsSnapshot[] = [];
    for (const line of raw.split("\n")) {
      if (!line.trim()) continue;
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

/**
 * Build the list of `days` UTC date strings ending with TODAY relative to
 * `now` (oldest first). Today is included because vitalsWriter now writes
 * a live today snapshot on every action — including today in the window
 * means the sparkline reflects current state instead of always trailing
 * by a day.
 */
function buildDateRange(days: number, now: Date): string[] {
  const dates: string[] = [];
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(now);
    d.setUTCDate(d.getUTCDate() - i);
    dates.push(d.toISOString().slice(0, 10));
  }
  return dates;
}

/**
 * Read the last `days` days of vitals data from vitals.jsonl.
 * Missing days are filled with zeros.
 * Arrays are ordered oldest → newest.
 */
export async function readVitalsSeries(
  basePath: string,
  days: number = 7,
  now: Date = new Date(),
): Promise<VitalsSeries> {
  const snapshots = await readSnapshots(basePath);
  const byDay = new Map<string, VitalsSnapshot>(snapshots.map((s) => [s.day, s]));

  const dates = buildDateRange(days, now);
  const hp: number[] = [];
  const hunger: number[] = [];
  const energy: number[] = [];
  const mood: number[] = [];
  const bond: number[] = [];
  const xp_awarded: number[] = [];

  for (const date of dates) {
    const snap = byDay.get(date);
    hp.push(snap?.hp ?? 0);
    hunger.push(snap?.hunger ?? 0);
    energy.push(snap?.energy ?? 0);
    mood.push(snap?.mood ?? 0);
    bond.push(snap?.bond ?? 0);
    xp_awarded.push(snap?.xp_awarded ?? 0);
  }

  return { hp, hunger, energy, mood, bond, xp_awarded };
}
