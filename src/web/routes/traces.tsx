// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Copyright (c) 2026 Jiaqi Duan
/** @jsxImportSource hono/jsx */
/**
 * /traces web routes.
 *
 * Architectural note: trace SSR routes live here (src/web/routes/) alongside
 * other SSR screens. API routes live in src/daemon/routes/traces.ts.
 * The server.ts registers both sets.
 *
 * /traces           → 302 /timeline (the list view merged into the Timeline
 *                     page; its status/model/date params have no /timeline
 *                     equivalent, so the qs is dropped)
 * /traces/:trace_id → TraceDetail screen (per-brain-call cost breakdown +
 *                     waterfall). Deliberately KEPT as a standalone page as a
 *                     graceful fallback, and the Timeline Trace tab links
 *                     here as "open span explorer →" — it's now a child
 *                     surface of /timeline, not a nav destination.
 */

import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Hono } from "hono";
import { Layout } from "../_shared/layout";
import type { TabId } from "../primitives/SpanDetailPanel";
import type { SpanNode } from "../primitives/SpanTree";
import type { WaterfallSpan } from "../primitives/TraceWaterfall";
import type { BrainSpanCost, TraceTotals } from "../screens/TraceList";
import { TraceDetail } from "../screens/TraceList";
import {
  buildBrainCosts,
  buildTraceTotals,
  loadFullSpans,
  openIndexDb,
} from "./trace-cost";

export interface TraceWebRouteDeps {
  homeBase?: string;
}

interface SpanRow {
  trace_id: string;
  span_id: string;
  parent_span_id: string | null;
  name: string;
  start_unix_nano: number;
  end_unix_nano: number;
}

// openIndexDb / loadFullSpans / buildBrainCosts / buildTraceTotals
// (né buildTotals) moved to ./trace-cost so the /timeline Trace tab reuses
// the same math. The trace-LIST builders (buildTraceSummaries / queryTraces /
// filters) were deleted with the list page — the sqlite index + JSONL remain
// fully served by /api/traces (src/daemon/routes/traces.ts) and the
// /timeline Trace tab.

export function mountTraceWebRoutes(app: Hono, deps: TraceWebRouteDeps = {}): void {
  const homeBase =
    deps.homeBase ?? process.env.SILTPOKE_HOME ?? join(homedir(), ".siltpoke");

  // The trace list merged into /timeline. Its filter params
  // (status=OK|ERROR / model / date) have no /timeline counterpart, so the
  // query string is dropped rather than half-translated.
  app.get("/traces", (c) => c.redirect("/timeline"));

  app.get("/traces/:trace_id", (c) => {
    const traceId = c.req.param("trace_id");
    const activeSpanId = c.req.query("span") ?? undefined;
    const tabParam = c.req.query("tab") ?? "io";
    const activeTab: TabId = (
      ["messages", "io", "tools", "metadata", "raw"].includes(tabParam)
        ? tabParam
        : "io"
    ) as TabId;
    // VESTIGIAL: the old /traces list encoded its
    // filter QS into ?from=... and this block rebuilt the back-link. The list
    // page is now a redirect to /timeline (which drops these params) and the
    // Timeline Trace tab links here WITHOUT ?from= — so this path is
    // effectively a no-op that lands on /traces → /timeline. Kept only so a
    // bookmarked pre-merge URL still resolves safely (the same
    // no-slash/no-injection guard applies). Delete with the TraceList
    // dead-code cleanup (deferred).
    const fromRaw = c.req.query("from") ?? "";
    const backHref = (() => {
      if (!fromRaw) return "/traces";
      const decoded = (() => { try { return decodeURIComponent(fromRaw); } catch { return ""; } })();
      if (!decoded || /[/\\<>'"]/.test(decoded)) return "/traces";
      return `/traces?${decoded}`;
    })();

    const db = openIndexDb(homeBase);
    let spans: WaterfallSpan[] = [];
    let fullSpans: SpanNode[] = [];
    let brainCosts: BrainSpanCost[] = [];
    let totals: TraceTotals | undefined;

    if (db) {
      try {
        const spanRows = db.query<SpanRow, [string]>(`
          SELECT trace_id, span_id, parent_span_id, name, start_unix_nano, end_unix_nano
          FROM spans
          WHERE trace_id = ?
          ORDER BY start_unix_nano ASC
        `).all(traceId);

        spans = spanRows as WaterfallSpan[];

        // Load full spans (with attributes) from JSONL
        const dayRow = db.query<{ day: string }, [string]>(
          "SELECT day FROM spans WHERE trace_id = ? LIMIT 1"
        ).get(traceId);

        if (dayRow) {
          const rawSpans = loadFullSpans(homeBase, dayRow.day, traceId);
          fullSpans = rawSpans as SpanNode[];
          brainCosts = buildBrainCosts(rawSpans);
          totals = buildTraceTotals(brainCosts);
        }
      } finally {
        db.close();
      }
    }

    // Default active span = root
    const resolvedActiveSpanId =
      activeSpanId ??
      fullSpans.find((s) => s.parent_span_id === null)?.span_id ??
      spans.find((s) => s.parent_span_id === null)?.span_id;

    return c.html(
      <Layout title={`trace ${traceId.slice(0, 8)} · siltpoke`}>
        <TraceDetail
          traceId={traceId}
          spans={spans}
          fullSpans={fullSpans}
          brainCosts={brainCosts}
          totals={totals}
          activeSpanId={resolvedActiveSpanId}
          activeTab={activeTab}
          backHref={backHref}
        />
      </Layout>,
    );
  });

  // Spillover fetch: returns the full input/output payload for a span when
  // it exceeded the in-memory cap and was written to a sidecar JSON file
  // by the Tracer. Searches all day partitions under traces/spillover/.
  // 404 when not found; never reveals filesystem paths.
  app.get("/api/traces/:trace_id/spans/:span_id/spillover/:role", async (c) => {
    const traceId = c.req.param("trace_id");
    const spanId = c.req.param("span_id");
    const role = c.req.param("role");
    if (!/^[a-f0-9]{1,64}$/.test(traceId)) return c.text("invalid trace_id", 400);
    if (!/^[a-f0-9]{1,32}$/.test(spanId)) return c.text("invalid span_id", 400);
    if (role !== "input" && role !== "output") return c.text("invalid role", 400);
    const { readdir, readFile } = await import("node:fs/promises");
    const root = join(homeBase, "traces", "spillover");
    if (!existsSync(root)) return c.text("not found", 404);
    let days: string[];
    try {
      days = await readdir(root);
    } catch {
      return c.text("not found", 404);
    }
    for (const day of days.sort().reverse()) {
      const file = join(root, day, `${traceId}-${spanId}-${role}.json`);
      if (!existsSync(file)) continue;
      try {
        const body = await readFile(file, "utf8");
        return c.text(body, 200, { "Content-Type": "application/json; charset=utf-8" });
      } catch {
        return c.text("read failed", 500);
      }
    }
    return c.text("not found", 404);
  });
}
