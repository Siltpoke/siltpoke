// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
// Copyright (c) 2026 Jiaqi Duan
/**
 * Feedback route.
 *
 * POST /api/critiques/:id/feedback
 *   Body: { text: string }
 *   Response 200: { ok: true }
 *   Response 400: { error: "text required" }
 *
 * Appends a preference-log entry with signal="feedback".
 * Auth: no additional auth beyond the shared secret already enforced by the
 * daemon at the network level. The route mirrors the pattern used by
 * /api/critiques/:id (critique.tsx) — same-origin trust model.
 */
import type { Hono } from "hono";
import { appendPreferenceEntry } from "../../preference-log/writer";

export interface FeedbackRouteDeps {
  /** Override preference-log path (for test isolation). */
  logPath?: string;
}

export function mountFeedbackRoutes(app: Hono, deps: FeedbackRouteDeps = {}): void {
  app.post("/api/critiques/:id/feedback", async (c) => {
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
