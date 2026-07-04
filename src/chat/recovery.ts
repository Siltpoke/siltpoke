// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
// Copyright (c) 2026 Jiaqi Duan
import {
  listSessions,
  readSession,
} from "./jsonl-store";
import {
  indexedIdsForSession,
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
}

export interface RecoveryOptions {
  desyncThreshold?: number;
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

  const indexable = messages_total - messages_skip_flagged;
  const desync_ratio = indexable === 0 ? 0 : messages_replayed / indexable;

  if (desync_ratio > threshold) {
    console.warn(
      `[siltpoke] chat-index desync ${(desync_ratio * 100).toFixed(1)}% > ${(threshold * 100).toFixed(0)}% (fallback gate)`,
    );
  }

  return {
    sessions_scanned: sessions.length,
    messages_total,
    messages_already_indexed,
    messages_replayed,
    messages_skip_flagged,
    desync_ratio,
  };
}
