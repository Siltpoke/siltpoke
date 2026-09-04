/**
 * API route tests — GET /api/traces (cost/token analytics)
 */
import { describe, test, expect, afterEach } from "bun:test";
import { Hono } from "hono";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Database } from "bun:sqlite";
import { mountTracesRoutes } from "../../src/daemon/routes/traces";
import type { TraceCostSummary } from "../../src/daemon/routes/traces";
import type { Span } from "../../src/observability/types";

function makeTmpDir(): string {
  const dir = join(
    tmpdir(),
    `siltpoke-traces-route-test-${Date.now()}-${Math.random().toString(36).slice(2)}`
  );
  mkdirSync(dir, { recursive: true });
  return dir;
}

function makeSpan(overrides: Partial<Span> & { trace_id: string; span_id: string }): Span {
  return {
    trace_id: overrides.trace_id,
    span_id: overrides.span_id,
    parent_span_id: overrides.parent_span_id ?? null,
    name: overrides.name ?? "siltpoke.turn",
    kind: "INTERNAL",
    start_unix_nano: overrides.start_unix_nano ?? Date.now() * 1_000_000,
    end_unix_nano: overrides.end_unix_nano ?? (Date.now() + 100) * 1_000_000,
    status: { code: "OK" },
    attributes: overrides.attributes ?? {},
    events: [],
  };
}

function setupTraceDb(dir: string): { db: Database; traceDir: string } {
  const traceDir = join(dir, "traces");
  mkdirSync(traceDir, { recursive: true });
  const dbPath = join(traceDir, "index.sqlite");
  const db = new Database(dbPath);
  db.exec(`
    CREATE TABLE IF NOT EXISTS spans (
      trace_id TEXT NOT NULL,
      span_id TEXT NOT NULL,
      parent_span_id TEXT,
      name TEXT NOT NULL,
      start_unix_nano INTEGER NOT NULL,
      end_unix_nano INTEGER NOT NULL,
      day TEXT NOT NULL,
      critique_id TEXT,
      offset INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (trace_id, span_id)
    );
  `);
  return { db, traceDir };
}

