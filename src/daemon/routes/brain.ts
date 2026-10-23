// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
// Copyright (c) 2026 Jiaqi Duan
/**
 * Brain-select route — the dashboard half of the model-select surface
 * (Slice C / Task 8).
 *
 *   GET  /api/brain               -> { authorFamily, roles[], families[], caps, usage }
 *   GET  /api/brain/models             -> every agent's model list, as saved
 *   GET  /api/brain/models?refresh=1   -> asks every agent and both sites again (secret-gated)
 *   POST /api/brain/roles/:role   -> { family, model? }  (secret-gated)
 *   DELETE /api/brain/roles/:role -> undo that pin       (secret-gated)
 *   POST /api/brain/daily-caps    -> { review, chat, extract } (secret-gated)
 *
 * The POST calls the SAME `runBrainSet` the `/siltpoke:siltpoke-brain` command calls, so
 * the dashboard settings screen and the command write one `brain.roles.<role>`
 * source of truth — there is no second config path. Reviews pick the change up
 * on their next run; nothing here touches a running review.
 *
 * Auth mirrors the feedback route: every state-changing POST gates for itself
 * via X-Siltpoke-Secret and fails CLOSED (no configured secret ⇒ reject). The
 * plain GET is a read and is not secret-gated, matching the other dashboard
 * reads. `?refresh=1` is gated: it runs five agent CLIs, fetches two sites and
 * rewrites the saved lists, so any web page could start it with a bare GET to
 * 127.0.0.1 (small item [8] of the chat mainline).
 */
import type { Hono } from "hono";
import { dailyCapsView } from "../../brain/daily-caps-view";
import { type ModelListRunner, readModelLists, refreshModelLists } from "../../brain/model-lists";
import { loadModelFacts } from "../../brain/model-prices";
import { loadModelGuides } from "../../brain/model-guides";
import { modelWindowView } from "../../brain/model-window";
import { readCodexConfigModel } from "../../brain/providers/codex";
import { brainView, runBrainSet, runBrainUnset, setReviewByBuilder } from "../../cli/brain-cli";
import { saveQuotaDailyCaps } from "../../config/brain-quota-cap-config";
import { isAuthorized } from "../auth";

export interface BrainRouteDeps {
  /** The Siltpoke home whose config.json holds brain.roles. */
  homeBase: string;
  /** Daemon shared secret — required to authorize the POST. */
  secret: string;
  /** Test seam — runs each agent's list command. Default: a real spawn. */
  modelListRunner?: ModelListRunner;
  /** Test seam — fetches models.dev's api.json. Default: a real fetch. */
  modelsDevFetch?: () => Promise<Response>;
  /** Test seam — fetches OpenRouter's model list. Default: a real fetch. */
  openRouterFetch?: () => Promise<Response>;
  /** Test seam — the home whose ~/.codex/config.toml names codex's model. Default: the user's home. */
  codexHome?: string;
}

