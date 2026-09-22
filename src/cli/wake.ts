// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
// Copyright (c) 2026 Jiaqi Duan
import { mkdir, writeFile, readFile, unlink } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { siltpokeRoot } from "../installer/paths";
import {
  clearBreaker,
  readBrainHealth,
  writeBrainHealth,
} from "../state/brain-health";
import type { FailureClass } from "../brain/failure-classify";
import { isMuted, readMute } from "../state/mute";

export interface WakeFile {
  schemaVersion: 1;
  expires_at_ms: number;
}

export interface WakeOptions {
  homeBase?: string;
  ttlMs?: number;
  now?: () => Date;
}

export interface WakeResult {
  wake_path: string;
  expires_at_ms: number;
  /** True when this run cleared an open breaker (defect [11]). */
  breaker_cleared: boolean;
  /** Class of the breaker that was cleared, or null when none was open. */
  breaker_class: FailureClass | null;
  /**
   * True when an active mute will swallow this wake anyway. `handle-stop.ts`
   * runs `checkMuteGate` BEFORE `consumeWake` — "mute beats wake" — so a
   * muted user who is told "the next turn gets a review" gets nothing, and
   * `/siltpoke-doctor` has no mute row to explain it. Saying so here is the
   * only surface that can.
   */
  muted: boolean;
  /** ISO time the mute lifts, "indefinite", or null when not muted. */
  muted_until: string | null;
}

const FILENAME = "wake.json";
const DEFAULT_TTL_MS = 5 * 60 * 1000;

function wakePath(homeBase: string): string {
  return join(homeBase, FILENAME);
}

export async function runWake(opts: WakeOptions = {}): Promise<WakeResult> {
  const homeBase = opts.homeBase ?? siltpokeRoot();
  const ttlMs = opts.ttlMs ?? DEFAULT_TTL_MS;
  const now = opts.now ?? (() => new Date());
  const expires_at_ms = now().getTime() + ttlMs;
  const path = wakePath(homeBase);
  await mkdir(homeBase, { recursive: true });
  const payload: WakeFile = { schemaVersion: 1, expires_at_ms };
  await writeFile(path, JSON.stringify(payload, null, 2), "utf8");

  // Defect [11]: clear the breaker HERE, not only when the Stop hook happens
  // to spend the marker. A latched `permanent` breaker is the case that makes
  // this matter — the user was told "clear via /siltpoke-wake", and a clear
  // that silently expires with the 5-minute marker is not a clear. The Stop
  // hook still clears on the marker too (it is idempotent), and the marker
  // keeps its own job: bypassing the quiet-hours, budget, review-unit and
  // no-code-change gates as well (mute is checked before it, on purpose).
  //
  // "Try now", not "declare healthy" — same as doctor's re-verify: the
  // breaker goes, `consecutive_failures` stays, so the next failure reopens
  // at the escalated window.
  const health = readBrainHealth(homeBase);
  const openClass = health.breaker?.class ?? null;
  let cleared = false;
  if (health.breaker !== null) {
    writeBrainHealth(homeBase, clearBreaker(health));
    // Derive the claim from a FRESH read, not from what we read before
    // writing: `writeBrainHealth` swallows its errors by design ("must never
    // block the critic"), so a failed write would otherwise be reported to
    // the user as "the breaker is cleared" — the same did-the-documented-
    // thing-and-nothing-happened shape defect [11] is about.
    cleared = readBrainHealth(homeBase).breaker === null;
  }

  const muted = isMuted(homeBase, now());
  const mute = muted ? readMute(homeBase) : null;

  return {
    wake_path: path,
    expires_at_ms,
    breaker_cleared: cleared,
    breaker_class: cleared ? openClass : null,
    muted,
    muted_until: mute === null
      ? null
      : mute.indefinite
        ? "indefinite"
        : new Date(mute.until_ms as number).toISOString(),
  };
}

export async function consumeWake(
  homeBase: string,
  now: Date = new Date(),
): Promise<boolean> {
  const path = wakePath(homeBase);
  if (!existsSync(path)) return false;
  try {
    const raw = await readFile(path, "utf8");
    const parsed = JSON.parse(raw) as Partial<WakeFile>;
    await unlink(path);
    if (
      parsed.schemaVersion !== 1 ||
      typeof parsed.expires_at_ms !== "number"
    ) {
      return false;
    }
    return parsed.expires_at_ms >= now.getTime();
  } catch {
    return false;
  }
}

/**
 * Human output — a raw JSON blob here is defect [4]'s whole complaint.
 *
 * `now` is passed in rather than read from the ambient clock so the minutes
 * shown are computed against the same instant `runWake` used; `mute.ts`'s
 * formatter has the same discipline.
 */
export function formatWakeHuman(result: WakeResult, now: Date = new Date()): string {
  const mins = Math.max(1, Math.round((result.expires_at_ms - now.getTime()) / 60_000));
  const mutedNote = result.muted
    ? `But Siltpoke is muted${result.muted_until === "indefinite" ? " indefinitely" : ` until ${result.muted_until}`}, and mute beats wake — ` +
      `nothing will be reviewed until you run /siltpoke-unmute.\n`
    : "";
  if (result.breaker_cleared) {
    return (
      `Siltpoke woken. The ${result.breaker_class} breaker that was stopping reviews is cleared — ` +
      `the next Stop hook will call the Brain again.\n` +
      `If it fails again the breaker reopens, so fix the cause first ` +
      `(run /siltpoke-doctor to see the last failure).\n` +
      mutedNote
    );
  }
  if (result.muted) {
    return `Siltpoke woken, but nothing was blocking the Brain.\n${mutedNote}`;
  }
  return `Siltpoke woken. No breaker was open; the next turn gets a review even with no new commit (${mins}m).\n`;
}

export function formatWakeJson(result: WakeResult): string {
  return `${JSON.stringify(result, null, 2)}\n`;
}

if (import.meta.main) {
  const result = await runWake();
  process.stdout.write(
    process.argv.includes("--json") ? formatWakeJson(result) : formatWakeHuman(result),
  );
  process.exit(0);
}
