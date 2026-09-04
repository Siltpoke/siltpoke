// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
// Copyright (c) 2026 Jiaqi Duan
/** @jsxImportSource hono/jsx */
/**
 * Legacy critic-history routes + the critique APIs.
 *
 * The /history SSR page merged into /timeline (routes/timeline.tsx).
 * /history and /critic are 302 redirects now — query strings preserved,
 * because /timeline consumes the exact same filter params (the parsers
 * below are what timeline.tsx imports). The /api/critique/* and
 * /api/critic/* endpoints all stay here, byte-compatible.
 *
 * POST /api/critic/action — appends a {session_id, timestamp, action: dismiss|ack}
 * entry to ~/.siltpoke/critic-actions.jsonl. Telemetry merges these into the
 * recent table as `user_action`. Last-write-wins per (session, timestamp).
 *
 * POST /api/critic/budget — patch the `budget:` block of ~/.siltpoke/config.json.
 * Accepts {dailyTokenLimit, softWarnAtPercent, hardStopAtPercent}; clamps to
 * sensible ranges and persists. Used by the in-page budget editor.
 */
import type { Context, Hono } from "hono";
import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { DiffView } from "../screens/Critic";
import { isAuthorized } from "../../daemon/auth";
import type {
  CallStatus,
  StatusFilter,
  SpeechKind,
  SortOrder,
  TimeRange,
} from "../../state/api";
import {
  appendFeedback,
  readFeedbackHistory,
  type FeedbackAction,
} from "../../state/api";

export interface CriticRouteDeps {
  homeBase?: string;
  /**
   * Daemon secret — gates POST /api/critic/budget (rewrites the spend
   * guardrail) and POST /api/critic/action. Absent → both fail CLOSED (401).
   * See the daemon-hardening security audit, finding 2.
   */
  secret?: string;
}

const VALID_STATUS = new Set<CallStatus>(["fired", "skipped"]);
const VALID_KIND = new Set<SpeechKind>(["comment", "warning", "critical"]);
const VALID_RANGE = new Set<TimeRange>(["today", "7d", "30d", "all"]);

/**
 * Status query param parser.
 *   undefined         → default ("fired") — first-load page shows real fires
 *   "all"             → null (no filter)
 *   "fired"/"skipped" → that filter
 *   "errors"          → brain-failure rows (error_message facet)
 *   anything else     → default ("fired")
 *
 * Recursion-guard rows are tagged status=skipped, so the default "fired"
 * filter naturally hides them. Users who want them flip the chip to "all"
 * or "skipped".
 *
 * Exported (with the sibling parsers below) so /timeline reuses the exact
 * same query-param semantics — filter parity by reuse, not copy.
 */
export function parseStatus(v: string | undefined): StatusFilter | null {
  if (v === undefined) return "fired";
  if (v === "all") return null;
  if (v === "errors") return "errors";
  if (VALID_STATUS.has(v as CallStatus)) return v as CallStatus;
  return "fired";
}
export function parseKind(v: string | undefined): SpeechKind | null {
  return v && VALID_KIND.has(v as SpeechKind) ? (v as SpeechKind) : null;
}
export function parseRange(v: string | undefined): TimeRange {
  return v && VALID_RANGE.has(v as TimeRange) ? (v as TimeRange) : "all";
}
export function parseSort(v: string | undefined): SortOrder {
  return v === "oldest" ? "oldest" : "newest";
}

