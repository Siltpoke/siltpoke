// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Copyright (c) 2026 Jiaqi Duan
/** @jsxImportSource hono/jsx */
/**
 * Critique permalink routes.
 *
 * GET /api/critiques/:id  → JSON: BrainOutputV2-shaped payload + trace_ids
 * GET /critique/:id       → SSR: CritiquePermalink screen
 *
 * Auth: shared-secret Bearer token (same pattern as /hooks/stop).
 * The API route requires the token; the SSR route does NOT (browser-facing
 * page, same same-origin trust model as /traces/:id). If you need to lock
 * the SSR route too, add the same isAuthorized check there.
 *
 * Frontmatter parsing: the v1 critique Markdown format uses a YAML-like
 * front-matter block. We parse it with a hand-rolled line-by-line parser
 * (no extra dep) since the format is tightly controlled by writeCritique().
 * v1 files lacking v2 fields (intent, evidence, etc.) map to safe defaults.
 */
import type { Hono } from "hono";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";
import { isAuthorized } from "../auth";
import { findCritiqueByIdOrLatest } from "../../state/critique-status";
import { TraceStore } from "../../observability/storage";
import { Layout } from "../../web/_shared/layout";
import { CritiquePermalink } from "../../web/screens/CritiquePermalink";
import type { BrainOutputV2 } from "../../brain/schema-v2";
import type { WaterfallSpan } from "../../web/primitives/TraceWaterfall";

export interface CritiqueRouteDeps {
  homeBase?: string;
  secret?: string;
}

// ---------------------------------------------------------------------------
// Frontmatter parser
//
// The critique .md file looks like:
//   ---
//   schemaVersion: 1
//   timestamp: 2026-05-20T12:00:00.000Z
//   critique_id: c-ab12
//   session_id: sess-xyz
//   cwd: /home/user/project
//   mood: neutral
//   pose: sit
//   severity: high
//   confidence: high
//   status: pending
//   ---
//
//   # [SILTPOKE CRITIQUE]
//   ...
//   ## Critique (for Claude, if forwarded)
//   ``` (fence)
//   <critique_for_claude body>
//   ``` (fence)
// ---------------------------------------------------------------------------

interface ParsedCritiqueFile {
  fm: Record<string, string>;
  critiqueBody: string;
  bubbleShort: string;
}

function parseCritiqueFile(raw: string): ParsedCritiqueFile {
  const lines = raw.split("\n");

  // Extract YAML frontmatter (between first two "---" markers)
  const fm: Record<string, string> = {};
  let fmEnd = 0;
  if (lines[0]?.trim() === "---") {
    for (let i = 1; i < lines.length; i++) {
      if (lines[i]?.trim() === "---") {
        fmEnd = i;
        break;
      }
      const line = lines[i] ?? "";
      const colonIdx = line.indexOf(":");
      if (colonIdx > 0) {
        const key = line.slice(0, colonIdx).trim();
        const val = line.slice(colonIdx + 1).trim();
        fm[key] = val;
      }
    }
  }

  const bodyLines = lines.slice(fmEnd + 1);
  const _bodyText = bodyLines.join("\n").trim();

  // Extract bubble_short: first non-empty line after "## Bubble (user-facing)"
  let bubbleShort = "";
  const bubbleIdx = bodyLines.findIndex(l => l.includes("## Bubble (user-facing)"));
  if (bubbleIdx >= 0) {
    for (let i = bubbleIdx + 1; i < bodyLines.length; i++) {
      const ln = (bodyLines[i] ?? "").trim();
      if (ln && !ln.startsWith("#")) {
        bubbleShort = ln;
        break;
      }
    }
  }

  // Extract critique_for_claude: content between the fenced block under
  // "## Critique (for Claude, if forwarded)"
  let critiqueBody = "";
  const critiqueIdx = bodyLines.findIndex(l => l.includes("## Critique (for Claude"));
  if (critiqueIdx >= 0) {
    // Find opening fence
    let openFenceIdx = -1;
    let fence = "";
    for (let i = critiqueIdx + 1; i < bodyLines.length; i++) {
      const ln = (bodyLines[i] ?? "").trim();
      if (ln.startsWith("`")) {
        openFenceIdx = i;
        fence = ln;
        break;
      }
    }
    if (openFenceIdx >= 0) {
      const closeFenceIdx = bodyLines.findIndex(
        (l, idx) => idx > openFenceIdx && l.trim() === fence
      );
      if (closeFenceIdx > openFenceIdx) {
        critiqueBody = bodyLines
          .slice(openFenceIdx + 1, closeFenceIdx)
          .join("\n");
      }
    }
  }

  return { fm, critiqueBody, bubbleShort };
}