export function mountBrainRoutes(app: Hono, deps: BrainRouteDeps): void {
  app.get("/api/brain", (c) => {
    return c.json({ ...brainView(deps.homeBase), ...dailyCapsView(deps.homeBase) });
  });

  // Every agent's model list (spec §11.3, §12.2). Without `refresh` it is the
  // saved copy and runs nothing, so the window opens at once; `?refresh=1`
  // runs the CLIs (10 s each, together) and saves what they said. The saved
  // copy is a read, not secret-gated like GET /api/brain; the refresh runs
  // processes and writes, so it needs the secret (see the header).
  app.get("/api/brain/models", async (c) => {
    const codexConfigModel = readCodexConfigModel(deps.codexHome);
    if (c.req.query("refresh") === "1") {
      if (!isAuthorized(deps.secret, c.req.header("X-Siltpoke-Secret"))) {
        return c.json({ error: "unauthorized" }, 401);
      }
      const [lists, facts, guides] = await Promise.all([
        refreshModelLists(deps.homeBase, undefined, deps.modelListRunner),
        loadModelFacts(deps.homeBase, deps.modelsDevFetch),
        loadModelGuides(deps.homeBase, deps.openRouterFetch),
      ]);
      return c.json(modelWindowView(lists, facts, { codexConfigModel, guides }));
    }
    const cachedOnly = { cachedOnly: true };
    const [facts, guides] = await Promise.all([
      loadModelFacts(deps.homeBase, undefined, new Date(), cachedOnly),
      loadModelGuides(deps.homeBase, undefined, new Date(), cachedOnly),
    ]);
    return c.json(modelWindowView(readModelLists(deps.homeBase), facts, { codexConfigModel, guides }));
  });

  app.post("/api/brain/roles/:role", async (c) => {
    if (!isAuthorized(deps.secret, c.req.header("X-Siltpoke-Secret"))) {
      return c.json({ error: "unauthorized" }, 401);
    }
    const role = c.req.param("role");

    let body: { family?: unknown; model?: unknown };
    try {
      body = (await c.req.json()) as { family?: unknown; model?: unknown };
    } catch {
      return c.json({ error: "family required" }, 400);
    }

    if (typeof body.family !== "string" || body.family.length === 0) {
      return c.json({ error: "family required" }, 400);
    }
    const model = typeof body.model === "string" && body.model.length > 0 ? body.model : undefined;

    // runBrainSet validates role+family and writes nothing on a bad token.
    const result = runBrainSet(deps.homeBase, role, body.family, model);
    if (!result.ok) {
      return c.json({ error: result.message }, 400);
    }
    return c.json({ ok: true, message: result.message });
  });

  // Undo a global pin — the dashboard's half of `siltpoke brain unset <role>`.
  // `brain.roles.review` outranks every per-builder rule, and the dashboard
  // could set it with no way back, so a user who tried one-reviewer-for-
  // everything and then switched to per-agent rules got silence rather than an
  // error (spec brain-select-four-gaps §3.2). Same auth posture as the POSTs:
  // secret-gated, fail-closed.
  app.delete("/api/brain/roles/:role", (c) => {
    if (!isAuthorized(deps.secret, c.req.header("X-Siltpoke-Secret"))) {
      return c.json({ error: "unauthorized" }, 401);
    }
    const result = runBrainUnset(deps.homeBase, c.req.param("role"));
    if (!result.ok) {
      return c.json({ error: result.message }, 400);
    }
    return c.json({ ok: true, message: result.message });
  });

  // The three daily call caps, one per role — review, chat, summarizer (spec
  // §12.3; every agent counts). All three are sent together; the writer refuses a value that
  // is not a whole number of 0 or more and then writes nothing.
  app.post("/api/brain/daily-caps", async (c) => {
    if (!isAuthorized(deps.secret, c.req.header("X-Siltpoke-Secret"))) {
      return c.json({ error: "unauthorized" }, 401);
    }
    let body: { review?: unknown; chat?: unknown; extract?: unknown } | null;
    try {
      body = (await c.req.json()) as typeof body;
    } catch {
      return c.json({ error: "review, chat and extract caps required" }, 400);
    }
    const result = saveQuotaDailyCaps(deps.homeBase, {
      review: body?.review,
      chat: body?.chat,
      extract: body?.extract,
    });
    if (!result.ok) {
      return c.json({ error: result.message }, 400);
    }
    return c.json(result);
  });

  // Per-builder review override (Brain select v2) — mirrors the roles POST:
  // secret-gated, fail-closed, reuses setReviewByBuilder (one SoT with the CLI).
  app.post("/api/brain/review-by-builder/:builder", async (c) => {
    if (!isAuthorized(deps.secret, c.req.header("X-Siltpoke-Secret"))) {
      return c.json({ error: "unauthorized" }, 401);
    }
    const builder = c.req.param("builder");

    let body: { reviewer?: unknown; model?: unknown };
    try {
      body = (await c.req.json()) as { reviewer?: unknown; model?: unknown };
    } catch {
      return c.json({ error: "reviewer required" }, 400);
    }
    if (typeof body.reviewer !== "string" || body.reviewer.length === 0) {
      return c.json({ error: "reviewer required" }, 400);
    }
    const model = typeof body.model === "string" && body.model.length > 0 ? body.model : undefined;

    const result = setReviewByBuilder(deps.homeBase, builder, body.reviewer, model);
    if (!result.ok) {
      return c.json({ error: result.message }, 400);
    }
    return c.json({ ok: true, message: result.message });
  });
}
