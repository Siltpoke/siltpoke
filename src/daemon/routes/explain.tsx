// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
// Copyright (c) 2026 Jiaqi Duan
/** @jsxImportSource hono/jsx */
/**
 * `/siltpoke-explain` daemon routes.
 *
 * Three surfaces:
 *   GET /api/explain/:id         JSON envelope (Bearer auth)
 *   GET /explain/:id             SSR markdown render (same-origin)
 *   GET /api/explain/:id/stream  SSE token stream (Bearer auth)
 *
 * `:id` is the 12-hex `target_key_sha256` from the explanation's sidecar
 * meta — see `src/explain/store.ts:cacheKey`.
 *
 * v1 SSE implementation: streams the persisted markdown line by
 * line as `event: token`. First-class Brain token streaming (chat-stream
 * primitives wired through explain.ts) is a follow-up if in-house use
 * shows users want it.
 */
import type { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { isAuthorized } from "../auth";
import { listExplanations, readExplanation } from "../../explain/store";

export interface ExplainRouteDeps {
  cwd: string;
  secret?: string;
}

function checkBearer(secret: string, header: string | undefined): boolean {
  if (!secret) return true;
  const provided =
    header && header.startsWith("Bearer ") ? header.slice("Bearer ".length) : undefined;
  return isAuthorized(secret, provided);
}

export function mountExplainRoutes(
  app: Hono,
  deps: ExplainRouteDeps,
): void {
  const { cwd } = deps;
  const secret = deps.secret ?? process.env.SILTPOKE_SECRET ?? "";

  // If neither dep.secret nor SILTPOKE_SECRET is
  // configured, `checkBearer` silently allows every request — explanations
  // contain source-code snippets, so this is a real (low-severity) leak on a
  // misconfigured daemon. Surface the gap once at mount time so the operator
  // sees it in startup logs.
  if (!secret) {
    console.warn(
      "[siltpoke] SILTPOKE_SECRET not set — /api/explain routes are unprotected (anyone with localhost HTTP access can read cached explanations).",
    );
  }

  // The cache key is `sha256(target_node_id)[:12]`
  // (hex). Validate the route param against that shape before passing it to
  // `readExplanation`, otherwise a crafted id can probe paths outside the
  // explanations directory (file-existence oracle).
  const ID_RE = /^[0-9a-f]{12}$/;

  // ── GET /api/explain/:id ────────────────────────────────────────────────
  app.get("/api/explain/:id", async (c) => {
    if (!checkBearer(secret, c.req.header("Authorization"))) {
      return c.json({ success: false, error: "unauthorized" }, 401);
    }
    const id = c.req.param("id");
    if (!ID_RE.test(id)) {
      return c.json({ success: false, error: "invalid id" }, 400);
    }
    const result = await readExplanation(cwd, id);
    if (!result) {
      return c.json({ success: false, error: "explanation not found" }, 404);
    }
    return c.json({
      success: true,
      data: {
        target: result.meta.target,
        target_node_id: result.meta.target_node_id,
        mdPath: result.mdPath,
        metaPath: result.metaPath,
        evidence_score: result.meta.evidence_score,
        low_confidence: result.meta.low_confidence,
        depth: result.meta.depth,
        graph_indexed_ts: result.meta.graph_indexed_ts,
        brain_usage: result.meta.brain_usage,
        created_ts: result.meta.created_ts,
      },
      error: null,
    });
  });

  // ── GET /explain ────────────────────────────────────────────────────────
  // Browser-facing list of all persisted explanations under {cwd}/.siltpoke/
  // explanations. No auth (same trust model as /explain/:id).
  app.get("/explain", async (c) => {
    const entries = await listExplanations(cwd);
    return c.html(
      <html lang="en">
        <head>
          <meta charset="utf-8" />
          <meta name="viewport" content="width=device-width, initial-scale=1" />
          <title>explanations · siltpoke</title>
          <style>{`
            :root { --cream:#faf6ec; --paper:#f4eedf; --paperD:#e8dec7; --edge:#d8cbab; --ink:#1f1b16; --ink2:#5a4f3f; --ink3:#8a7c64; --terra:#d96b6b; --moss:#7a9a5e; --amber:#e8a85c; --mono:'JetBrains Mono','SF Mono',Menlo,Consolas,monospace; }
            body { font-family: 'Geist',-apple-system,BlinkMacSystemFont,system-ui,sans-serif; max-width: 880px; margin: 2.5rem auto; padding: 0 1.5rem; line-height: 1.55; color: var(--ink); background: var(--cream); }
            h1 { font-size: 1.55rem; margin: 0 0 .25rem; letter-spacing: -.01em; }
            .subtitle { color: var(--ink3); margin: 0 0 1.5rem; font-size: .9rem; }
            .empty { background: var(--paper); border: 1px solid var(--edge); padding: 1rem 1.2rem; border-radius: 10px; color: var(--ink2); font-size: .9rem; }
            .empty code { font-family: var(--mono); background: var(--paperD); padding: .12rem .4rem; border-radius: 4px; font-size: .85em; }
            ul.entries { list-style: none; margin: 0; padding: 0; display: grid; gap: .55rem; }
            ul.entries li a { display: block; background: var(--paper); border: 1px solid var(--edge); border-radius: 10px; padding: .9rem 1.1rem; text-decoration: none; color: var(--ink); transition: border-color .15s, background .15s, transform .1s; }
            ul.entries li a:hover { border-color: var(--terra); background: var(--paperD); transform: translateY(-1px); }
            .target { font-weight: 600; font-family: var(--mono); font-size: .92rem; }
            .target small { font-family: 'Geist',-apple-system,system-ui,sans-serif; color: var(--ink3); font-weight: 400; font-size: .78rem; }
            .meta-row { font-family: var(--mono); font-size: .76rem; color: var(--ink3); margin-top: .4rem; display: flex; gap: 1.1rem; flex-wrap: wrap; }
            .low { color: var(--amber); font-weight: 600; }
            .high { color: var(--moss); }
          `}</style>
        </head>
        <body>
          <h1>Explanations</h1>
          <p class="subtitle">
            {entries.length === 0
              ? "Persisted /siltpoke-explain output for this project lives here."
              : `${entries.length} explanation${entries.length === 1 ? "" : "s"} cached under .siltpoke/explanations/`}
          </p>
          {entries.length === 0 ? (
            <div class="empty">
              No explanations yet. Generate one by running{" "}
              <code>/siltpoke-explain &lt;target&gt;</code> or{" "}
              <code>bun src/cli/explain.ts &lt;target&gt;</code> from this
              project's working directory.
            </div>
          ) : (
            <ul class="entries">
              {entries.map((e) => (
                <li>
                  <a href={`/explain/${e.key}`}>
                    <div class="target">
                      {e.target} <small>· depth {e.depth}</small>
                    </div>
                    <div class="meta-row">
                      <span>{e.target_node_id}</span>
                      <span
                        class={e.low_confidence ? "low" : "high"}
                      >
                        evidence {e.evidence_score.toFixed(2)}
                        {e.low_confidence ? " ⚠" : ""}
                      </span>
                      <span>created {e.created_ts}</span>
                    </div>
                  </a>
                </li>
              ))}
            </ul>
          )}
        </body>
      </html>,
    );
  });

  // ── GET /explain/:id ────────────────────────────────────────────────────
  app.get("/explain/:id", async (c) => {
    const id = c.req.param("id");
    if (!ID_RE.test(id)) {
      return c.html(
        <html lang="en">
          <head>
            <meta charset="utf-8" />
            <title>invalid id · siltpoke</title>
          </head>
          <body
            style={{
              fontFamily:
                "-apple-system, BlinkMacSystemFont, system-ui, sans-serif",
              padding: 32,
              color: "#71717a",
            }}
          >
            invalid explanation id
          </body>
        </html>,
        400,
      );
    }
    const result = await readExplanation(cwd, id);
    if (!result) {
      return c.html(
        <html lang="en">
          <head>
            <meta charset="utf-8" />
            <title>explanation not found · siltpoke</title>
          </head>
          <body
            style={{
              fontFamily:
                "-apple-system, BlinkMacSystemFont, system-ui, sans-serif",
              padding: 32,
              color: "#71717a",
            }}
          >
            explanation {id} not found
          </body>
        </html>,
        404,
      );
    }

    const meta = result.meta;
    return c.html(
      <html lang="en">
        <head>
          <meta charset="utf-8" />
          <meta name="viewport" content="width=device-width, initial-scale=1" />
          <title>{meta.target} · siltpoke explain</title>
          <style>{`
            :root { --cream:#faf6ec; --paper:#f4eedf; --paperD:#e8dec7; --edge:#d8cbab; --ink:#1f1b16; --ink2:#5a4f3f; --ink3:#8a7c64; --amber:#e8a85c; --mono:'JetBrains Mono','SF Mono',Menlo,Consolas,monospace; }
            body { font-family: 'Geist',-apple-system,BlinkMacSystemFont,system-ui,sans-serif; max-width: 880px; margin: 2.5rem auto; padding: 0 1.5rem; line-height: 1.65; color: var(--ink); background: var(--cream); }
            a.back { display: inline-block; margin-bottom: 1.2rem; font-family: var(--mono); font-size: .82rem; color: var(--ink3); text-decoration: none; }
            a.back:hover { color: var(--ink); }
            .banner { background: #fbf0d8; border: 1px solid var(--amber); padding: .65rem 1rem; border-radius: 8px; margin-bottom: 1.2rem; color: #8a5a1a; }
            pre { background: var(--paper); border: 1px solid var(--edge); padding: 1rem; border-radius: 10px; overflow-x: auto; font-size: .85rem; line-height: 1.6; }
            code { font-family: var(--mono); }
            .meta { color: var(--ink3); font-size: .82rem; margin-top: 2rem; padding-top: 1rem; border-top: 1px solid var(--edge); font-family: var(--mono); }
            .meta dt { font-weight: 600; color: var(--ink2); }
            .meta dd { margin: 0 0 .4rem 0; }
          `}</style>
        </head>
        <body>
          <a class="back" href="/explain">← all explanations</a>
          {meta.low_confidence ? (
            <div class="banner">
              ⚠ <strong>low confidence</strong> — evidence_score{" "}
              {meta.evidence_score.toFixed(2)} (&lt; 0.9). Review citations
              carefully.
            </div>
          ) : null}
          <pre>
            <code>{result.markdown}</code>
          </pre>
          <dl class="meta">
            <dt>target</dt>
            <dd>{meta.target}</dd>
            <dt>node id</dt>
            <dd>{meta.target_node_id}</dd>
            <dt>graph indexed at</dt>
            <dd>{meta.graph_indexed_ts}</dd>
            <dt>created at</dt>
            <dd>{meta.created_ts}</dd>
            <dt>Brain cost (USD)</dt>
            <dd>{(meta.brain_usage.total_cost_usd ?? 0).toFixed(4)}</dd>
            <dt>depth</dt>
            <dd>{meta.depth}</dd>
          </dl>
        </body>
      </html>,
    );
  });

  // ── GET /api/explain/:id/stream ─────────────────────────────────────────
  // v1: stream the persisted markdown line-by-line as `event: token`.
  // True Brain token streaming = follow-up.
  app.get("/api/explain/:id/stream", async (c) => {
    if (!checkBearer(secret, c.req.header("Authorization"))) {
      return c.json({ success: false, error: "unauthorized" }, 401);
    }
    const id = c.req.param("id");
    if (!ID_RE.test(id)) {
      return c.json({ success: false, error: "invalid id" }, 400);
    }
    const result = await readExplanation(cwd, id);
    if (!result) {
      return c.json({ success: false, error: "explanation not found" }, 404);
    }

    return streamSSE(c, async (stream) => {
      const lines = result.markdown.split(/\r?\n/);
      for (const line of lines) {
        if (line.length === 0) continue;
        await stream.writeSSE({
          event: "token",
          data: line,
        });
      }
      await stream.writeSSE({
        event: "done",
        data: JSON.stringify({
          mdPath: result.mdPath,
          metaPath: result.metaPath,
          evidence_score: result.meta.evidence_score,
          low_confidence: result.meta.low_confidence,
          brain_usage: result.meta.brain_usage,
        }),
      });
    });
  });
}
