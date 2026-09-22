// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
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
import type { BrainOutput, Finding, PersistedFinding } from "../../brain/schema";
import { withFindingIds } from "../../critic/evidence-guard";
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

/**
 * The fenced block belonging to the section that starts at `headingIdx`, or ""
 * when that section has no fence.
 *
 * The two bounds are deliberately asymmetric, and each one is a bug that was
 * actually hit:
 *
 * - The OPENING fence is searched only up to the next `## ` heading. A critique
 *   with nothing to say now renders as a plain sentence and no fence at all
 *   (`renderCritiqueSection` in src/state/critique.ts), and an unbounded search
 *   walks straight on into `## Evidence` — whose snippets ARE fenced — and
 *   reports a diff hunk as the critique the reviewer wrote.
 *
 * - The CLOSING fence is then searched WITHOUT that bound, because a `## ` line
 *   inside a fence is content, not a heading, and reviewers write markdown
 *   headings inside their critiques all the time. Bounding this half too blanked
 *   a real 1,477-character critique in the archive
 *   (`.siltpoke/critiques/archive/2026-09-01/c-1e0c.md`, whose body opens with
 *   `## Output shape regression breaks fixed-position parsing`) — the same
 *   "cannot tell empty from eaten" ambiguity this file's change exists to
 *   remove, moved one layer down and made silent.
 */
function fencedBlockAfter(bodyLines: string[], headingIdx: number): string {
  const nextHeadingIdx = bodyLines.findIndex(
    (l, idx) => idx > headingIdx && l.trimStart().startsWith("## "),
  );
  const sectionEnd = nextHeadingIdx > headingIdx ? nextHeadingIdx : bodyLines.length;

  let openFenceIdx = -1;
  let fence = "";
  for (let i = headingIdx + 1; i < sectionEnd; i++) {
    const ln = (bodyLines[i] ?? "").trim();
    if (ln.startsWith("`")) {
      openFenceIdx = i;
      fence = ln;
      break;
    }
  }
  if (openFenceIdx < 0) return "";

  const closeFenceIdx = bodyLines.findIndex(
    (l, idx) => idx > openFenceIdx && l.trim() === fence,
  );
  if (closeFenceIdx <= openFenceIdx) return "";
  return bodyLines.slice(openFenceIdx + 1, closeFenceIdx).join("\n");
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
  const critiqueIdx = bodyLines.findIndex(l => l.includes("## Critique (for Claude"));
  const critiqueBody = critiqueIdx < 0 ? "" : fencedBlockAfter(bodyLines, critiqueIdx);

  return { fm, critiqueBody, bubbleShort };
}

/**
 * The same critique read as DATA, when the sidecar is there.
 *
 * `parseCritiqueFile` reconstructs a review by matching heading text and fence
 * markers in rendered prose, and where that gives up it substitutes a constant.
 * That is a parser whose contract is somebody else's wording, and the empty
 * array it produces is indistinguishable from a review that cited nothing.
 * `findings` would have inherited exactly that on its first day.
 *
 * So the sidecar is tried FIRST and the prose parse is the fallback. An absent
 * sidecar means the critique is older than it — which is every critique already
 * on disk, and those keep rendering exactly as they did (AC9).
 */
async function loadSidecar(critiquePath: string): Promise<BrainOutput | null> {
  try {
    const raw = await readFile(critiquePath.replace(/\.md$/, ".json"), "utf8");
    const parsed = JSON.parse(raw) as { brain_output?: unknown };
    return (parsed.brain_output as BrainOutput | undefined) ?? null;
  } catch {
    return null;
  }
}

/**
 * What this route returns.
 *
 * Declared here rather than borrowed from `BrainOutputV2`: `findings` lives on
 * the v1 output, the v2 schema is deliberately not wired into production, and
 * widening it to satisfy a route would be wiring it by the back door.
 */
export type CritiquePayload = Partial<BrainOutputV2> & {
  id: string;
  findings: Finding[];
};

function toCritiqueShape(
  id: string,
  parsed: ParsedCritiqueFile,
  sidecar: BrainOutput | null,
): CritiquePayload {
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
    critique_for_claude: sidecar?.critique_for_claude || critiqueBody || undefined,
    bubble_short: sidecar?.bubble_short || bubbleShort || undefined,
    // `PersistedFinding`, not `ModelFinding`: a sidecar written by a current
    // build carries the range and the tier the guard derived, and `loadSidecar` is a
    // bare `JSON.parse` so they survive the round trip. Casting to the narrower
    // type here would type them away on the one surface a human can look at
    // them on. Ids are numbered over the array as persisted, which is the array
    // the guard already filtered — see `withFindingIds`.
    //
    // An older sidecar has none of those fields, and gets none
    // invented for it: no tier means no badge, not a weak one.
    findings: withFindingIds((sidecar?.findings ?? []) as PersistedFinding[]),
    // v2 fields default to absence (card degrades gracefully)
    intent: undefined,
    evidence: [],
    web_sources: [],
    reasoning: sidecar?.reasoning,
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
    const critique = toCritiqueShape(id, parsed, await loadSidecar(critiquePath));

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
        <Layout title="critique not found · siltpoke" secret={secret}>
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
        <Layout title="critique error · siltpoke" secret={secret}>
          <div style={{ fontFamily: "var(--font-mono)", padding: 32 }}>
            error reading critique {id}
          </div>
        </Layout>,
        500,
      );
    }

    const parsed = parseCritiqueFile(raw);
    const critique = toCritiqueShape(id, parsed, await loadSidecar(critiquePath));

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
      <Layout title={`critique ${id} · siltpoke`} secret={secret}>
        <CritiquePermalink critique={critique} spans={spans} traceIds={traceIds} />
      </Layout>,
    );
  });
}
