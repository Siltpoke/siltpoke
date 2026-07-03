// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Copyright (c) 2026 Jiaqi Duan
/**
 * Pure formatting helpers for the active-repos rail. Kept out of the JSX
 * component so they're unit-testable and the panel stays presentational.
 */

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const WEEK = 7 * DAY;
const MONTH = 30 * DAY;
const YEAR = 365 * DAY;

/**
 * Coarse "time since" label for a last-active timestamp. Deterministic given
 * `now`, so it's injectable in tests. Future timestamps (clock skew) clamp to
 * "just now". Unparseable input returns "".
 */
export function relativeTime(iso: string, now: Date): string {
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return "";
  const diff = now.getTime() - then;
  if (diff < MIN) return "just now";
  if (diff < HOUR) return `${Math.floor(diff / MIN)}m ago`;
  if (diff < DAY) return `${Math.floor(diff / HOUR)}h ago`;
  if (diff < WEEK) return `${Math.floor(diff / DAY)}d ago`;
  if (diff < MONTH) return `${Math.floor(diff / WEEK)}w ago`;
  if (diff < YEAR) return `${Math.floor(diff / MONTH)}mo ago`;
  return `${Math.floor(diff / YEAR)}y ago`;
}

/**
 * Display form of an absolute project path: collapse the home prefix to "~",
 * then middle-truncate deep paths so the row stays one line. `home` is the OS
 * home dir (so "/Users/x/Projects/app" → "~/Projects/app").
 */
export function shortenPath(path: string, home: string, max = 38): string {
  let p = path;
  if (home && (p === home || p.startsWith(`${home}/`))) {
    p = `~${p.slice(home.length)}`;
  }
  if (p.length <= max) return p;
  const segments = p.split("/");
  if (segments.length <= 3) return p;
  // segments[0] is "" for an absolute path ("/var/…" → "/…/tail") and "~" for a
  // home-collapsed one ("~/…/tail"); reusing it keeps the leading slash correct.
  const head = segments[0];
  const tail = segments.slice(-2).join("/");
  return `${head}/…/${tail}`;
}
