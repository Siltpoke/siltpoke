// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
// Copyright (c) 2026 Jiaqi Duan
/**
 * The pet's speech bubble: its colour, its wrapping, and the time it carries.
 * Split out of `wrapper.ts`, which composes the statusline around it.
 */
import { truncateToVisualWidth, visualWidth } from "./width";

// Aligned with /history SpeechKindBadge + classifySpeechKind:
//   high          → critical (red)
//   medium / med  → warning  (yellow)
//   low / info    → comment  (gray)   — `low` is Brain's default for benign
//                                       critiques. Painting it cyan in the
//                                       terminal bubble contradicts the
//                                       dashboard's comment badge.
const SEVERITY_TO_COLOR: Record<string, string> = {
  high: "red",
  medium: "yellow",
  med: "yellow",
  low: "gray",
  info: "gray",
};

export function severityToColor(severity: string, fallback: string): string {
  return SEVERITY_TO_COLOR[severity] ?? fallback;
}

const ANSI_COLOR_CODES: Record<string, string> = {
  cyan: "36",
  green: "32",
  yellow: "33",
  magenta: "35",
  red: "31",
  blue: "34",
  white: "37",
  gray: "90",
  pink: "38;5;213",
  hotpink: "38;5;205",
  coral: "38;5;210",
  mint: "38;5;121",
};

export function colorize(text: string, colorName: string): string {
  const code = ANSI_COLOR_CODES[colorName] ?? ANSI_COLOR_CODES.cyan!;
  return `\x1b[${code}m${text}\x1b[0m`;
}

function tokenize(text: string): string[] {
  // Split on whitespace OR just after CJK fullwidth punctuation.
  // Excludes ASCII . , ! ? on purpose so file paths (queries.py),
  // version strings, and numbers stay intact.
  return text.split(/(?:\s+|(?<=[，。！？]))/).filter((t) => t !== "");
}

function wrapBubble(text: string, maxWidth: number, maxLines: number): string[] {
  if (maxWidth <= 0 || visualWidth(text) <= maxWidth) return [text];

  const words = tokenize(text);
  const lines: string[] = [];
  let cur = "";
  const endsWithCjkPunct = (s: string): boolean => /[，。！？]$/.test(s);
  for (const w of words) {
    const sep = !cur || endsWithCjkPunct(cur) ? "" : " ";
    const tryNext = `${cur}${sep}${w}`;
    if (visualWidth(tryNext) <= maxWidth) {
      cur = tryNext;
    } else {
      if (cur) lines.push(cur);
      cur = w;
    }
  }
  if (cur) lines.push(cur);

  // Words can themselves exceed maxWidth (long CJK token, URL, etc.).
  // Split any oversized line by visual width.
  const flat: string[] = [];
  for (const line of lines) {
    if (visualWidth(line) <= maxWidth) {
      flat.push(line);
      continue;
    }
    let rest = line;
    while (visualWidth(rest) > maxWidth) {
      const chunk = truncateToVisualWidth(rest, maxWidth);
      flat.push(chunk);
      rest = rest.slice(chunk.length);
    }
    if (rest) flat.push(rest);
  }

  if (flat.length > maxLines) {
    const kept = flat.slice(0, maxLines);
    const idx = maxLines - 1;
    const last = kept[idx]!;
    const trimmed = truncateToVisualWidth(last, Math.max(0, maxWidth - 3));
    kept[idx] = `${trimmed}...`;
    return kept;
  }
  return flat;
}

/**
 * `[10:44 AM]: ` from an epoch-ms stamp, or "" when there is nothing to stamp.
 *
 * The trailing colon makes the line read as speech — `[10:44 AM]: "…"` is
 * someone saying something at a time, which is what a pet bubble is. Without
 * it the stamp sits next to the quote like a label on a log row.
 *
 * 12-hour with the meridiem, not 24-hour: this line is matched against the
 * reader's own memory of the session, and that memory is "before lunch", not
 * "before 12:00". A bare `[01:15]` is also genuinely ambiguous on a machine
 * that has been awake across both — the hour is the half of the stamp that
 * does the work, so it must not be the half that can be read two ways.
 *
 * Hours are NOT zero-padded (`9:05 AM`, not `09:05 AM`) — that is the
 * conventional 12-hour form, and the leading zero reads as a 24-hour clock,
 * which is the exact confusion the meridiem is here to remove. Minutes stay
 * padded, because `9:5` is not a time.
 */
function bubbleTimeStamp(
  atMs: number | undefined,
  nowMs: number = Date.now(),
): string {
  if (atMs === undefined || !Number.isFinite(atMs) || atMs <= 0) return "";
  const d = new Date(atMs);
  const h24 = d.getHours();
  const meridiem = h24 < 12 ? "AM" : "PM";
  // Midnight and noon are the two the modulo gets wrong: 0 % 12 and 12 % 12
  // are both 0, and "0:15 AM" is not a time anyone writes.
  const h12 = h24 % 12 === 0 ? 12 : h24 % 12;
  const mm = String(d.getMinutes()).padStart(2, "0");
  return `[${dayPrefix(d, new Date(nowMs))}${h12}:${mm} ${meridiem}]: `;
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/**
 * `Sep 29, ` when the stamp is not from today, `Dec 31 2025, ` when it is not
 * from this year, and nothing when it is today — one rule for every bubble.
 *
 * A review bubble clears after 30 minutes, so it is nearly always today's and
 * keeps the bare clock time. The "reviews stopped" bubble stays until someone
 * clears the breaker, which has taken days; a bare `[11:45 AM]` on that one
 * would read as this morning.
 */
function dayPrefix(at: Date, now: Date): string {
  const sameYear = at.getFullYear() === now.getFullYear();
  if (sameYear && at.getMonth() === now.getMonth() && at.getDate() === now.getDate()) return "";
  const day = `${MONTHS[at.getMonth()]} ${at.getDate()}`;
  return sameYear ? `${day}, ` : `${day} ${at.getFullYear()}, `;
}

/**
 * The bubble carries WHEN it was said.
 *
 * Without it the pet's line looks the same at one minute old and at
 * twenty-nine — the bubble only clears at 30 minutes (`DEFAULT_STALE_MS`) —
 * so a review of earlier work reads as a review of the turn you just
 * finished, and a reader assumes it is about the turn they just made.
 *
 * A clock time, not an age: it costs the same width every render (no reflow
 * as "2m" becomes "12m"), and it is what a reader matches against their own
 * memory of the session. Everything else about a review — which files, what
 * evidence, which branch — stays in the dashboard timeline; this line is the
 * one fact that has to travel with the sentence.
 */
export function buildBubbleBlock(
  bubble: string,
  colorName: string,
  faceWidth: number,
  termWidth: number,
  atMs?: number,
  nowMs?: number,
): string {
  const quoted = `${bubbleTimeStamp(atMs, nowMs)}"${bubble}"`;
  const effective = termWidth > 0 ? termWidth : 160;
  const available = Math.max(20, effective - faceWidth - 2);
  const wrapped = wrapBubble(quoted, available, 3);
  return wrapped.map((l) => colorize(l, colorName)).join("\n");
}
