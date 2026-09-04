// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
// Copyright (c) 2026 Jiaqi Duan
import {
  listSessions,
  readSession,
} from "./jsonl-store";
import {
  clearOrphanCandidate,
  countRows,
  countRowsForSessions,
  deleteSession,
  bumpOrphanCandidate,
  markOrphanCandidate,
  orphanCandidates,
  indexedIdsForSession,
  indexedSessionIds,
  insertMessage,
  type ChatIndex,
} from "./fts5-index";

export interface RecoveryStats {
  sessions_scanned: number;
  messages_total: number;
  messages_already_indexed: number;
  messages_replayed: number;
  messages_skip_flagged: number;
  desync_ratio: number;
  /** Deleted sessions whose rows were still indexed, and have now been pruned. */
  orphan_sessions_pruned: number;
  /** Index rows removed because their session JSONL no longer exists. */
  orphan_messages_pruned: number;
  /** Orphan rows over the row count before pruning.
   * ⚠️ When `orphan_prune_skipped !== null` this is tautologically 1.0 — nothing
   * was visible, so every indexed session counts as orphaned. It is a drift
   * measurement ONLY when the prune ran; otherwise read `orphan_prune_skipped`. */
  orphan_ratio: number;
  /** Orphan sessions seen missing for the FIRST time this pass — recorded, not
   * deleted. */
  orphan_candidates_new: number;
  /** Orphan sessions already pending from an earlier pass and still held back
   * because the confirm window and/or the pass minimum is not yet satisfied. */
  orphan_candidates_held: number;
  /** Non-null when the prune was refused. Callers should surface this: it means
   * orphan rows are still searchable AND session listing looked untrustworthy. */
  orphan_prune_skipped: OrphanSkipReason;
}

/** Why a destructive orphan prune was refused. `null` = the prune ran. */
export type OrphanSkipReason = "no_sessions_visible" | null;

export interface RecoveryOptions {
  desyncThreshold?: number;
  /** Minimum wall-clock a session must stay unseen before its rows may be
   * pruned. Defaults to `DEFAULT_ORPHAN_CONFIRM_WINDOW_MS`. Tests set 0. */
  orphanConfirmWindowMs?: number;
}

/** 10 minutes — long enough to outlast a crash-restart loop or a slow mount. */
export const DEFAULT_ORPHAN_CONFIRM_WINDOW_MS = 10 * 60_000;

/**
 * Passes a session must be missing before its rows may be pruned, IN ADDITION
 * to the wall-clock window.
 *
 * ⚠️ Must be > 2, and 3 is the minimum that does anything. This branch is only
 * reached when the session was ALREADY a candidate, so `unseen_passes >= 1` and
 * `passes >= 2` always — at 2 the comparison is unsatisfiable and the gate is
 * dead code. Mutation-proven: at 2, deleting the clause changed no test result.
 *
 * Neither condition is sufficient alone, and each covers the other's blind spot:
 * a pass count alone is defeated by a crash-restart loop (two passes seconds
 * apart); a wall-clock window alone is defeated by a FORWARD clock jump, which
 * is most likely at exactly the moment this runs — daemon startup, where a dead
 * RTC, a VM syncing its host clock, or NTP correcting a stale clock can add
 * minutes to hours in one step. Requiring both means one implausible jump
 * cannot unilaterally confirm a prune.
 */
export const MIN_ORPHAN_UNSEEN_PASSES = 3;

/**
 * Confirm-then-prune, the destructive half. Extracted so it is unit-testable
 * without JSONL fixtures, and so the whole read-decide-write sequence sits in
 * one transaction.
 *
 * Two conditions must BOTH hold before a session's rows are deleted:
 *   1. it was already a candidate from an earlier pass, and
 *   2. `confirmWindowMs` of wall-clock has elapsed since that first sighting.
 *
 * (2) exists because (1) alone is not a safety property — `recoverIndex` runs
 * at daemon startup, so two passes can be seconds apart when launchd restarts a
 * crashing daemon. A degradation outliving one restart would otherwise satisfy
 * "absent twice" without the session ever having been absent for any
 * meaningful stretch of time.
 *
 * Assumes a single serialized caller: today `recoverIndex` is reached only from
 * `src/daemon/server.ts` after `acquireDaemonLock`. The transaction is
 * defense-in-depth for a future second call site, not a substitute for it.
 */
function confirmAndPruneOrphans(
  idx: ChatIndex,
  orphanIds: readonly string[],
  now: string,
  confirmWindowMs: number,
): {
  messages: number;
  sessions: number;
  newCandidates: number;
  held: number;
} {
  let messages = 0;
  let sessions = 0;
  let newCandidates = 0;
  let held = 0;
  const nowMs = Date.parse(now);
  idx.db.transaction(() => {
    const candidates = orphanCandidates(idx);
    const orphanSet = new Set(orphanIds);
    for (const id of candidates.keys()) {
      if (!orphanSet.has(id)) clearOrphanCandidate(idx, id); // reappeared
    }
    for (const sessionId of orphanIds) {
      const candidate = candidates.get(sessionId);
      if (candidate === undefined) {
        markOrphanCandidate(idx, sessionId, now);
        newCandidates += 1;
        continue; // first sighting — never delete on one observation
      }
      bumpOrphanCandidate(idx, sessionId);
      const passes = candidate.unseenPasses + 1;
      const elapsed = nowMs - Date.parse(candidate.firstUnseenAt);
      // No NaN guard needed: a corrupt `first_unseen_at` makes `elapsed` NaN,
      // and `NaN >= x` is already false, so the candidate is held. An explicit
      // isFinite() check here is inert — mutation-tested, no test can tell the
      // two apart. If corrupt timestamps ever need handling, do it at the write.
      const windowCleared = elapsed >= confirmWindowMs;
      if (!windowCleared || passes < MIN_ORPHAN_UNSEEN_PASSES) {
        held += 1;
        continue; // needs BOTH the elapsed window and the pass minimum
      }
      messages += deleteSession(idx, sessionId);
      sessions += 1;
      clearOrphanCandidate(idx, sessionId);
    }
  })();
  return { messages, sessions, newCandidates, held };
}

