// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
// Copyright (c) 2026 Jiaqi Duan
/**
 * menubar — SwiftBar plugin output formatter for the menu-bar pet.
 *
 * Pure function: no I/O, no file reads. SwiftBar's line format is
 * `<text> | param=value | param2=value2`; the first line(s) before the
 * first `---` become the menu-bar title, everything after becomes
 * dropdown rows. User-derived text (name/repo/branch/comment) is
 * sanitized before being written into a row, since a raw `|` would be
 * parsed as a param delimiter and a raw newline would break the row
 * boundary SwiftBar expects.
 */
import type { MenubarReview } from "./menubar-aggregate";
import { truncateToVisualWidth } from "./width";

export interface MenubarInput {
  name: string;
  /** Stable per-species emoji head (🐱 / 🤖 / …); the menu bar does not flip
   *  expressions by mood — attention is carried by the `⚠N` badge. */
  emoji: string;
  reviews: MenubarReview[];
  dashboardUrl: string;
  /** Wall-clock ms used to render each card's relative time ("3m ago"). */
  nowMs: number;
  /** When present, render a "Restart daemon" dropdown row wired to the CLI
   *  (`<bun> <script> restart`). Omitted when the daemon paths can't be
   *  resolved — the row simply doesn't appear. */
  restart?: { bun: string; script: string };
  /** When present, the "Open dashboard" row runs `<bun> <cli> dashboard`
   *  (which starts the opt-in daemon if it's down, then opens the browser)
   *  instead of a bare `href=` that silently hits a dead :9876 whenever the
   *  daemon isn't already running. Omitted when bun can't be resolved — the
   *  row falls back to the plain href. */
  dashboard?: { bun: string; cli: string };
  /**
   * Result of the last `siltpoked restart`, when one is recorded.
   *
   * The restart row runs with `terminal=false`, so SwiftBar throws away both
   * stdout and stderr — a failed restart is indistinguishable from a no-op at
   * exactly the surface where the user clicks. Making the CLI honest does not
   * reach them; the outcome has to come back into the menu. Rendered only while
   * FRESH (see RESTART_OUTCOME_TTL_MS): this answers "what happened when I just
   * clicked", it is not a permanent banner.
   */
  restartOutcome?: { ok: boolean; at: string; summary: string; message: string };
}

/** How long a failed restart stays worth mentioning in the dropdown. */
export const RESTART_OUTCOME_TTL_MS = 10 * 60_000;

/** Roughly the width a SwiftBar submenu row shows without clipping. */
const SUBMENU_WRAP = 52;

/** Greedy word wrap. A word longer than the limit gets its own (long) line
 *  rather than being cut — a clipped path or pid is worse than a wide row. */
function wrapForSubmenu(text: string, width: number = SUBMENU_WRAP): string[] {
  const out: string[] = [];
  let cur = "";
  for (const word of text.split(/\s+/).filter(Boolean)) {
    if (cur.length === 0) cur = word;
    else if (cur.length + 1 + word.length <= width) cur += ` ${word}`;
    else { out.push(cur); cur = word; }
  }
  if (cur.length > 0) out.push(cur);
  return out;
}

/**
 * Human relative time for a card's tag line ("just now" / "3m ago" / "2h ago"
 * / "1d ago"). Replaces the opaque 3-char session id — a timestamp tells the
 * user which of their sessions a review came from far better than a hash, and
 * surfaces staleness at a glance.
 */
function relTime(fromIso: string, nowMs: number): string {
  const t = Date.parse(fromIso);
  if (!Number.isFinite(t)) return "";
  const diffMin = Math.floor(Math.max(0, nowMs - t) / 60000);
  if (diffMin < 1) return "just now";
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffH = Math.floor(diffMin / 60);
  if (diffH < 24) return `${diffH}h ago`;
  return `${Math.floor(diffH / 24)}d ago`;
}

/**
 * `HH:MM` (local, zero-padded, 24h) for an ISO timestamp. Falls back to the
 * raw string on an unparsable input — a stray literal beats a thrown render.
 */
function hhmm(iso: string): string {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return iso;
  const d = new Date(t);
  const hh = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  return `${hh}:${mm}`;
}

