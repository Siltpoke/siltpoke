// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
// Copyright (c) 2026 Jiaqi Duan
/**
 * Tests for POST /api/critique/:critique_id/feedback (src/web/routes/critic.tsx).
 *
 * Not to be confused with POST /api/critiques/:id/feedback (plural, daemon
 * /routes/feedback.ts) — a separate, older route with no live caller. This
 * one backs FeedbackSection (src/web/screens/critic/feedback-section.tsx),
 * appending to ~/.siltpoke/critique-feedback.jsonl.
 */
import { describe, test, expect, beforeEach } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { Hono } from "hono";

import { mountCriticRoutes } from "../../src/web/routes/critic";
import { feedbackPath } from "../../src/state/critique-feedback";

let homeBase: string;

// POST /api/critique/:critique_id/feedback is secret-gated (daemon-hardening
// security audit, finding 3 — residual gap). Every request below now
// carries this header — see `authHeaders()`.
const TEST_SECRET = "test-secret";

beforeEach(async () => {
  homeBase = join(tmpdir(), `critique-feedback-route-test-${randomUUID()}`);
  await mkdir(homeBase, { recursive: true });
});

function buildApp(): Hono {
  const app = new Hono();
  mountCriticRoutes(app, { homeBase, secret: TEST_SECRET });
  return app;
}

function authHeaders(): Record<string, string> {
  return { "content-type": "application/json", "X-Siltpoke-Secret": TEST_SECRET };
}

describe("POST /api/critique/:critique_id/feedback", () => {
  test("with the correct secret → 200, appends to critique-feedback.jsonl", async () => {
    const app = buildApp();
    const res = await app.request("/api/critique/cq-1/feedback", {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ text: "useful catch" }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean };
    expect(body.ok).toBe(true);
    expect(existsSync(feedbackPath(homeBase))).toBe(true);
  });

  // daemon-hardening security audit, finding 3 (residual gap) — a blind
  // cross-origin POST could otherwise append an arbitrary feedback entry.
  test("without the secret → 401, no critique-feedback.jsonl write", async () => {
    const app = buildApp();
    const res = await app.request("/api/critique/cq-2/feedback", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: "should never be logged" }),
    });
    expect(res.status).toBe(401);
    expect(existsSync(feedbackPath(homeBase))).toBe(false);
  });

  test("GET history remains unauthenticated (read-only)", async () => {
    const app = buildApp();
    const res = await app.request("/api/critique/cq-3/feedback");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { history: unknown[] };
    expect(body.history).toEqual([]);
  });
});
