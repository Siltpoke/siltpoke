// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Copyright (c) 2026 Jiaqi Duan
import { openSync, closeSync, writeSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { atomicWrite } from "../utils/atomic-write";

const STALE_CLAIM_MS = 120_000;

export interface MarkerInput {
  session_id: string;
  stop_event_timestamp_ms: number;
}

export interface Marker {
  state: "claimed" | "done";
  claimedAt: number;
  doneAt: number | null;
  staleClaim?: boolean;
}

export function markerKey(input: MarkerInput): string {
  return createHash("sha256")
    .update(`${input.session_id}|${input.stop_event_timestamp_ms}`)
    .digest("hex")
    .slice(0, 32);
}

function markerPath(dir: string, key: string): string {
  return join(dir, `${key}.marker`);
}

/**
 * Atomically claims a marker via O_CREAT | O_EXCL.
 * Returns true if this caller won the claim, false if another caller already
 * claimed the same key.
 */
export function claimMarker(dir: string, key: string): boolean {
  const path = markerPath(dir, key);
  let fd: number;
  try {
    fd = openSync(path, "wx"); // O_CREAT | O_EXCL | O_WRONLY
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "EEXIST") return false;
    throw err;
  }
  const body: Marker = { state: "claimed", claimedAt: Date.now(), doneAt: null };
  writeSync(fd, JSON.stringify(body));
  closeSync(fd);
  return true;
}

export function completeMarker(dir: string, key: string): void {
  const path = markerPath(dir, key);
  if (!existsSync(path)) return;
  const body = JSON.parse(readFileSync(path, "utf8")) as Marker;
  const next: Marker = { ...body, state: "done", doneAt: Date.now() };
  atomicWrite(path, JSON.stringify(next));
}

export function readMarker(dir: string, key: string): Marker | null {
  const path = markerPath(dir, key);
  if (!existsSync(path)) return null;
  try {
    const m = JSON.parse(readFileSync(path, "utf8")) as Marker;
    if (m.state === "claimed" && Date.now() - m.claimedAt > STALE_CLAIM_MS) {
      return { ...m, staleClaim: true };
    }
    return m;
  } catch {
    return null;
  }
}
