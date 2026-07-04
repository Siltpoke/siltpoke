// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
// Copyright (c) 2026 Jiaqi Duan
/**
 * v1.1-I — mute marker state.
 *
 * Persists `~/.siltpoke/mute.json` (or `<siltpokeHome>/mute.json`). The
 * router checks `isMuted()` BEFORE every other gate, including wake
 * bypass — mute beats wake.
 */
import { readFileSync, existsSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { atomicWrite } from "../utils/atomic-write";

export const MUTE_FILENAME = "mute.json";
export const MUTE_SCHEMA_VERSION = 1;

export interface MuteFile {
  schemaVersion: 1;
  /** Epoch ms when mute expires. `null` iff `indefinite` is true. */
  until_ms: number | null;
  /** True iff the user asked for indefinite mute (no auto-expiry). */
  indefinite: boolean;
  /** ISO 8601 timestamp when the mute was set, for observability. */
  set_at: string;
}

function mutePath(homeBase: string): string {
  return join(homeBase, MUTE_FILENAME);
}

/**
 * Read + validate `<homeBase>/mute.json`. Returns null when absent,
 * corrupt, or wrong schemaVersion. (Fail-open — caller
 * treats null as "not muted".)
 */
export function readMute(homeBase: string): MuteFile | null {
  const path = mutePath(homeBase);
  if (!existsSync(path)) return null;
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return null;
  }
  const m = parsed as Record<string, unknown>;
  if (m.schemaVersion !== MUTE_SCHEMA_VERSION) return null;
  if (typeof m.indefinite !== "boolean") return null;
  if (m.indefinite) {
    if (m.until_ms !== null) return null;
  } else {
    if (typeof m.until_ms !== "number" || !Number.isFinite(m.until_ms)) return null;
  }
  if (typeof m.set_at !== "string") return null;
  return {
    schemaVersion: 1,
    until_ms: m.indefinite ? null : (m.until_ms as number),
    indefinite: m.indefinite,
    set_at: m.set_at,
  };
}

/** Write `<homeBase>/mute.json` atomically. */
export function writeMute(homeBase: string, mute: MuteFile): string {
  const path = mutePath(homeBase);
  atomicWrite(path, `${JSON.stringify(mute, null, 2)}\n`);
  return path;
}

/**
 * Delete `<homeBase>/mute.json`. Returns true iff the file existed
 * before this call.
 */
export function clearMute(homeBase: string): boolean {
  const path = mutePath(homeBase);
  if (!existsSync(path)) return false;
  try {
    unlinkSync(path);
    return true;
  } catch {
    // File vanished between existsSync + unlinkSync (race). Treat as "didn't exist".
    return false;
  }
}

/**
 * True iff the mute marker is present, valid, and active.
 *
 * - Missing / corrupt / wrong-schema file → false (fail-open)
 * - Indefinite → true
 * - Timed but expired (`until_ms <= now.getTime()`) → false —
 *   router treats expired as not-muted; file lingers harmlessly until
 *   `/siltpoke-unmute` runs)
 * - Timed and not expired → true
 */
export function isMuted(homeBase: string, now: Date): boolean {
  const mute = readMute(homeBase);
  if (mute === null) return false;
  if (mute.indefinite) return true;
  if (mute.until_ms === null) return false; // defensive — already covered by schema check
  return mute.until_ms > now.getTime();
}
