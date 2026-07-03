// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Copyright (c) 2026 Jiaqi Duan
import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { ChatMessage } from "./schema";

const INDEX_FILENAME = "chat-index.db";

export interface ChatIndex {
  db: Database;
  close(): void;
}

export interface SearchMatch {
  id: string;
  session_id: string;
  role: string;
  content_snippet: string;
  score: number;
  ts: string;
}

function indexPath(homeBase: string): string {
  return join(homeBase, INDEX_FILENAME);
}

/**
 * Open (or create) FTS5 message index. Rather than rowid = hash(msg.id),
 * we use auto-rowid + id UNINDEXED so recovery can diff id-sets between
 * JSONL and FTS via a monotonic rowid or by detecting missing ids.
 */
export function openIndex(homeBase: string): ChatIndex {
  mkdirSync(homeBase, { recursive: true });
  const db = new Database(indexPath(homeBase));
  db.exec("PRAGMA journal_mode = WAL");
  db.exec(`
    CREATE VIRTUAL TABLE IF NOT EXISTS fts_messages USING fts5(
      content,
      id UNINDEXED,
      session_id UNINDEXED,
      role UNINDEXED,
      ts UNINDEXED
    )
  `);
  return {
    db,
    close: () => db.close(),
  };
}

/**
 * Insert message into FTS5 unless fts_skip is true or id already indexed.
 * Idempotent: re-inserting the same id is a no-op (return false).
 */
export function insertMessage(idx: ChatIndex, msg: ChatMessage): boolean {
  if (msg.fts_skip) return false;
  const existing = idx.db
    .query("SELECT id FROM fts_messages WHERE id = ?")
    .get(msg.id);
  if (existing) return false;
  idx.db
    .query(
      "INSERT INTO fts_messages (content, id, session_id, role, ts) VALUES (?, ?, ?, ?, ?)",
    )
    .run(msg.content, msg.id, msg.session_id, msg.role, msg.ts);
  return true;
}

export function indexedIdsForSession(
  idx: ChatIndex,
  sessionId: string,
): Set<string> {
  const rows = idx.db
    .query<{ id: string }, [string]>(
      "SELECT id FROM fts_messages WHERE session_id = ?",
    )
    .all(sessionId);
  return new Set(rows.map((r) => r.id));
}

/**
 * Full-text search. BM25 ranking via FTS5 `rank` virtual column;
 * lower (more negative) score = better match.
 */
export function search(
  idx: ChatIndex,
  query: string,
  limit = 20,
): SearchMatch[] {
  if (query.trim().length === 0) return [];
  const rows = idx.db
    .query<
      {
        id: string;
        session_id: string;
        role: string;
        content_snippet: string;
        score: number;
        ts: string;
      },
      [string, number]
    >(
      `SELECT
         id,
         session_id,
         role,
         snippet(fts_messages, 0, '[', ']', '...', 16) AS content_snippet,
         rank AS score,
         ts
       FROM fts_messages
       WHERE fts_messages MATCH ?
       ORDER BY rank
       LIMIT ?`,
    )
    .all(query, limit);
  return rows;
}
