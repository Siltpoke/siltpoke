// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
// Copyright (c) 2026 Jiaqi Duan
/**
 * Schema-shape guards for the two databases that are created with
 * `CREATE TABLE IF NOT EXISTS`.
 *
 * The defect these exist for is not hypothetical and not old: on a real install
 * (2026-08-12), `orphan_candidates` on disk had `session_id, first_unseen_at`
 * while the code had been writing `unseen_passes` for some time. `IF NOT
 * EXISTS` does nothing when the table is present, so the column was never
 * added, every query naming it threw `no such column: unseen_passes`, and the
 * daemon logged one line per start and ran with chat-index recovery disabled.
 * The orphan prune — and the two-pass confirmation designed to make deleting
 * safe — had therefore never run once.
 *
 * That is the third instance of one defect (`index-schema.ts` documents it for
 * `fts_chunks`; #510 hit it when a version bump was expected to rebuild an FTS5
 * table), which is why the guard reads the real columns off the database rather
 * than trusting a version number.
 *
 * The two databases get DIFFERENT repairs on purpose, and the tests assert the
 * difference: the chat index is a derived cache and is rebuilt, while the trace
 * index holds the telemetry itself and is only reported on. A guard that
 * "repaired" the trace index would delete the data it was meant to protect.
 */
import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { insertMessage, openIndex } from "../../src/chat/fts5-index";
import { spansShapeDrift } from "../../src/observability/storage";

function withHome(fn: (base: string) => void): void {
  const base = mkdtempSync(join(tmpdir(), "schema-guard-"));
  try {
    fn(base);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
}

function columns(db: Database, table: string): string[] {
  return db.query<{ name: string }, []>(`PRAGMA table_info(${table})`).all().map((r) => r.name);
}

describe("chat index shape guard", () => {
  test("an orphan_candidates table missing unseen_passes is rebuilt with it", () => {
    withHome((base) => {
      // Byte-for-byte the shape found on the real install.
      const seeded = new Database(join(base, "chat-index.db"));
      seeded.exec(
        "CREATE TABLE orphan_candidates (session_id TEXT PRIMARY KEY, first_unseen_at TEXT NOT NULL)",
      );
      seeded.exec("INSERT INTO orphan_candidates VALUES ('s1', '2026-01-01T00:00:00.000Z')");
      seeded.close();

      const idx = openIndex(base);
      try {
        expect(columns(idx.db, "orphan_candidates")).toContain("unseen_passes");
        // The stale bookkeeping row goes with the stale table. It names a
        // session pending a second-pass check under rules that no longer
        // applied — carrying it across would be carrying a half-finished
        // decision, not preserving data.
        expect(
          idx.db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM orphan_candidates").get()?.n,
        ).toBe(0);
      } finally {
        idx.close();
      }
    });
  });

  test("the query that used to throw now answers", () => {
    withHome((base) => {
      const seeded = new Database(join(base, "chat-index.db"));
      seeded.exec(
        "CREATE TABLE orphan_candidates (session_id TEXT PRIMARY KEY, first_unseen_at TEXT NOT NULL)",
      );
      seeded.close();

      const idx = openIndex(base);
      try {
        // `no such column: unseen_passes` came from exactly this shape of read,
        // and it is what disabled recovery on every affected install.
        const read = (): unknown =>
          idx.db
            .query("SELECT session_id, first_unseen_at, unseen_passes FROM orphan_candidates")
            .all();
        expect(read).not.toThrow();
      } finally {
        idx.close();
      }
    });
  });

  test("a current database is left alone, rows and all", () => {
    withHome((base) => {
      const first = openIndex(base);
      insertMessage(first, {
        id: "m1",
        session_id: "s1",
        role: "user",
        content: "hello",
        ts: "2026-01-01T00:00:00.000Z",
        model: null,
        tokens: null,
        fts_skip: false,
        claude_session_id: null,
      });
      first.close();

      const reopened = openIndex(base);
      try {
        // The guard must not be a rebuild-every-start: that would throw away a
        // healthy index on every daemon restart and look like "recovery works".
        expect(
          reopened.db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM fts_messages").get()?.n,
        ).toBe(1);
      } finally {
        reopened.close();
      }
    });
  });

  test("an fts_messages table with the wrong columns is rebuilt", () => {
    withHome((base) => {
      const seeded = new Database(join(base, "chat-index.db"));
      seeded.exec("CREATE VIRTUAL TABLE fts_messages USING fts5(content, id UNINDEXED)");
      seeded.close();

      const idx = openIndex(base);
      try {
        for (const column of ["content", "id", "session_id", "role", "ts"]) {
          expect(columns(idx.db, "fts_messages")).toContain(column);
        }
      } finally {
        idx.close();
      }
    });
  });
});

describe("trace index shape guard", () => {
  test("reports drift instead of repairing it", () => {
    withHome((base) => {
      const db = new Database(join(base, "index.sqlite"));
      db.exec(
        `CREATE TABLE spans (trace_id TEXT NOT NULL, span_id TEXT NOT NULL, name TEXT NOT NULL,
          PRIMARY KEY (trace_id, span_id))`,
      );
      db.exec("INSERT INTO spans VALUES ('t1', 's1', 'brain.find')");

      const drift = spansShapeDrift(db);
      expect(drift.drifted).toBe(true);
      expect(drift.missing).toContain("start_unix_nano");
      expect(drift.missing).toContain("offset");
      // The whole point of the different treatment: the row is still here.
      // Telemetry is not a derived cache, and a guard that dropped this table
      // would destroy exactly what it was added to protect.
      expect(db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM spans").get()?.n).toBe(1);
      db.close();
    });
  });

  test("a current spans table reports no drift", () => {
    withHome((base) => {
      const db = new Database(join(base, "index.sqlite"));
      db.exec(
        `CREATE TABLE spans (
          trace_id TEXT NOT NULL, span_id TEXT NOT NULL, parent_span_id TEXT, name TEXT NOT NULL,
          start_unix_nano INTEGER NOT NULL, end_unix_nano INTEGER NOT NULL, day TEXT NOT NULL,
          critique_id TEXT, offset INTEGER NOT NULL, PRIMARY KEY (trace_id, span_id))`,
      );
      expect(spansShapeDrift(db).drifted).toBe(false);
      db.close();
    });
  });

  test("a database with no spans table yet is not drift", () => {
    withHome((base) => {
      const db = new Database(join(base, "index.sqlite"));
      // A fresh install reaches the check before the CREATE. Calling that
      // "drift" would print a schema warning on first ever run.
      expect(spansShapeDrift(db).drifted).toBe(false);
      db.close();
    });
  });
});
