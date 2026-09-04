// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
// Copyright (c) 2026 Jiaqi Duan

import { createHash } from "node:crypto";
import { closeSync, existsSync, openSync, readFileSync, writeSync } from "node:fs";
import { join } from "node:path";
import { atomicWrite } from "../utils/atomic-write";

const STALE_CLAIM_MS = 120_000;

export interface MarkerInput {
  session_id: string;
  /**
   * A hash of the transcript content at Stop-fire time. This is the identity of
   * a single logical Stop *event* — deterministic across every hook process
   * that fires for it, and different between distinct turns. It replaced an
   * earlier `stop_event_timestamp_ms` key: that field is NOT part of Claude
   * Code's real Stop payload, so both hook processes fell back to `Date.now()`
   * at different instants, produced different keys, and never collided — the
   * atomic claim silently did nothing and every turn was reviewed twice.
   */
  content_hash: string;
}

export interface Marker {
  state: "claimed" | "done";
  claimedAt: number;
  doneAt: number | null;
  staleClaim?: boolean;
}

export function markerKey(input: MarkerInput): string {
  return createHash("sha256")
    .update(`${input.session_id}|${input.content_hash}`)
    .digest("hex")
    .slice(0, 32);
}

/**
 * Hash the transcript file's bytes. Every hook process that fires for ONE Stop
 * event (a legacy settings.json hook + the plugin's hooks.json hook; or the
 * curl fast-path + the on-stop.ts command fallback) reads the SAME transcript
 * at the same instant — Claude has stopped, so the file is stable — so all of
 * them derive the identical hash and thus the identical marker key.
 *
 * Returns null ONLY when the path is missing or unreadable (fs throws). An
 * empty-but-readable file (e.g. `/dev/null`) hashes deterministically and is
 * a valid, collidable key — do NOT treat it as "no key", or two processes that
 * both read it would both review.
 */
export function hashTranscript(path: string): string | null {
  try {
    const buf = readFileSync(path);
    return createHash("sha256").update(buf).digest("hex").slice(0, 32);
  } catch {
    return null;
  }
}

/**
 * Derive the dedupe marker key for a Stop event from data BOTH firing hook
 * processes compute identically: session_id + a hash of the transcript content.
 * NEVER a wall-clock timestamp. Returns null when there is no usable transcript
 * to key on, signalling the caller to FAIL SOFT toward reviewing — a missed
 * dedupe costs one extra review once; a colliding or suppressing key drops a
 * real review silently, which is worse.
 */
export function deriveStopMarkerKey(event: {
  session_id?: string;
  transcript_path?: string;
}): string | null {
  const transcriptPath = event.transcript_path;
  if (!transcriptPath) return null;
  const contentHash = hashTranscript(transcriptPath);
  if (contentHash === null) return null;
  return markerKey({
    session_id: event.session_id ?? "",
    content_hash: contentHash,
  });
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
