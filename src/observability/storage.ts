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
import { homedir } from "node:os";
import { Database } from "bun:sqlite";
import type { Span } from "./types";

const TRACES_DIR = join(homedir(), ".siltpoke", "traces");

export class TraceStore {
  private db: Database;
  private dir: string;

  constructor(opts?: { dbPath?: string; dir?: string }) {
    this.dir = opts?.dir ?? TRACES_DIR;
    this.db = new Database(opts?.dbPath ?? join(this.dir, "index.sqlite"));
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
