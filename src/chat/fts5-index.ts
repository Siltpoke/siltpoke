// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
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
 * Every column each table must have, in the shape this code writes.
 *
 * These lists are not decoration; they are the check. Both tables below are
 * created with `CREATE TABLE IF NOT EXISTS`, which does exactly nothing when a
 * table of that name already exists — including when it is an OLDER table
 * missing a column added since. That already happened here: `unseen_passes` was
 * added to `orphan_candidates`, every existing install kept its two-column
 * table, and every query naming the new column threw `no such column:
 * unseen_passes`. The daemon caught it, logged one line, and carried on with
 * chat-index recovery disabled — so the orphan prune, and the two-pass
 * confirmation designed to make it safe, never ran once on any install that
 * predated the column.
 *
 * This is the third instance of one defect: `index-schema.ts` documents it for
 * `fts_chunks`, and #510 hit it when a version-number bump was expected to
 * rebuild an FTS5 table. A version number cannot save this — the fix is to read
 * the columns off the real database and rebuild when they differ.
 */
const MESSAGE_COLUMNS = ["content", "id", "session_id", "role", "ts"] as const;
const ORPHAN_CANDIDATE_COLUMNS = ["session_id", "first_unseen_at", "unseen_passes"] as const;

/** Columns of `table` as the database actually has them, or null if absent. */
function columnsOnDisk(db: Database, table: string): string[] | null {
  const found = db
    .query<{ name: string }, [string]>(
      "SELECT name FROM sqlite_master WHERE type IN ('table') AND name = ?",
    )
    .get(table);
  if (found === null) return null;
  return db.query<{ name: string }, []>(`PRAGMA table_info(${table})`).all().map((r) => r.name);
}

function shapeMatches(expected: readonly string[], onDisk: readonly string[]): boolean {
  const want = new Set<string>(expected);
  const have = new Set(onDisk);
  return want.size === have.size && [...want].every((c) => have.has(c));
}

/**
 * Drop any table whose on-disk shape is not the shape this code writes, so the
 * `CREATE ... IF NOT EXISTS` below builds it fresh.
 *
 * Dropping is the right repair for BOTH tables here, and for the same reason:
 * neither holds anything that is not recoverable from disk. `orphan_candidates`
 * is pure in-flight bookkeeping — session ids seen absent, pending a second
 * pass. `fts_messages` is an index of the JSONL session files, and
 * `recoverIndex` replays every message it finds on disk back into it. The rows
 * a rebuild does NOT bring back are rows whose session file is gone — which is
 * precisely what the orphan prune exists to delete.
 */
function rebuildIfShapeChanged(db: Database): void {
  for (const [table, expected] of [
    ["fts_messages", MESSAGE_COLUMNS],
    ["orphan_candidates", ORPHAN_CANDIDATE_COLUMNS],
  ] as const) {
    const onDisk = columnsOnDisk(db, table);
    if (onDisk === null) continue;
    if (shapeMatches(expected, onDisk)) continue;
    db.exec(`DROP TABLE IF EXISTS ${table}`);
  }
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
  // Before either CREATE below, and it has to be: `IF NOT EXISTS` is what makes
  // a stale table survive a column addition.
  rebuildIfShapeChanged(db);
  db.exec(`
    CREATE VIRTUAL TABLE IF NOT EXISTS fts_messages USING fts5(
      content,
      id UNINDEXED,
      session_id UNINDEXED,
      role UNINDEXED,
      ts UNINDEXED
    )
  `);
  // Two-pass orphan confirmation. A session id only becomes prunable after it
  // has been UNSEEN across two separate recovery passes. A transient listing
  // failure (mount mid-sync, restore copying files back one at a time, readdir
  // racing a writer) makes a live session vanish for exactly one pass — it
  // lands here, reappears, and is cleared without ever being deleted.
  db.exec(`
    CREATE TABLE IF NOT EXISTS orphan_candidates (
      session_id TEXT PRIMARY KEY,
      first_unseen_at TEXT NOT NULL,
      unseen_passes INTEGER NOT NULL DEFAULT 1
    )
  `);
  return {
    db,
    close: () => db.close(),
  };
}

