/**
 * Smoke tests for critique permalink routes
 *
 * GET /api/critiques/:id  → 401 without auth, 404 for unknown id, 200 for known
 * GET /critique/:id       → 404 HTML for unknown id, 200 HTML for known
 */
import { describe, test, expect, beforeEach } from "bun:test";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { Hono } from "hono";
import { mountCritiqueRoutes } from "../../src/daemon/routes/critique.tsx";

const CRITIQUE_MD = `---
schemaVersion: 1
timestamp: 2026-05-20T12:00:00.000Z
critique_id: c-test
session_id: sess-abc
cwd: /home/user/project
mood: neutral
pose: sit
severity: high
confidence: high
status: pending
---

# [SILTPOKE CRITIQUE]

## Bubble (user-facing)

Missing await on async call.

## Critique (for Claude, if forwarded)

\`\`\`
Move the await to the call site.
\`\`\`

## Severity / Confidence

severity: high
confidence: high
`;

let homeBase: string;
const SECRET = "test-secret-abc";

beforeEach(async () => {
  homeBase = join(tmpdir(), `critique-route-test-${randomUUID()}`);
  const archiveDir = join(homeBase, "critiques", "archive", "2026-05-20");
  await mkdir(archiveDir, { recursive: true });
  await writeFile(join(archiveDir, "c-test.md"), CRITIQUE_MD, "utf8");
});

function buildApp(): Hono {
  const app = new Hono();
  mountCritiqueRoutes(app, { homeBase, secret: SECRET });
  return app;
}

describe("GET /api/critiques/:id", () => {
  test("returns 401 without auth when secret is set", async () => {
    const app = buildApp();
    const res = await app.request("/api/critiques/c-test");
    expect(res.status).toBe(401);
  });

  test("returns 404 for unknown id with valid auth", async () => {
    const app = buildApp();
    const res = await app.request("/api/critiques/c-unknown", {
      headers: { Authorization: `Bearer ${SECRET}` },
    });
    expect(res.status).toBe(404);
  });

  test("returns 200 JSON for known id with valid auth", async () => {
    const app = buildApp();
    const res = await app.request("/api/critiques/c-test", {
      headers: { Authorization: `Bearer ${SECRET}` },
    });
    expect(res.status).toBe(200);
    const json = (await res.json()) as {
      success: boolean;
      data: { critique: { id: string }; trace_ids: string[] };
    };
    expect(json.success).toBe(true);
    expect(json.data.critique.id).toBe("c-test");
    expect(Array.isArray(json.data.trace_ids)).toBe(true);
  });

  test("JSON includes severity from frontmatter", async () => {
    const app = buildApp();
    const res = await app.request("/api/critiques/c-test", {
      headers: { Authorization: `Bearer ${SECRET}` },
    });
    const json = (await res.json()) as { data: { critique: { severity: string } } };
    expect(json.data.critique.severity).toBe("high");
  });
});

describe("GET /critique/:id", () => {
  test("returns 404 HTML for unknown critique", async () => {
    const app = buildApp();
    const res = await app.request("/critique/c-missing");
    expect(res.status).toBe(404);
    const body = await res.text();
    expect(body).toContain("c-missing");
  });

  test("returns 200 HTML for known critique", async () => {
    const app = buildApp();
    const res = await app.request("/critique/c-test");
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain("c-test");
  });

  test("rendered page contains critique_for_claude body", async () => {
    const app = buildApp();
    const res = await app.request("/critique/c-test");
    const body = await res.text();
    expect(body).toContain("Move the await to the call site");
  });

  test("rendered page contains severity from frontmatter", async () => {
    const app = buildApp();
    const res = await app.request("/critique/c-test");
    const body = await res.text();
    expect(body).toContain("high");
  });
});
