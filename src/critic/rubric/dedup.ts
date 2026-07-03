// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Copyright (c) 2026 Jiaqi Duan
/**
 * Cross-Stop suppression for deterministic rubric flags.
 *
 * Rubric rules (god-file, etc.) fire deterministically on every Stop: an
 * unchanged 900-line file re-emits the identical flag each time, spamming the
 * critique surface and the archive (1,002 such repeats measured in siltpoke's own archive). This is NOT
 * episodic memory; the right fix is a cheap deterministic ledger.
 *
 * Policy: a flag is shown at most once per `ttlMs` (default 24h). The key
 * embeds the message, which embeds the LOC count — so a materially changed
 * file produces a new key and re-surfaces immediately. Suppression expires
 * `ttlMs` after the flag was last *surfaced* (not last seen), so a persistently
 * oversized file is re-flagged about once a day rather than every Stop.
 *
 * The ledger is a non-critical cache: any read/write error degrades to
 * "surface everything" rather than crashing the critic. Disable entirely with
 * `SILTPOKE_RUBRIC_DEDUP=0`.
 */
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { atomicWrite } from "../../utils/atomic-write";
import type { RubricTrigger } from "./types";

/** suppression-key → ISO timestamp the flag was last *surfaced* to the user. */
export type SeenLedger = Record<string, string>;

const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000;
const LEDGER_FILE = "rubric-seen.json";

/**
 * Stable suppression key: rule + file + a hash of the message. The message
 * carries the rule's specifics (e.g. the LOC count), so the key changes the
 * moment the underlying condition changes materially.
 */
export function suppressionKey(t: RubricTrigger): string {
  const h = createHash("sha256").update(t.message).digest("hex").slice(0, 16);
  return `${t.rule_id}::${t.file}::${h}`;
}

/**
 * Split triggers into the ones to surface this Stop and the next ledger state.
 * A trigger is suppressed when its key was surfaced within `ttlMs`. Only
 * surfaced triggers are (re)stamped; suppressed ones retain their original
 * timestamp so suppression lapses `ttlMs` after the last actual surfacing.
 * Expired entries are pruned. Pure — never mutates `seen`.
 */
export function partitionByRecency(
  triggers: RubricTrigger[],
  seen: SeenLedger,
  now: Date,
  ttlMs: number = DEFAULT_TTL_MS,
): { surfaced: RubricTrigger[]; nextSeen: SeenLedger } {
  const nowMs = now.getTime();

  // Carry forward only non-expired prior entries.
  const nextSeen: SeenLedger = {};
  for (const [key, iso] of Object.entries(seen)) {
    const ms = Date.parse(iso);
    if (!Number.isNaN(ms) && nowMs - ms < ttlMs) nextSeen[key] = iso;
  }

  const surfaced: RubricTrigger[] = [];
  for (const trigger of triggers) {
    const key = suppressionKey(trigger);
    const priorMs = nextSeen[key] ? Date.parse(nextSeen[key]) : NaN;
    const recentlySurfaced = !Number.isNaN(priorMs) && nowMs - priorMs < ttlMs;
    if (recentlySurfaced) continue;
    surfaced.push(trigger);
    nextSeen[key] = now.toISOString(); // stamp only what we actually show
  }
  return { surfaced, nextSeen };
}

export function ledgerPath(homeBase: string): string {
  return join(homeBase, LEDGER_FILE);
}

/** Read the ledger; missing/corrupt/wrong-shape → empty (cache, not state). */
export function loadSeen(homeBase: string): SeenLedger {
  const path = ledgerPath(homeBase);
  if (!existsSync(path)) return {};
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const out: SeenLedger = {};
    for (const [key, value] of Object.entries(parsed)) {
      if (typeof value === "string") out[key] = value;
    }
    return out;
  } catch {
    return {};
  }
}

/** Persist the ledger atomically; never throws (cache write must not crash the critic). */
export function saveSeen(homeBase: string, seen: SeenLedger): void {
  try {
    atomicWrite(ledgerPath(homeBase), JSON.stringify(seen, null, 2));
  } catch {
    // non-critical cache — ignore
  }
}

/**
 * Filter rubric triggers through the on-disk ledger, persisting the new state.
 * Pass-through when `homeBase` is undefined (test/legacy fast path) or when
 * `SILTPOKE_RUBRIC_DEDUP=0`.
 */
export function dedupRubricTriggers(
  triggers: RubricTrigger[],
  homeBase: string | undefined,
  now: Date,
): RubricTrigger[] {
  if (homeBase === undefined) return triggers;
  if (process.env.SILTPOKE_RUBRIC_DEDUP === "0") return triggers;
  const seen = loadSeen(homeBase);
  const { surfaced, nextSeen } = partitionByRecency(triggers, seen, now);
  saveSeen(homeBase, nextSeen);
  return surfaced;
}
