// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
// Copyright (c) 2026 Jiaqi Duan
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

/**
 * The result of the last `siltpoked restart`, persisted so the menu bar can
 * show it.
 *
 * Why this file exists: the SwiftBar "Restart daemon" row runs with
 * `terminal=false`, which discards stdout AND stderr. Teaching the CLI to
 * report honestly therefore changed nothing at the surface where the problem
 * was actually reported — from the menu bar a failed restart still looks
 * identical to a click that did nothing. Rather than make the row open a
 * terminal on every click (noise on success, which is the common case), the
 * outcome is written here and rendered back into the dropdown on the next
 * refresh — and that row already carries `refresh=true`, so the next refresh
 * happens immediately after the click.
 */
export interface RestartOutcome {
  ok: boolean;
  /** ISO timestamp; the renderer hides stale outcomes rather than nagging. */
  at: string;
  /**
   * A few words for the menu-bar row itself. The full `message` on one row
   * overflowed a real dropdown and got clipped mid-word, taking the actionable
   * half of the sentence with it.
   */
  summary: string;
  /** The full explanation. Rendered one level down, where it can wrap. */
  message: string;
}

export function restartOutcomePath(homeBase: string): string {
  return join(homeBase, "last-restart.json");
}

/** Fail-soft: a status file for a menu row must never take the restart down. */
export function writeRestartOutcome(homeBase: string, outcome: RestartOutcome): void {
  try {
    mkdirSync(homeBase, { recursive: true });
    writeFileSync(restartOutcomePath(homeBase), `${JSON.stringify(outcome)}\n`);
  } catch {
    // ignored by design
  }
}

/**
 * Returns null when absent, unreadable, or malformed — the renderer then shows
 * nothing. Every field is validated rather than trusted: this file is read on
 * the menu-bar render path, and a half-written or hand-edited file must degrade
 * to "no information" instead of putting `undefined` into a SwiftBar row.
 */
export function readRestartOutcome(homeBase: string): RestartOutcome | null {
  try {
    const raw = JSON.parse(readFileSync(restartOutcomePath(homeBase), "utf8")) as unknown;
    if (!raw || typeof raw !== "object") return null;
    const o = raw as Record<string, unknown>;
    if (typeof o.ok !== "boolean" || typeof o.at !== "string" || typeof o.message !== "string") {
      return null;
    }
    // `summary` was added after the first shipped format; fall back to the
    // message so a file written by the previous build still renders.
    const summary = typeof o.summary === "string" && o.summary.length > 0 ? o.summary : o.message;
    return { ok: o.ok, at: o.at, summary, message: o.message };
  } catch {
    return null;
  }
}
