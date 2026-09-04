// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
// Copyright (c) 2026 Jiaqi Duan
/**
 * menubar-aggregate — pending-review aggregation for the menu-bar pet.
 *
 * Reads the global append-only `brain-calls.jsonl` log and reduces it to
 * the small set of reviews the menu bar should surface: critiques that were
 * actually forwarded to the inbox (`critique_id !== null` — excludes passive
 * bubbles, which carry a full `brain_output`/comment but were never
 * forwarded) and that the user has neither acked nor dismissed, across ALL
 * sessions/repos.
 *
 * This filter used to also exclude evidence-guard-rejected NORMAL rows, and
 * that category no longer exists: since 2026-08-19 an unverifiable citation is
 * dropped and the review is kept, so those rows DO mint an id and DO reach this
 * list. They arrive here unmarked — the "unconfirmed" strip is a dashboard
 * surface (`/timeline`, `/history`) and the menu bar has no equivalent. Stated
 * rather than silently inherited; a menu-bar caveat is its own piece of work.
 *
 * "Actioned" (ack/dismiss) is checked against BOTH surfaces that can clear
 * a review: the dashboard (global `critic-actions.jsonl`, joined via
 * `readUserActions`) and the CLI (`/siltpoke-ack` / `/siltpoke-dismiss`,
 * which write a per-project critique-status file under
 * `{cwd}/.siltpoke/critiques/` instead — see `critique-status.ts`).
 *
 * Note: `readBrainCalls` parses `brain-calls.jsonl` rows in isolation and
 * always leaves `CriticCall.user_action` as `null` — the ack/dismiss join
 * against `critic-actions.jsonl` happens in `readCriticTelemetry` via a
 * private `attachUserActions` helper that this module can't reuse (not
 * exported). So the join is repeated here against `readUserActions`
 * (exported), keyed the same way: `session_id|timestamp`.
 */
import { join } from "node:path";
import { readBrainCalls, readUserActions } from "../state/critic-event-log";
import type { CriticCall, UserAction } from "../state/critic-event-log";
import { findCritiqueByIdOrLatest, readStatus } from "../state/critique-status";

export type MenubarSeverity = "info" | "low" | "medium" | "high";

export interface MenubarReview {
  repo: string;
  branch: string | null;
  session: string;
  comment: string;
  severity: MenubarSeverity;
  critiqueId: string | null;
  timestamp: string;
  /** Builder family (Slice B, T6) — WHICH CLI built the reviewed code, so the
   * menu-bar line can tag it. Optional so pre-existing callers/fixtures need no
   * change; the aggregate always populates it, and the renderer defaults an
   * absent value to "claude". */
  authorFamily?: string;
}

const KNOWN_SEVERITIES: readonly MenubarSeverity[] = ["info", "low", "medium", "high"];

function normalizeSeverity(severity: string | null): MenubarSeverity {
  return (KNOWN_SEVERITIES as readonly string[]).includes(severity ?? "")
    ? (severity as MenubarSeverity)
    : "info";
}

function commentOf(c: CriticCall): string {
  return (c.critique_for_claude ?? c.bubble_short ?? "").trim();
}

/**
 * Fired (non-empty comment) AND actually forwarded to the inbox
 * (`critique_id !== null` — excludes passive bubbles and evidence-guard-
 * rejected rows) AND untouched (no dashboard ack/dismiss action logged).
 * This is the cheap, synchronous half of the pending check; the CLI
 * per-project critique-status half (`isActionedViaCli`) is checked lazily
 * by the caller only for rows that pass this filter.
 */
function isPending(c: CriticCall, actionsMap: Map<string, UserAction>): boolean {
  if (commentOf(c).length === 0) return false;
  if (c.critique_id === null) return false;
  const key = `${c.session_id}|${c.timestamp}`;
  return !actionsMap.has(key);
}

/**
 * CLI ack/dismiss check: `/siltpoke-ack` and `/siltpoke-dismiss` write a
 * per-project critique-status file under `{cwd}/.siltpoke/critiques/`
 * rather than the dashboard's `critic-actions.jsonl`. Resolve the status
 * file for this row's critique_id and treat `acked`/`dismissed` as
 * actioned. Missing cwd, missing file, or any other status (pending,
 * forwarded, unreadable) means "not actioned via CLI".
 */
async function isActionedViaCli(c: CriticCall): Promise<boolean> {
  if (c.cwd === null || c.critique_id === null) return false;
  const basePath = join(c.cwd, ".siltpoke");
  const path = await findCritiqueByIdOrLatest(basePath, c.critique_id);
  if (!path) return false;
  const status = await readStatus(path);
  return status === "acked" || status === "dismissed";
}

/** Default freshness window: a session whose newest pending review is older
 *  than this is treated as no-longer-active and drops off the menu bar. Keeps
 *  the bar to "sessions active recently", not an ever-growing all-time inbox. */
const DEFAULT_FRESHNESS_MS = 30 * 60 * 1000; // 30 min (matches statusline isStale)

export async function collectPendingReviews(
  homeBase: string,
  opts: { limit?: number; scanWindow?: number; freshnessMs?: number; nowMs?: number } = {},
): Promise<MenubarReview[]> {
  const limit = opts.limit ?? 8;
  // scanWindow bounds the RAW-LINE tail read from brain-calls.jsonl, not the
  // count of pending rows — in a busy repo with many skipped/acked/dismissed
  // lines interleaved, a pending row older than `scanWindow` raw lines back
  // silently falls outside the read and won't surface here. Accepted
  // tradeoff (same bounded-tail design as `readBrainCalls` itself); raise
  // scanWindow if menu-bar reviews seem to go missing in high-volume repos.
  const scanWindow = opts.scanWindow ?? 200;
  const freshnessMs = opts.freshnessMs ?? DEFAULT_FRESHNESS_MS;
  const nowMs = opts.nowMs ?? Date.now();
  const [{ calls }, actionsMap] = await Promise.all([
    readBrainCalls(homeBase, scanWindow),
    readUserActions(homeBase),
  ]);
  // readBrainCalls returns newest-first already. We surface ONE card per
  // session — the most up-to-date (newest) pending review from each — so N
  // active sessions show as N cards (not one card per turn). A session is
  // skipped once its newest pending review is older than the freshness window,
  // so finished / idle-too-long sessions age off the bar. CLI critique-status
  // is a filesystem read per candidate, checked lazily (only for a row we're
  // otherwise about to keep).
  const out: MenubarReview[] = [];
  const seenSessions = new Set<string>();
  for (const c of calls) {
    if (out.length >= limit) break;
    if (seenSessions.has(c.session_id)) continue; // already have this session's newest
    if (!isPending(c, actionsMap)) continue;
    const ageMs = nowMs - Date.parse(c.timestamp);
    if (Number.isFinite(ageMs) && ageMs > freshnessMs) continue; // stale/finished session
    if (await isActionedViaCli(c)) continue;
    seenSessions.add(c.session_id);
    out.push({
      repo: c.project,
      branch: c.branch,
      session: c.session_id.slice(0, 3),
      comment: commentOf(c),
      severity: normalizeSeverity(c.severity),
      critiqueId: c.critique_id,
      timestamp: c.timestamp,
      authorFamily: c.authorFamily || "claude",
    });
  }
  return out;
}
