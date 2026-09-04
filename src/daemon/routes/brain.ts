// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
// Copyright (c) 2026 Jiaqi Duan
/**
 * Brain-select route — the dashboard half of the model-select surface
 * (Slice C / Task 8).
 *
 *   GET  /api/brain               -> { authorFamily, roles[], families[] }
 *   POST /api/brain/roles/:role   -> { family, model? }  (secret-gated)
 *
 * The POST calls the SAME `runBrainSet` the `/siltpoke-brain` command calls, so
 * the dashboard settings screen and the command write one `brain.roles.<role>`
 * source of truth — there is no second config path. Reviews pick the change up
 * on their next run; nothing here touches a running review.
 *
 * Auth mirrors the feedback route: every state-changing POST gates for itself
 * via X-Siltpoke-Secret and fails CLOSED (no configured secret ⇒ reject). The
 * GET is a read and is not secret-gated, matching the other dashboard reads.
 */
import type { Hono } from "hono";
import { brainView, runBrainSet, setReviewByBuilder } from "../../cli/brain-cli";
import { isAuthorized } from "../auth";

export interface BrainRouteDeps {
  /** The Siltpoke home whose config.json holds brain.roles. */
  homeBase: string;
  /** Daemon shared secret — required to authorize the POST. */
  secret: string;
}

export function mountBrainRoutes(app: Hono, deps: BrainRouteDeps): void {
  app.get("/api/brain", (c) => {
    return c.json(brainView(deps.homeBase));
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