export function mountCriticRoutes(app: Hono, deps: CriticRouteDeps = {}): void {
  const homeBase =
    deps.homeBase ?? process.env.SILTPOKE_HOME ?? join(homedir(), ".siltpoke");

  // Old URLs survive as redirects to the merged /timeline page.
  // Query strings are preserved: /timeline consumes the exact same filter
  // params (status/kind/range/sort/project/q), so bookmarked filter combos
  // map 1:1. /critic (the previous name) goes STRAIGHT to /timeline —
  // the old /critic → /history hop is collapsed, no double redirect.
  const toTimeline = (c: Context) => {
    const qs = c.req.url.split("?")[1];
    return c.redirect(qs ? `/timeline?${qs}` : "/timeline");
  };
  app.get("/critic", toTimeline);
  app.get("/history", toTimeline);

  // On-demand diff snapshot loader.
  // /history SSR strips diff_text bodies (they balloon HTML to tens of MB on
  // busy windows). The row expansion UI calls this endpoint via fetch when
  // the user actually opens a critique. Returns text/plain; 404 if no
  // matching snapshot.
  app.get("/api/critique/:critique_id/diff", async (c) => {
    const critiqueId = c.req.param("critique_id");
    if (!/^[A-Za-z0-9._-]{1,128}$/.test(critiqueId)) {
      return c.text("invalid critique_id", 400);
    }
    const callsPath = join(homeBase, "brain-calls.jsonl");
    if (!existsSync(callsPath)) return c.text("not found", 404);
    let raw: string;
    try {
      raw = await readFile(callsPath, "utf8");
    } catch {
      return c.text("read failed", 500);
    }
    let snapshotId: string | null = null;
    for (const line of raw.split("\n")) {
      if (!line.trim()) continue;
      try {
        const ev = JSON.parse(line) as { critique_id?: string; diff_snapshot_id?: string };
        if (ev.critique_id === critiqueId && typeof ev.diff_snapshot_id === "string") {
          snapshotId = ev.diff_snapshot_id;
          break;
        }
      } catch {
        // skip malformed line
      }
    }
    if (!snapshotId) return c.text("no snapshot", 404);
    if (!/^[A-Za-z0-9._-]{1,128}$/.test(snapshotId)) {
      return c.text("invalid snapshot id", 400);
    }
    const filePath = join(homeBase, "critic-snapshots", snapshotId);
    if (!existsSync(filePath)) return c.text("snapshot file missing", 404);
    const MAX_BYTES = 512 * 1024;
    let body: string;
    try {
      body = await readFile(filePath, "utf8");
    } catch {
      return c.text("snapshot read failed", 500);
    }
    if (body.length > MAX_BYTES) {
      const window = body.slice(0, MAX_BYTES);
      const lastBoundary = window.lastIndexOf("\ndiff --git ");
      body = lastBoundary > 0
        ? `${window.slice(0, lastBoundary)}\n--- truncated: more files in original snapshot ---\n`
        : `${window}\n--- truncated ---\n`;
    }
    // Render via the same DiffView component the SSR path uses so the
    // collapsible per-file rows + side-by-side hunks come through unchanged.
    const html = String(<DiffView text={body} />);
    return c.html(html);
  });

  app.post("/api/critic/budget", async (c) => {
    // Secret-gate — rewrites the spend/cost guardrail; an unauthenticated
    // cross-origin POST could disable it (finding 2). Fail CLOSED.
    if (!isAuthorized(deps.secret ?? "", c.req.header("X-Siltpoke-Secret"))) {
      return c.json({ error: "unauthorized" }, 401);
    }
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "invalid json" }, 400);
    }
    if (typeof body !== "object" || body === null) {
      return c.json({ error: "expected object body" }, 400);
    }
    const b = body as { dailyTokenLimit?: unknown; softWarnAtPercent?: unknown; hardStopAtPercent?: unknown };
    const patch: Record<string, number> = {};
    if (b.dailyTokenLimit !== undefined) {
      const n = Number(b.dailyTokenLimit);
      if (!Number.isFinite(n) || n < 0 || n > 100_000_000) {
        return c.json({ error: "dailyTokenLimit out of range" }, 400);
      }
      patch.dailyTokenLimit = Math.floor(n);
    }
    if (b.softWarnAtPercent !== undefined) {
      const n = Number(b.softWarnAtPercent);
      if (!Number.isFinite(n) || n < 0 || n > 200) {
        return c.json({ error: "softWarnAtPercent out of range" }, 400);
      }
      patch.softWarnAtPercent = n;
    }
    if (b.hardStopAtPercent !== undefined) {
      const n = Number(b.hardStopAtPercent);
      if (!Number.isFinite(n) || n < 0 || n > 200) {
        return c.json({ error: "hardStopAtPercent out of range" }, 400);
      }
      patch.hardStopAtPercent = n;
    }
    if (Object.keys(patch).length === 0) {
      return c.json({ error: "no recognized fields" }, 400);
    }
    const configPath = join(homeBase, "config.json");
    let current: Record<string, unknown> = {};
    if (existsSync(configPath)) {
      try {
        current = JSON.parse(await readFile(configPath, "utf8")) as Record<string, unknown>;
      } catch {
        current = {};
      }
    }
    const prevBudget = (typeof current.budget === "object" && current.budget !== null)
      ? (current.budget as Record<string, unknown>)
      : {};
    const merged = { ...current, budget: { ...prevBudget, ...patch } };
    await mkdir(homeBase, { recursive: true });
    await writeFile(configPath, JSON.stringify(merged, null, 2), "utf8");
    return c.json({ ok: true, budget: merged.budget });
  });

  // Few-shot retrieval — finds top-K dismissed past critiques nearest to
  // this critique's query text via the few-shot embedding index. Used by
  // Block D's inline panel; returns empty array when the index is too
  // small (<10 entries) or no neighbors clear the similarity floor.
  app.get("/api/critique/:critique_id/few-shot", async (c) => {
    const critiqueId = c.req.param("critique_id");
    if (!/^[A-Za-z0-9._-]{1,128}$/.test(critiqueId)) {
      return c.json({ error: "invalid critique_id" }, 400);
    }
    try {
      const { loadSidecarForCritique } = await import("../../state/api");
      const { loadIndex } = await import("../../few-shot/index");
      const { findNearest } = await import("../../few-shot/retriever");
      const { defaultEmbedder } = await import("../../few-shot/embedder");

      const sidecar = await loadSidecarForCritique(homeBase, critiqueId);
      const queryText =
        sidecar?.critique_for_claude
        ?? sidecar?.reasoning
        ?? sidecar?.bubble_long
        ?? sidecar?.bubble_short
        ?? "";
      if (!queryText) return c.json({ critique_id: critiqueId, examples: [] });

      const index = await loadIndex();
      if (index.length < 10) {
        return c.json({
          critique_id: critiqueId,
          examples: [],
          note: `index has ${index.length} entries (need ≥10)`,
        });
      }
      const embedder = await defaultEmbedder();
      const qe = await embedder.embed(queryText);
      const neighbors = findNearest(Array.from(qe), index, 5);
      const examples = neighbors
        .filter((n) => n.similarity >= 0.3 && n.entry.id !== critiqueId)
        .slice(0, 5)
        .map((n) => ({
          critique_id: n.entry.id,
          similarity: n.similarity,
          summary: n.entry.critique_summary,
          reason_text: n.entry.reason_text,
          ts: n.entry.ts,
        }));
      return c.json({ critique_id: critiqueId, examples });
    } catch (err) {
      return c.json({ error: "few-shot failed", detail: String(err) }, 500);
    }
  });

  // GET feedback history for one critique. Returns full history
  // oldest→newest. Empty array when no entries exist.
  app.get("/api/critique/:critique_id/feedback", async (c) => {
    const critiqueId = c.req.param("critique_id");
    if (!/^[A-Za-z0-9._-]{1,128}$/.test(critiqueId)) {
      return c.json({ error: "invalid critique_id" }, 400);
    }
    const history = await readFeedbackHistory(homeBase, critiqueId);
    return c.json({ critique_id: critiqueId, history });
  });

  // POST feedback entry. Body: { text: string, action?: "edit"|"ack"|"dismiss" }.
  // Empty text is allowed and means "user cleared the note" — there is no
  // separate delete endpoint; the latest entry's text always wins for display.
  app.post("/api/critique/:critique_id/feedback", async (c) => {
    // Secret-gate — same pattern as /api/critic/action + /api/critic/budget
    // above (daemon-hardening security audit, finding 3 — residual gap):
    // an unauthenticated cross-origin POST could otherwise append an
    // arbitrary feedback entry. Fail CLOSED.
    if (!isAuthorized(deps.secret ?? "", c.req.header("X-Siltpoke-Secret"))) {
      return c.json({ error: "unauthorized" }, 401);
    }
    const critiqueId = c.req.param("critique_id");
    if (!/^[A-Za-z0-9._-]{1,128}$/.test(critiqueId)) {
      return c.json({ error: "invalid critique_id" }, 400);
    }
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "invalid json" }, 400);
    }
    if (typeof body !== "object" || body === null) {
      return c.json({ error: "expected object body" }, 400);
    }
    const b = body as { text?: unknown; action?: unknown };
    if (typeof b.text !== "string") {
      return c.json({ error: "text required (use \"\" to clear)" }, 400);
    }
    if (b.text.length > 10000) {
      return c.json({ error: "text too long (max 10000 chars)" }, 400);
    }
    const action: FeedbackAction =
      b.action === "ack" || b.action === "dismiss" ? b.action : "edit";
    try {
      await appendFeedback(homeBase, {
        critique_id: critiqueId,
        ts: new Date().toISOString(),
        text: b.text,
        action,
      });
    } catch (err) {
      return c.json({ error: "write failed", detail: String(err) }, 500);
    }
    return c.json({ ok: true });
  });

  app.post("/api/critic/action", async (c) => {
    // Secret-gate — writes a dismiss/ack action to critic-actions.jsonl on an
    // unauthenticated cross-origin POST otherwise (finding 2). Fail CLOSED.
    if (!isAuthorized(deps.secret ?? "", c.req.header("X-Siltpoke-Secret"))) {
      return c.json({ error: "unauthorized" }, 401);
    }
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "invalid json" }, 400);
    }
    if (typeof body !== "object" || body === null) {
      return c.json({ error: "expected object body" }, 400);
    }
    const b = body as { session_id?: unknown; timestamp?: unknown; action?: unknown };
    if (typeof b.session_id !== "string" || b.session_id.length === 0) {
      return c.json({ error: "session_id required" }, 400);
    }
    if (typeof b.timestamp !== "string" || b.timestamp.length === 0) {
      return c.json({ error: "timestamp required" }, 400);
    }
    if (b.action !== "dismiss" && b.action !== "ack" && b.action !== "clear") {
      return c.json({ error: "action must be dismiss|ack|clear" }, 400);
    }
    const entry = {
      session_id: b.session_id,
      timestamp: b.timestamp,
      action: b.action,
      at: new Date().toISOString(),
    };
    await mkdir(homeBase, { recursive: true });
    await appendFile(
      join(homeBase, "critic-actions.jsonl"),
      `${JSON.stringify(entry)}\n`,
      "utf8",
    );
    return c.json({ ok: true });
  });
}
