// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Copyright (c) 2026 Jiaqi Duan
/** @jsxImportSource hono/jsx */
/**
 * /timeline route — merged History + Traces master/detail page.
 *
 * SSR only, no route-local island: reads the same telemetry the /history
 * route reads (readCriticTelemetry over ~/.siltpoke/brain-calls.jsonl +
 * usage.json + config.json) with the SAME query-param semantics — the
 * parsers are imported from routes/critic.tsx, not copied.
 *
 * The page ships unlisted (no nav entry — the old /history and /traces
 * routes redirect here).
 *
 * GET /api/critique/:critique_id/trace — an on-demand SSR fragment
 * for the Trace tab (same pattern as GET /api/critique/:id/diff: render
 * the JSX to a string, client injects via x-html). The critique→trace join
 * is the same sqlite `critique_id` index /critique/:id already uses
 * (storage.ts getTracesByCritique); cost math is the same trace-cost
 * module /traces/:trace_id uses. Contingencies render as honest notes
 * inside the fragment — the endpoint never 500s on a missing/corrupt index.
 */

import { homedir } from "node:os";
import { join } from "node:path";
import type { Hono } from "hono";
import { readCriticTelemetry } from "../../state/api";
import { Layout } from "../_shared/layout";
import { TimelineScreen } from "../screens/TimelineScreen";
import {
  type TraceFragmentTrace,
  TraceTabFragment,
  TraceTabNote,
} from "../screens/timeline/trace-tab";
import { parseKind, parseRange, parseSort, parseStatus } from "./critic";
import { buildBrainCosts, buildTraceTotals, loadFullSpans, openIndexDb } from "./trace-cost";

export interface TimelineRouteDeps {
  homeBase?: string;
}

/** Row shape for the per-trace span query (needs `day` for JSONL lookup). */
interface TraceSpanRow {
  trace_id: string;
  span_id: string;
  parent_span_id: string | null;
  name: string;
  start_unix_nano: number;
  end_unix_nano: number;
  day: string;
}

/**
 * Resolve everything the Trace tab renders for one critique: linked trace
 * ids (critique_id join), their span rows (waterfall), and per-brain-span
 * costs + totals from the day-partition JSONL. Throws only on sqlite
 * errors — the caller maps that to the honest "index-error" note.
 */
function loadTracesForCritique(
  db: NonNullable<ReturnType<typeof openIndexDb>>,
  homeBase: string,
  critiqueId: string,
): TraceFragmentTrace[] {
  try {
    // Same join getTracesByCritique (observability/storage.ts) uses.
    const idRows = db.query<{ trace_id: string }, [string]>(
      "SELECT DISTINCT trace_id FROM spans WHERE critique_id = ? ORDER BY trace_id",
    ).all(critiqueId);
    return idRows.map(({ trace_id }) => {
      const spanRows = db.query<TraceSpanRow, [string]>(`
        SELECT trace_id, span_id, parent_span_id, name, start_unix_nano, end_unix_nano, day
        FROM spans
        WHERE trace_id = ?
        ORDER BY start_unix_nano ASC
      `).all(trace_id);
      const day = spanRows[0]?.day;
      const rawSpans = day ? loadFullSpans(homeBase, day, trace_id) : [];
      const brainCosts = buildBrainCosts(rawSpans);
      return {
        trace_id,
        // Full JSONL spans carry the attributes the span-timeline table
        // needs (siltpoke.kind tags, gen_ai token counts); fall back to
        // the attribute-less sqlite rows when the day partition is gone —
        // the table degrades honestly (no tags, "·" TOK).
        spans: rawSpans.length > 0 ? rawSpans : spanRows,
        brainCosts,
        totals: buildTraceTotals(brainCosts),
      };
    });
  } finally {
    db.close();
  }
}

export function mountTimelineRoutes(app: Hono, deps: TimelineRouteDeps = {}): void {
  const homeBase =
    deps.homeBase ?? process.env.SILTPOKE_HOME ?? join(homedir(), ".siltpoke");

  app.get("/timeline", async (c) => {
    const project = c.req.query("project") ?? null;
    const status = parseStatus(c.req.query("status"));
    const kind = parseKind(c.req.query("kind"));
    const range = parseRange(c.req.query("range"));
    const sort = parseSort(c.req.query("sort"));
    const query = c.req.query("q") ?? null;
    // Pager cursors: `before` pages older, `after` pages newer (both
    // exclusive; `before` wins if both are set). An unparseable value is
    // treated as absent (first page) — the params only ever come from our
    // own pager hrefs.
    const parseCursor = (v: string | undefined): Date | null => {
      const d = v ? new Date(v) : null;
      return d !== null && !Number.isNaN(d.getTime()) ? d : null;
    };
    const before = parseCursor(c.req.query("before"));
    const after = parseCursor(c.req.query("after"));
    const telemetry = await readCriticTelemetry(homeBase, new Date(), {
      project,
      status,
      kind,
      range,
      sort,
      query,
      before,
      after,
      // Turn-counted windows: `limit` counts rows that RENDER under the
      // active filters — gate-skip floods never consume page slots.
      windowMode: "turns",
      limit: 20,
      homeDir: homedir(),
    });
    return c.html(
      <Layout title="timeline · siltpoke">
        <TimelineScreen telemetry={telemetry} />
      </Layout>,
    );
  });

  // On-demand Trace tab fragment. Mirrors the diff endpoint's
  // contract: returns a pre-rendered HTML fragment the Alpine shell injects
  // via x-html. Honest degraded states (no index / unreadable index / no
  // linked trace) are themselves 200 fragments — the tab never 500s and the
  // client never has to interpret trace-store failure modes.
  app.get("/api/critique/:critique_id/trace", (c) => {
    const critiqueId = c.req.param("critique_id");
    if (!/^[A-Za-z0-9._-]{1,128}$/.test(critiqueId)) {
      return c.text("invalid critique_id", 400);
    }
    let db: ReturnType<typeof openIndexDb>;
    try {
      db = openIndexDb(homeBase);
    } catch {
      // Constructor can throw on a corrupt file before any query runs.
      return c.html(String(<TraceTabNote kind="index-error" />));
    }
    if (!db) {
      return c.html(String(<TraceTabNote kind="no-index" />));
    }
    let traces: TraceFragmentTrace[];
    try {
      traces = loadTracesForCritique(db, homeBase, critiqueId);
    } catch {
      return c.html(String(<TraceTabNote kind="index-error" />));
    }
    if (traces.length === 0) {
      return c.html(String(<TraceTabNote kind="no-trace" />));
    }
    return c.html(String(<TraceTabFragment traces={traces} />));
  });
}
