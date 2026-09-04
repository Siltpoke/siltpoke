// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
// Copyright (c) 2026 Jiaqi Duan
/**
 * Feedback route.
 *
 * POST /api/critiques/:id/feedback
 *   Body: { text: string }
 *   Response 200: { ok: true }
 *   Response 400: { error: "text required" }
 *   Response 401: { error: "unauthorized" }
 *
 * Appends a preference-log entry with signal="feedback".
 * Auth: secret-gated via X-Siltpoke-Secret (daemon-hardening security audit,
 * finding 3 — residual gap). There is no network-level secret enforcement in
 * this daemon; every state-changing POST must gate for itself. Fail CLOSED —
 * no configured secret ⇒ reject (isAuthorized("", …) is false).
 */
import type { Hono } from "hono";
import { appendPreferenceEntry } from "../../preference-log/writer";
import { isAuthorized } from "../auth";

export interface FeedbackRouteDeps {
  /** Override preference-log path (for test isolation). */
  logPath?: string;
  /** Daemon shared secret — required to authorize this POST. */
  secret?: string;
}

export function mountFeedbackRoutes(app: Hono, deps: FeedbackRouteDeps = {}): void {
  app.post("/api/critiques/:id/feedback", async (c) => {
    if (!isAuthorized(deps.secret ?? "", c.req.header("X-Siltpoke-Secret"))) {
      return c.json({ error: "unauthorized" }, 401);
    }
    const id = c.req.param("id");

    let body: { text?: string };
    try {
      body = (await c.req.json()) as { text?: string };
    } catch {
      return c.json({ error: "text required" }, 400);
    }

    if (!body.text || body.text.trim() === "") {
      return c.json({ error: "text required" }, 400);
    }

    await appendPreferenceEntry(
      {
        critique_id: id,
        signal: "feedback",
        reason_text: body.text,
        critique_snapshot: { critique_id: id },
        diff_snapshot_sha: null,
        intent_at_critique: null,
        reflexion_rule_fired: null,
      },
      deps.logPath ? { path: deps.logPath } : {},
    );

    return c.json({ ok: true });
  });
}