/**
 * Map a parsed critique file into a Partial<BrainOutputV2> shape.
 * v1 files lack intent/evidence/web_sources/reasoning — they get safe defaults.
 */
function toCritiqueShape(
  id: string,
  parsed: ParsedCritiqueFile,
): Partial<BrainOutputV2> & { id: string } {
  const { fm, critiqueBody, bubbleShort } = parsed;

  const severity = (fm.severity ?? "") as BrainOutputV2["severity"];
  const confidence = (fm.confidence ?? "") as BrainOutputV2["confidence"];
  const mood = (fm.mood ?? "") as BrainOutputV2["mood"];
  const pose = (fm.pose ?? "") as BrainOutputV2["pose"];

  return {
    id,
    // v1 fields mapped directly
    severity: severity || undefined,
    confidence: confidence || undefined,
    mood: mood || undefined,
    pose: pose || undefined,
    critique_for_claude: critiqueBody || undefined,
    bubble_short: bubbleShort || undefined,
    // v2 fields default to absence (card degrades gracefully)
    intent: undefined,
    evidence: [],
    web_sources: [],
    reasoning: undefined,
    category: undefined,
    suggested_fix: undefined,
  };
}

export function mountCritiqueRoutes(
  app: Hono,
  deps: CritiqueRouteDeps = {},
): void {
  const homeBase =
    deps.homeBase ?? process.env.SILTPOKE_HOME ?? join(homedir(), ".siltpoke");
  const secret = deps.secret ?? process.env.SILTPOKE_SECRET ?? "";

  // ── GET /api/critiques/:id ──────────────────────────────────────────────
  // Requires Bearer auth (shared-secret). Returns JSON + trace_ids.
  app.get("/api/critiques/:id", async (c) => {
    const authHeader = c.req.header("Authorization") ?? "";
    const provided = authHeader.startsWith("Bearer ")
      ? authHeader.slice("Bearer ".length)
      : undefined;
    if (secret && !isAuthorized(secret, provided)) {
      return c.json({ success: false, error: "unauthorized" }, 401);
    }

    const id = c.req.param("id");
    const critiquePath = await findCritiqueByIdOrLatest(homeBase, id);
    if (!critiquePath) {
      return c.json({ success: false, error: "critique not found" }, 404);
    }

    let raw: string;
    try {
      raw = await readFile(critiquePath, "utf8");
    } catch {
      return c.json({ success: false, error: "critique file unreadable" }, 500);
    }

    const parsed = parseCritiqueFile(raw);
    const critique = toCritiqueShape(id, parsed);

    // Linked trace IDs from TraceStore
    let traceIds: string[] = [];
    try {
      const store = new TraceStore({ dir: join(homeBase, "traces") });
      traceIds = store.getTracesByCritique(id);
    } catch {
      traceIds = [];
    }

    return c.json({ success: true, data: { critique, trace_ids: traceIds } });
  });

  // ── GET /critique/:id ───────────────────────────────────────────────────
  // SSR page — no auth required (browser-facing, same-origin).
  app.get("/critique/:id", async (c) => {
    const id = c.req.param("id");
    const critiquePath = await findCritiqueByIdOrLatest(homeBase, id);
    if (!critiquePath) {
      return c.html(
        <Layout title="critique not found · siltpoke">
          <div
            style={{
              fontFamily: "var(--font-mono)",
              padding: 32,
              color: "var(--color-ink3)",
            }}
          >
            critique {id} not found
          </div>
        </Layout>,
        404,
      );
    }

    let raw: string;
    try {
      raw = await readFile(critiquePath, "utf8");
    } catch {
      return c.html(
        <Layout title="critique error · siltpoke">
          <div style={{ fontFamily: "var(--font-mono)", padding: 32 }}>
            error reading critique {id}
          </div>
        </Layout>,
        500,
      );
    }

    const parsed = parseCritiqueFile(raw);
    const critique = toCritiqueShape(id, parsed);

    // Gather all spans for linked traces
    let spans: WaterfallSpan[] = [];
    let traceIds: string[] = [];
    try {
      const store = new TraceStore({ dir: join(homeBase, "traces") });
      traceIds = store.getTracesByCritique(id);
      for (const traceId of traceIds) {
        const traceSpans = store.getSpansByTrace(traceId) as WaterfallSpan[];
        spans = spans.concat(traceSpans);
      }
    } catch {
      spans = [];
      traceIds = [];
    }

    return c.html(
      <Layout title={`critique ${id} · siltpoke`}>
        <CritiquePermalink critique={critique} spans={spans} traceIds={traceIds} />
      </Layout>,
    );
  });
}