/**
 * Startup gap-detect + replay JSONL → FTS5. For each session JSONL, find
 * messages not yet in FTS index and insert them. Returns a desync ratio
 * for the fallback gate (>5% desync → drop FTS5).
 */
export async function recoverIndex(
  homeBase: string,
  idx: ChatIndex,
  options: RecoveryOptions = {},
): Promise<RecoveryStats> {
  const threshold = options.desyncThreshold ?? 0.05;
  const confirmWindowMs =
    options.orphanConfirmWindowMs ?? DEFAULT_ORPHAN_CONFIRM_WINDOW_MS;
  const sessions = await listSessions(homeBase);

  let messages_total = 0;
  let messages_already_indexed = 0;
  let messages_replayed = 0;
  let messages_skip_flagged = 0;

  for (const session of sessions) {
    const msgs = await readSession(homeBase, session.session_id);
    const indexed = indexedIdsForSession(idx, session.session_id);
    for (const msg of msgs) {
      messages_total += 1;
      if (msg.fts_skip) {
        messages_skip_flagged += 1;
        continue;
      }
      if (indexed.has(msg.id)) {
        messages_already_indexed += 1;
        continue;
      }
      if (insertMessage(idx, msg)) messages_replayed += 1;
    }
  }

  // Orphan direction: rows whose session JSONL is gone. The replay loop above
  // can never see these — it walks live sessions only — so before this they
  // accumulated silently AND stayed searchable, letting a deleted session's
  // content come back through search.
  //
  // DESTRUCTIVE, so it is sized as a dry run first and gated. `listSessions`
  // FAILS OPEN: it returns [] whenever the chats/ dir is merely absent — wrong
  // homeBase, an unresolved mount at daemon boot, a permissions blip, a restore
  // that recreates chat-index.db before chats/. The db lives beside chats/, not
  // inside it, so "index has rows, zero sessions visible" is reachable without
  // a single session having been deleted — and unconditional pruning would then
  // wipe the whole index. Refusing to prune is recoverable; wiping is not.
  const now = new Date().toISOString();
  const live = new Set(sessions.map((s) => s.session_id));
  const rowsBefore = countRows(idx);
  const orphanIds = [...indexedSessionIds(idx)].filter((id) => !live.has(id));
  const orphanRows = countRowsForSessions(idx, orphanIds);
  const orphan_ratio = rowsBefore === 0 ? 0 : orphanRows / rowsBefore;

  let orphan_prune_skipped: OrphanSkipReason = null;
  if (sessions.length === 0 && rowsBefore > 0) {
    orphan_prune_skipped = "no_sessions_visible";
  }

  let orphan_sessions_pruned = 0;
  let orphan_messages_pruned = 0;
  let orphan_candidates_new = 0;
  let orphan_candidates_held = 0;
  if (orphan_prune_skipped === null) {
    const r = confirmAndPruneOrphans(idx, orphanIds, now, confirmWindowMs);
    orphan_messages_pruned = r.messages;
    orphan_sessions_pruned = r.sessions;
    orphan_candidates_new = r.newCandidates;
    orphan_candidates_held = r.held;
  } else {
    console.warn(
      `[siltpoke] chat-index orphan prune SKIPPED (${orphan_prune_skipped}) — ${rowsBefore} indexed row(s) but zero sessions visible on disk; refusing to prune. Check that ${homeBase}/chats exists.`,
    );
  }

  const indexable = messages_total - messages_skip_flagged;
  const desync_ratio = indexable === 0 ? 0 : messages_replayed / indexable;

  if (desync_ratio > threshold) {
    console.warn(
      `[siltpoke] chat-index desync ${(desync_ratio * 100).toFixed(1)}% > ${(threshold * 100).toFixed(0)}% (fallback gate)`,
    );
  }
  if (orphan_prune_skipped === null && orphan_ratio > threshold) {
    console.warn(
      `[siltpoke] chat-index orphans ${(orphan_ratio * 100).toFixed(1)}% > ${(threshold * 100).toFixed(0)}% — ${orphan_messages_pruned} row(s) across ${orphan_sessions_pruned} session(s) pruned, ${orphan_candidates_new} newly flagged, ${orphan_candidates_held} still awaiting confirmation`,
    );
  }

  return {
    sessions_scanned: sessions.length,
    messages_total,
    messages_already_indexed,
    messages_replayed,
    messages_skip_flagged,
    desync_ratio,
    orphan_sessions_pruned,
    orphan_messages_pruned,
    orphan_ratio,
    orphan_candidates_new,
    orphan_candidates_held,
    orphan_prune_skipped,
  };
}