function insertSpan(db: Database, span: Span, day: string, critiqueId: string | null): void {
  db.query(`
    INSERT OR REPLACE INTO spans
    (trace_id, span_id, parent_span_id, name, start_unix_nano, end_unix_nano, day, critique_id, offset)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    span.trace_id,
    span.span_id,
    span.parent_span_id,
    span.name,
    span.start_unix_nano,
    span.end_unix_nano,
    day,
    critiqueId,
    0
  );
}

function writeJsonl(traceDir: string, day: string, spans: Span[]): void {
  const file = join(traceDir, `${day}.jsonl`);
  writeFileSync(file, `${spans.map((s) => JSON.stringify(s)).join("\n")}\n`);
}

const dirs: string[] = [];

afterEach(() => {
  for (const d of dirs) {
    try {
      rmSync(d, { recursive: true, force: true });
    } catch {
      // best effort
    }
  }
  dirs.length = 0;
});

describe("GET /api/traces (cost fields)", () => {
  test("returns 200 with empty data when no trace store", async () => {
    const dir = makeTmpDir();
    dirs.push(dir);
    const app = new Hono();
    mountTracesRoutes(app, { homeBase: dir });

    const res = await app.request("/api/traces");
    expect(res.status).toBe(200);
    const json = (await res.json()) as { success: boolean; data: unknown[] };
    expect(json.success).toBe(true);
    expect(Array.isArray(json.data)).toBe(true);
    expect(json.data.length).toBe(0);
  });

  test("returns cost fields per trace when brain spans have gen_ai attributes", async () => {
    const dir = makeTmpDir();
    dirs.push(dir);
    const { db, traceDir } = setupTraceDb(dir);

    const day = "2026-05-20";
    const traceId = "aabb".repeat(8);
    const now = Date.now() * 1_000_000;

    const rootSpan = makeSpan({
      trace_id: traceId,
      span_id: "root".padEnd(16, "0"),
      name: "siltpoke.turn",
      start_unix_nano: now,
      end_unix_nano: now + 2_000_000_000,
    });
    const brainSpan = makeSpan({
      trace_id: traceId,
      span_id: "brain".padEnd(16, "0"),
      parent_span_id: "root".padEnd(16, "0"),
      name: "siltpoke.brain.find",
      start_unix_nano: now + 100_000_000,
      end_unix_nano: now + 1_500_000_000,
      attributes: {
        "gen_ai.system": "anthropic",
        "gen_ai.request.model": "claude-haiku-4-5",
        "gen_ai.usage.input_tokens": 1000,
        "gen_ai.usage.output_tokens": 200,
        "gen_ai.usage.cache_read_input_tokens": 400,
      },
    });

    insertSpan(db, rootSpan, day, null);
    insertSpan(db, brainSpan, day, null);
    writeJsonl(traceDir, day, [rootSpan, brainSpan]);
    db.close();

    const app = new Hono();
    mountTracesRoutes(app, { homeBase: dir });

    const res = await app.request("/api/traces");
    expect(res.status).toBe(200);
    const json = (await res.json()) as { success: boolean; data: TraceCostSummary[] };
    expect(json.success).toBe(true);
    expect(json.data.length).toBeGreaterThan(0);

    const trace = json.data[0]!;
    expect(trace.trace_id).toBe(traceId);
    expect(trace.model).toBe("claude-haiku-4-5");
    expect(trace.total_input_tokens).toBe(1000);
    expect(trace.total_output_tokens).toBe(200);
    expect(trace.total_cached_tokens).toBe(400);
    // input_tokens excludes cache reads (claude -p semantics): the prompt is
    // 1000 uncached + 400 cached = 1400 → 400/1400.
    expect(trace.cache_hit_pct).toBeCloseTo(28.6, 1);
    expect(typeof trace.cost_usd).toBe("number");
    expect(trace.cost_usd).toBeGreaterThan(0);
    expect(typeof trace.cache_savings_usd).toBe("number");
    expect(trace.cache_savings_usd).toBeGreaterThan(0);
  });

  test("returns trace with zero tokens when no brain spans exist", async () => {
    const dir = makeTmpDir();
    dirs.push(dir);
    const { db, traceDir } = setupTraceDb(dir);

    const day = "2026-05-20";
    const traceId = "ccdd".repeat(8);
    const now = Date.now() * 1_000_000;

    const rootSpan = makeSpan({
      trace_id: traceId,
      span_id: "root2".padEnd(16, "0"),
      name: "siltpoke.turn",
      start_unix_nano: now,
      end_unix_nano: now + 1_000_000_000,
    });

    insertSpan(db, rootSpan, day, null);
    writeJsonl(traceDir, day, [rootSpan]);
    db.close();

    const app = new Hono();
    mountTracesRoutes(app, { homeBase: dir });

    const res = await app.request("/api/traces");
    const json = (await res.json()) as { success: boolean; data: TraceCostSummary[] };
    const trace = json.data[0]!;
    expect(trace.total_input_tokens).toBe(0);
    expect(trace.cost_usd).toBe(0);
    expect(trace.cache_hit_pct).toBe(0);
  });
});

describe("GET /api/traces/:trace_id (cost breakdown)", () => {
  test("returns brain_costs and totals for a trace with brain spans", async () => {
    const dir = makeTmpDir();
    dirs.push(dir);
    const { db, traceDir } = setupTraceDb(dir);

    const day = "2026-05-20";
    const traceId = "eeff".repeat(8);
    const now = Date.now() * 1_000_000;

    const rootSpan = makeSpan({
      trace_id: traceId,
      span_id: "root3".padEnd(16, "0"),
      name: "siltpoke.turn",
      start_unix_nano: now,
      end_unix_nano: now + 3_000_000_000,
    });
    const brainSpan = makeSpan({
      trace_id: traceId,
      span_id: "brain3".padEnd(16, "0"),
      parent_span_id: "root3".padEnd(16, "0"),
      name: "siltpoke.brain.verify",
      start_unix_nano: now + 200_000_000,
      end_unix_nano: now + 2_000_000_000,
      attributes: {
        "gen_ai.request.model": "claude-sonnet-4-6",
        "gen_ai.usage.input_tokens": 2000,
        "gen_ai.usage.output_tokens": 500,
        "gen_ai.usage.cache_read_input_tokens": 0,
      },
    });

    insertSpan(db, rootSpan, day, null);
    insertSpan(db, brainSpan, day, null);
    writeJsonl(traceDir, day, [rootSpan, brainSpan]);
    db.close();

    const app = new Hono();
    mountTracesRoutes(app, { homeBase: dir });

    const res = await app.request(`/api/traces/${traceId}`);
    expect(res.status).toBe(200);
    const json = (await res.json()) as {
      success: boolean;
      data: unknown[];
      brain_costs: Array<{ span_name: string; model: string; cost_usd: number }>;
      totals: { cost_usd: number; would_have_cost_usd: number };
    };

    expect(json.success).toBe(true);
    expect(Array.isArray(json.data)).toBe(true);
    expect(Array.isArray(json.brain_costs)).toBe(true);
    expect(json.brain_costs.length).toBe(1);

    const bc = json.brain_costs[0]!;
    expect(bc.span_name).toBe("siltpoke.brain.verify");
    expect(bc.model).toBe("claude-sonnet-4-6");
    expect(typeof bc.cost_usd).toBe("number");
    expect(bc.cost_usd).toBeGreaterThan(0);

    expect(typeof json.totals.cost_usd).toBe("number");
    expect(json.totals.would_have_cost_usd).toBeCloseTo(json.totals.cost_usd, 8); // no cache = savings=0
  });

  test("returns 404 for unknown trace_id", async () => {
    const dir = makeTmpDir();
    dirs.push(dir);
    setupTraceDb(dir); // creates the db but no spans

    const app = new Hono();
    mountTracesRoutes(app, { homeBase: dir });

    const res = await app.request("/api/traces/nonexistent-trace-id");
    expect(res.status).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// Track #7 T3 (AC8/AC14) — a codex (quota-billed) brain span must never be
// priced against the claude rate table, in either endpoint.
// ---------------------------------------------------------------------------

describe("cross-family provider cost guard (track #7 T3)", () => {
  test("GET /api/traces — codex span contributes 0 cost/savings, not haiku-priced", async () => {
    const dir = makeTmpDir();
    dirs.push(dir);
    const { db, traceDir } = setupTraceDb(dir);

    const day = "2026-07-07";
    const traceId = "c0de".repeat(8);
    const now = Date.now() * 1_000_000;

    const rootSpan = makeSpan({
      trace_id: traceId,
      span_id: "rootx".padEnd(16, "0"),
      name: "siltpoke.turn",
      start_unix_nano: now,
      end_unix_nano: now + 2_000_000_000,
    });
    const brainSpan = makeSpan({
      trace_id: traceId,
      span_id: "brainx".padEnd(16, "0"),
      parent_span_id: "rootx".padEnd(16, "0"),
      name: "siltpoke.brain.find",
      start_unix_nano: now + 100_000_000,
      end_unix_nano: now + 1_500_000_000,
      attributes: {
        "gen_ai.system": "openai",
        "gen_ai.request.model": "gpt-5-codex",
        "gen_ai.usage.input_tokens": 100_000,
        "gen_ai.usage.output_tokens": 50_000,
        "gen_ai.usage.cache_read_input_tokens": 0,
      },
    });

    insertSpan(db, rootSpan, day, null);
    insertSpan(db, brainSpan, day, null);
    writeJsonl(traceDir, day, [rootSpan, brainSpan]);
    db.close();

    const app = new Hono();
    mountTracesRoutes(app, { homeBase: dir });

    const res = await app.request("/api/traces");
    const json = (await res.json()) as { success: boolean; data: TraceCostSummary[] };
    const trace = json.data[0]!;
    expect(trace.model).toBe("gpt-5-codex");
    expect(trace.total_input_tokens).toBe(100_000);
    expect(trace.cost_usd).toBe(0);
    expect(trace.cache_savings_usd).toBe(0);
  });

  test("GET /api/traces/:trace_id — codex brain_costs row is $0, no haiku fallback", async () => {
    const dir = makeTmpDir();
    dirs.push(dir);
    const { db, traceDir } = setupTraceDb(dir);

    const day = "2026-07-07";
    const traceId = "c0d3".repeat(8);
    const now = Date.now() * 1_000_000;

    const rootSpan = makeSpan({
      trace_id: traceId,
      span_id: "rooty".padEnd(16, "0"),
      name: "siltpoke.turn",
      start_unix_nano: now,
      end_unix_nano: now + 2_000_000_000,
    });
    const brainSpan = makeSpan({
      trace_id: traceId,
      span_id: "brainy".padEnd(16, "0"),
      parent_span_id: "rooty".padEnd(16, "0"),
      name: "siltpoke.brain.find",
      start_unix_nano: now + 100_000_000,
      end_unix_nano: now + 1_500_000_000,
      attributes: {
        "gen_ai.system": "openai",
        "gen_ai.usage.input_tokens": 10_000,
        "gen_ai.usage.output_tokens": 5_000,
      },
    });

    insertSpan(db, rootSpan, day, null);
    insertSpan(db, brainSpan, day, null);
    writeJsonl(traceDir, day, [rootSpan, brainSpan]);
    db.close();

    const app = new Hono();
    mountTracesRoutes(app, { homeBase: dir });

    const res = await app.request(`/api/traces/${traceId}`);
    const json = (await res.json()) as {
      brain_costs: Array<{ model: string; cost_usd: number }>;
      totals: { cost_usd: number };
    };
    expect(json.brain_costs.length).toBe(1);
    // No gen_ai.request.model attr at all + non-anthropic → "(unknown)",
    // never mislabeled as claude-haiku-4-5.
    expect(json.brain_costs[0]!.model).toBe("(unknown)");
    expect(json.brain_costs[0]!.cost_usd).toBe(0);
    expect(json.totals.cost_usd).toBe(0);
  });
});
