// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
// Copyright (c) 2026 Jiaqi Duan
import { writeFile, rename, readFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { randomBytes } from "node:crypto";

/** A prompt-injection alert on the pet bubble; stays until a clean review in the same project. */
export interface FaceAlert {
  text: string;
  project: string;
  at: number;
}

export type AlertUpdate = { set: FaceAlert } | "keep" | "clear";

export interface FaceState {
  schemaVersion: 1;
  mood: string;
  pose: string;
  bubble_short: string;
  severity: string;
  confidence: string;
  last_updated_ms: number;
  last_session_id: string;
  alert?: FaceAlert;
}

const FILENAME = "state.json";
const DEFAULT_STALE_MS = 30 * 60 * 1000;

function statePath(basePath: string): string {
  return join(basePath, FILENAME);
}

/** Atomic write. Resolves `true` when the file was written, `false` on a swallowed failure. */
export async function writeState(
  basePath: string,
  state: FaceState,
): Promise<boolean> {
  try {
    await mkdir(basePath, { recursive: true });
    const finalPath = statePath(basePath);
    const tmpPath = `${finalPath}.tmp.${process.pid}.${Date.now()}.${randomBytes(4).toString("hex")}`;
    await writeFile(tmpPath, JSON.stringify(state, null, 2), "utf8");
    await rename(tmpPath, finalPath);
    return true;
  } catch {
    // Writer failures must never crash the hook.
    return false;
  }
}

/**
 * Write `next` and decide the alert in the same step: read the file's current
 * alert, apply `update`, write once. A plain `writeState` drops the alert, so
 * every writer goes through here; non-review writers pass "keep".
 */
export async function writeStateKeepingAlert(
  basePath: string,
  next: Omit<FaceState, "alert">,
  update: AlertUpdate,
): Promise<boolean> {
  try {
    const alert =
      update === "keep" ? (await readState(basePath))?.alert
        : update === "clear" ? undefined
        : update.set;
    return await writeState(basePath, alert ? { ...next, alert } : { ...next });
  } catch {
    // Writer failures must never crash the hook.
    return false;
  }
}

/**
 * Drop the alert and leave the rest of the file alone (a clean review whose bubble is blank).
 * `true` when the file was rewritten; `false` when there was no alert to drop.
 */
export async function clearAlert(basePath: string): Promise<boolean> {
  try {
    const cur = await readState(basePath);
    if (cur?.alert === undefined) return false;
    const { alert: _alert, ...rest } = cur;
    return await writeState(basePath, rest);
  } catch {
    // never crash
    return false;
  }
}

/**
 * Set the alert and leave the rest of the file alone (a review whose bubble is blank).
 * With no readable file there is nothing to merge into: `fallback` is written with the
 * alert, so a blanked review's alert is never lost. `true` when the file was written.
 */
export async function setAlert(basePath: string, alert: FaceAlert, fallback: Omit<FaceState, "alert">): Promise<boolean> {
  try {
    const cur = await readState(basePath);
    return await writeState(basePath, { ...(cur ?? fallback), alert });
  } catch {
    // never crash
    return false;
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
    const a = parsed.alert as Partial<FaceAlert> | undefined | null;
    const alertOk =
      a !== undefined && a !== null && typeof a.text === "string" && typeof a.project === "string" && typeof a.at === "number";
    const { alert: _drop, ...rest } = parsed;
    return (alertOk ? { ...rest, alert: a as FaceAlert } : rest) as FaceState;
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
