// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
// Copyright (c) 2026 Jiaqi Duan
/**
 * Global identity store at `<home>/global.json`.
 *
 * Single-writer per-process via existing atomicWrite pattern. quarantineCorrupt
 * on parse failure (matches `memory.ts` v2 semantics). emptyGlobal() returns
 * a baseline shape suitable for fresh installs.
 */
import { writeFile, rename, readFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { quarantineCorrupt } from "../utils/quarantine";
import {
  globalSchema,
  type GlobalMemory,
} from "./schema-v3";

const FILENAME = "global.json";

function globalPath(home: string): string {
  return join(home, FILENAME);
}

export function emptyGlobal(now: Date = new Date()): GlobalMemory {
  const today = now.toISOString().slice(0, 10);
  return {
    schemaVersion: 3,
    name: "siltpoke",
    species: "cat",
    appearance: { head: "cat", face: "neutral", legs: "default" },
    level: 1,
    xp_total: 0,
    xp_log: [],
    achievements_unlocked: [],
    streak: { current_days: 0, longest_days: 0, last_qualifying_local_date: null },
    bond_meter: 0,
    daily_caps_state: { local_date: today, per_source_counts: {} },
    personality_base: {
      snark: 0,
      patience: 0,
      style_strictness: 0,
      proactivity: 0,
      curiosity: 0,
    },
    user_profile: { name: "", communication_style: "neutral" },
    facts: [],
  };
}

export async function readGlobal(home: string): Promise<GlobalMemory | null> {
  const path = globalPath(home);
  if (!existsSync(path)) return null;
  let parsed: unknown;
  try {
    const raw = await readFile(path, "utf8");
    parsed = JSON.parse(raw);
  } catch {
    await quarantineCorrupt(path);
    return null;
  }
  const result = globalSchema.safeParse(parsed);
  if (!result.success) {
    await quarantineCorrupt(path);
    return null;
  }
  return result.data;
}

export async function writeGlobal(
  home: string,
  memory: GlobalMemory,
): Promise<void> {
  try {
    await mkdir(home, { recursive: true });
    const finalPath = globalPath(home);
    const tmpPath = `${finalPath}.tmp.${process.pid}.${Date.now()}.${randomBytes(4).toString("hex")}`;
    await writeFile(tmpPath, JSON.stringify(memory, null, 2), "utf8");
    await rename(tmpPath, finalPath);
  } catch {
    // Match v2 writeMemory semantics — never crash the caller.
  }
}