/**
 * Session ids pending orphan confirmation → when each was FIRST seen unseen.
 *
 * The timestamp is load-bearing, not decoration: "seen absent twice" is not a
 * safety property on its own, because two passes can be seconds apart (a
 * crash-looping daemon under launchd KeepAlive restarts recovery each time).
 * Confirmation requires absence sustained across a real time span.
 */
export function orphanCandidates(idx: ChatIndex): Map<string, OrphanCandidate> {
  const rows = idx.db
    .query<
      { session_id: string; first_unseen_at: string; unseen_passes: number },
      []
    >(
      "SELECT session_id, first_unseen_at, unseen_passes FROM orphan_candidates",
    )
    .all();
  return new Map(
    rows.map((r) => [
      r.session_id,
      { firstUnseenAt: r.first_unseen_at, unseenPasses: r.unseen_passes },
    ]),
  );
}

/** One pending orphan: when it was first missed, and over how many passes. */
export interface OrphanCandidate {
  firstUnseenAt: string;
  unseenPasses: number;
}

/** Record another pass in which this session was missing. */
export function bumpOrphanCandidate(idx: ChatIndex, sessionId: string): void {
  idx.db
    .query(
      "UPDATE orphan_candidates SET unseen_passes = unseen_passes + 1 WHERE session_id = ?",
    )
    .run(sessionId);
}

/** Mark a session id as unseen this pass (idempotent — keeps the first stamp). */
export function markOrphanCandidate(
  idx: ChatIndex,
  sessionId: string,
  at: string,
): void {
  idx.db
    .query(
      "INSERT OR IGNORE INTO orphan_candidates (session_id, first_unseen_at) VALUES (?, ?)",
    )
    .run(sessionId, at);
}

/** Clear a candidate — it came back, or it has now been pruned. */
export function clearOrphanCandidate(idx: ChatIndex, sessionId: string): void {
  idx.db
    .query("DELETE FROM orphan_candidates WHERE session_id = ?")
    .run(sessionId);
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
 * Every distinct `session_id` currently present in the index — the set needed to
 * detect rows whose session JSONL no longer exists. `indexedIdsForSession` only
 * answers the opposite question (given a live session, what is indexed), so it
 * can never surface an orphan.
 */
export function indexedSessionIds(idx: ChatIndex): Set<string> {
  const rows = idx.db
    .query<{ session_id: string }, []>(
      "SELECT DISTINCT session_id FROM fts_messages",
    )
    .all();
  return new Set(rows.map((r) => r.session_id));
}

/**
 * Drop every indexed row for one session. Returns the number of LOGICAL rows
 * removed.
 *
 * The count is taken with a SELECT before the DELETE, deliberately: on an FTS5
 * virtual table `run().changes` counts writes to the shadow tables, not user
 * rows — deleting a single message reported 7. Do NOT "optimise" this into
 * `changes`; a test pins the real number.
 */
export function deleteSession(idx: ChatIndex, sessionId: string): number {
  const n = countRowsForSessions(idx, [sessionId]);
  idx.db.query("DELETE FROM fts_messages WHERE session_id = ?").run(sessionId);
  return n;
}

/** Total indexed rows — the denominator for orphan accounting. */
export function countRows(idx: ChatIndex): number {
  const r = idx.db
    .query<{ n: number }, []>("SELECT COUNT(*) AS n FROM fts_messages")
    .get();
  return r?.n ?? 0;
}

/** Rows per session, for the sessions given. Used to size a prune BEFORE it runs. */
export function countRowsForSessions(
  idx: ChatIndex,
  sessionIds: readonly string[],
): number {
  let n = 0;
  for (const id of sessionIds) {
    const r = idx.db
      .query<{ n: number }, [string]>(
        "SELECT COUNT(*) AS n FROM fts_messages WHERE session_id = ?",
      )
      .get(id);
    n += r?.n ?? 0;
  }
  return n;
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