// SwiftBar treats " | " as the start of the per-line param block and newlines
// as row breaks. Neutralize both in any user-derived text.
function sanitize(s: string): string {
  return s.replace(/\r?\n/g, " ").replace(/\|/g, "¦").trim();
}

// D2 (design spec): name/comment truncate by visual width when long so an
// over-long value can't blow out the fixed-width menu bar / dropdown row.
// Sanitize FIRST (neutralize |/newlines), then clip the clean string; append
// "…" only when the clip actually dropped characters.
function sanitizeAndClip(s: string, budget: number): string {
  const clean = sanitize(s);
  const clipped = truncateToVisualWidth(clean, budget);
  return clipped === clean ? clipped : `${clipped}…`;
}

const NAME_BUDGET = 24;
const COMMENT_BUDGET = 60;

export function renderMenubar(input: MenubarInput): string {
  // Badge is a plain activity COUNT, not a warning — it tells the user how many
  // recently-active sessions have feedback right now (one card = one session's
  // latest review). No ⚠ triangle: clean "linters pass" feedback counts too, so
  // the number reflects "how many sessions are running", not "how many problems".
  const n = input.reviews.length;
  const badge = n > 0 ? ` · ${n}` : "";
  const title = `${input.emoji} ${sanitizeAndClip(input.name, NAME_BUDGET)}${badge}`;

  const lines: string[] = [title, "---"];
  for (const r of input.reviews) {
    // `🔧 <family>` tags which CLI agent built the reviewed code (Slice B T6).
    // Appended AFTER the time so the repo·branch·time prefix stays intact.
    const builderTag = `🔧 ${r.authorFamily ?? "claude"}`;
    const tagParts = [r.repo, r.branch, relTime(r.timestamp, input.nowMs), builderTag].filter(
      (p): p is string => typeof p === "string" && p.length > 0,
    );
    lines.push(`${sanitize(tagParts.join(" · "))} | color=#888 font=Menlo`);
    lines.push(`${sanitizeAndClip(r.comment, COMMENT_BUDGET)} | href=${input.dashboardUrl}/timeline`);
    lines.push("---");
  }
  if (input.dashboard) {
    // bash= (not bare href=) so clicking STARTS the opt-in daemon before opening
    // the browser — `dashboard` verb = plugin-cli.ts's openDashboard(). terminal=false
    // runs it silently; the verb spawns the server detached, opens the URL, and exits.
    lines.push(
      `🖥 Open dashboard (see all) | bash=${input.dashboard.bun} param1=${input.dashboard.cli} param2=dashboard terminal=false refresh=false`,
    );
  } else {
    lines.push(`🖥 Open dashboard (see all) | href=${input.dashboardUrl}`);
  }
  lines.push("---");
  if (input.restart) {
    lines.push(
      `🔄 Restart daemon | bash=${input.restart.bun} param1=${input.restart.script} param2=restart terminal=false refresh=true`,
    );
  }
  const outcome = input.restartOutcome;
  if (outcome) {
    const at = Date.parse(outcome.at);
    const fresh = Number.isFinite(at) && input.nowMs - at <= RESTART_OUTCOME_TTL_MS;
    if (fresh && !outcome.ok) {
      // Headline stays short. Measured against a real menu bar: the full
      // sentence on one row overflowed the dropdown and was clipped mid-word,
      // so the half that said what to do never reached the eye. The detail goes
      // one level down, where it has room to wrap.
      //
      // sanitize(): CLI-authored text today, but it interpolates a port and a
      // pid and will grow — an unescaped `|` would turn the tail of a
      // diagnostic into SwiftBar params, and a newline would forge extra rows.
      lines.push(`⚠ Restart ${sanitize(outcome.summary)} | color=orange`);
      for (const line of wrapForSubmenu(sanitize(outcome.message))) {
        lines.push(`-- ${line}`);
      }
    } else if (fresh && outcome.ok) {
      // Success gets a row too — a click that silently worked reads exactly
      // like a click that silently did nothing (see restart-outcome.ts's
      // header comment). Keep it one line, no detail level below it: there is
      // nothing more useful to say than "yes, that happened, at this time".
      lines.push(`✓ Restarted ${sanitize(hhmm(outcome.at))} | color=green`);
    }
  }
  lines.push("Refresh | refresh=true");
  return lines.join("\n");
}
