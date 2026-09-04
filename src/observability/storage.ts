// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
// Copyright (c) 2026 Jiaqi Duan
/**
 * TraceStore — JSONL-backed OTEL span storage with bun:sqlite index.
 *
 * Uses bun:sqlite (native Bun) instead of better-sqlite3, which does not
 * support Bun's native module loader. The API is structurally identical
 * (query/prepare, .run, .get, .all) — bun:sqlite uses query() as the
 * prepare alias.
 */
import { appendFile, mkdir } from "node:fs/promises";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import type { Span } from "./types";
import { siltpokeRoot } from "../installer/paths";

const TRACES_DIR = join(siltpokeRoot(), "traces");

/**
 * Every column `spans` must have, in the shape this code writes.
 *
 * `CREATE TABLE IF NOT EXISTS` does nothing at all when a table of that name
 * exists, including when it is an older table missing a column added since —
 * so the day a column is added here, every existing install keeps its old
 * table and the first query naming the new column throws. That is not
 * hypothetical: it is what `no such column: unseen_passes` was in the chat
 * index, and what `index-schema.ts` documents for `fts_chunks`.
 *
 * The difference here is the repair. Those two tables are derived caches and
 * can simply be dropped and rebuilt. `spans` is not: it is the telemetry
 * itself, tens of thousands of rows, and the JSONL beside it is append-only
 * history rather than a source the table is re-derived from on demand. So this
 * check REPORTS and does not repair — an honest loud failure the moment a
 * schema change lands, instead of a silent one at the first query, and instead
 * of a "repair" that would delete the data it was protecting.
 */
const SPAN_COLUMNS = [
  "trace_id", "span_id", "parent_span_id", "name",
  "start_unix_nano", "end_unix_nano", "day", "critique_id", "offset",
] as const;

/**
 * Whether the `spans` table on disk is the one this code writes. Absent (a
 * fresh install, before the CREATE below) counts as current — there is nothing
 * stale to warn about.
 */
export function spansShapeDrift(db: Database): { drifted: boolean; missing: string[]; extra: string[] } {
  const table = db
    .query<{ name: string }, []>("SELECT name FROM sqlite_master WHERE type='table' AND name='spans'")
    .get();
  if (table === null) return { drifted: false, missing: [], extra: [] };
  const onDisk = db.query<{ name: string }, []>("PRAGMA table_info(spans)").all().map((r) => r.name);
  const have = new Set(onDisk);
  const missing = SPAN_COLUMNS.filter((c) => !have.has(c));
  const extra = onDisk.filter((c) => !SPAN_COLUMNS.includes(c as (typeof SPAN_COLUMNS)[number]));
  return { drifted: missing.length > 0 || extra.length > 0, missing, extra };
}

export class TraceStore {
  private db: Database;
  private dir: string;

  constructor(opts?: { dbPath?: string; dir?: string }) {
    this.dir = opts?.dir ?? TRACES_DIR;
    this.db = new Database(opts?.dbPath ?? join(this.dir, "index.sqlite"));
    // Checked BEFORE the CREATE, which would otherwise mask the drift by
    // quietly leaving the old table in place.
    const drift = spansShapeDrift(this.db);
    if (drift.drifted) {
      process.stderr.write(
        `[siltpoke] trace index schema drift — the spans table on disk does not match this build` +
          (drift.missing.length > 0 ? `; missing column(s): ${drift.missing.join(", ")}` : "") +
          (drift.extra.length > 0 ? `; unexpected column(s): ${drift.extra.join(", ")}` : "") +
          `. Queries naming a missing column will fail. This table holds real telemetry, so it is` +
          ` NOT rebuilt automatically — migrate or move ${join(this.dir, "index.sqlite")} deliberately.\n`,
      );
    }
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS spans (
        trace_id TEXT NOT NULL,
        span_id TEXT NOT NULL,
        parent_span_id TEXT,
        name TEXT NOT NULL,
        start_unix_nano INTEGER NOT NULL,
        end_unix_nano INTEGER NOT NULL,
        day TEXT NOT NULL,
        critique_id TEXT,
        offset INTEGER NOT NULL,
        PRIMARY KEY (trace_id, span_id)
      );
      CREATE INDEX IF NOT EXISTS idx_critique ON spans(critique_id);
      CREATE INDEX IF NOT EXISTS idx_day ON spans(day);
    `);
  }

  async writeSpan(span: Span): Promise<void> {
    const day = new Date(span.start_unix_nano / 1_000_000).toISOString().slice(0, 10);
    await mkdir(this.dir, { recursive: true });
    const file = join(this.dir, `${day}.jsonl`);
    const line = `${JSON.stringify(span)}\n`;
    await appendFile(file, line);
    const critique_id = (span.attributes["siltpoke.critique_id"] as string | undefined) ?? null;
    this.db.query(`
      INSERT OR REPLACE INTO spans (trace_id, span_id, parent_span_id, name, start_unix_nano, end_unix_nano, day, critique_id, offset)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(span.trace_id, span.span_id, span.parent_span_id, span.name,
           span.start_unix_nano, span.end_unix_nano, day, critique_id, 0);
  }

  getSpansByTrace(trace_id: string): Span[] {
    const row = this.db.query<{ day: string }, [string]>(
      "SELECT day FROM spans WHERE trace_id = ? LIMIT 1"
    ).get(trace_id);
    if (!row) return [];
    const file = join(this.dir, `${row.day}.jsonl`);
    if (!existsSync(file)) return [];
    return readFileSync(file, "utf8")
      .trim().split("\n")
      .map((l: string) => JSON.parse(l) as Span)
      .filter((s: Span) => s.trace_id === trace_id);
  }

  getTracesByCritique(critique_id: string): string[] {
    const rows = this.db.query<{ trace_id: string }, [string]>(
      "SELECT DISTINCT trace_id FROM spans WHERE critique_id = ?"
    ).all(critique_id);
    return rows.map(r => r.trace_id);
  }
}
