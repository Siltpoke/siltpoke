// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Copyright (c) 2026 Jiaqi Duan
import { writeFile, rename, readFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { randomBytes } from "node:crypto";

export interface FaceState {
  schemaVersion: 1;
  mood: string;
  pose: string;
  bubble_short: string;
  severity: string;
  confidence: string;
  last_updated_ms: number;
  last_session_id: string;
}

const FILENAME = "state.json";
const DEFAULT_STALE_MS = 30 * 60 * 1000;

function statePath(basePath: string): string {
  return join(basePath, FILENAME);
}

export async function writeState(
  basePath: string,
  state: FaceState,
): Promise<void> {
  try {
    await mkdir(basePath, { recursive: true });
    const finalPath = statePath(basePath);
    const tmpPath = `${finalPath}.tmp.${process.pid}.${Date.now()}.${randomBytes(4).toString("hex")}`;
    await writeFile(tmpPath, JSON.stringify(state, null, 2), "utf8");
    await rename(tmpPath, finalPath);
  } catch {
    // Writer failures must never crash the hook.
  }
}

export async function readState(basePath: string): Promise<FaceState | null> {
  const path = statePath(basePath);
  if (!existsSync(path)) return null;
  try {
    const raw = await readFile(path, "utf8");
    const parsed = JSON.parse(raw) as Partial<FaceState>;
    if (parsed.schemaVersion !== 1) return null;
    if (
      typeof parsed.mood !== "string" ||
      typeof parsed.pose !== "string" ||
      typeof parsed.bubble_short !== "string" ||
      typeof parsed.severity !== "string" ||
      typeof parsed.confidence !== "string" ||
      typeof parsed.last_updated_ms !== "number" ||
      typeof parsed.last_session_id !== "string"
    ) {
      return null;
    }
    return parsed as FaceState;
  } catch {
    return null;
  }
}

export function isStale(
  state: FaceState,
  maxAgeMs: number = DEFAULT_STALE_MS,
  now: number = Date.now(),
): boolean {
  return now - state.last_updated_ms > maxAgeMs;
}
