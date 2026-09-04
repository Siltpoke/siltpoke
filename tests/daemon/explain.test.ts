/**
 * Hono daemon explain routes tests.
 *
 * Three endpoints exercised:
 *   GET /api/explain/:id           JSON, Bearer auth
 *   GET /explain/:id               SSR, same-origin
 *   GET /api/explain/:id/stream    SSE, Bearer auth (line-by-line stream of
 *                                  the finished markdown — v1 wire
 *                                  shape; first-class Brain token streaming
 *                                  is a follow-up if in-house use needs it)
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { mountExplainRoutes } from "../../src/daemon/routes/explain";
import { cacheKey, writeExplanation } from "../../src/explain/store";
import {
  EXPLANATION_SCHEMA_VERSION,
  type ExplanationMeta,
} from "../../src/explain/types";

let cwd: string;

beforeEach(() => {
  cwd = mkdtempSync(join(tmpdir(), "siltpoke-explain-daemon-"));
});

afterEach(() => {
  rmSync(cwd, { recursive: true, force: true });
});

const SECRET = "test-secret";

async function seedExplanation(opts: {
  lowConfidence?: boolean;
  markdown?: string;
} = {}) {
  const targetNodeId = "function:src/cli/doctor.ts:runDoctor";
  const key = cacheKey(targetNodeId);
  const meta: ExplanationMeta = {
    schemaVersion: EXPLANATION_SCHEMA_VERSION,
    target: "runDoctor",
    target_node_id: targetNodeId,
    target_key_sha256: key,
    graph_indexed_ts: "2026-05-27T10:00:00.000Z",
    brain_usage: {
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
      input_tokens: 1000,
      output_tokens: 300,
      total_cost_usd: 0.003,
    },
    evidence_score: opts.lowConfidence ? 0.5 : 1.0,
    low_confidence: Boolean(opts.lowConfidence),
    depth: 1,
    created_ts: "2026-05-27T10:05:00.000Z",
  };
  const md =
    opts.markdown ??
    "# runDoctor\n\nDefined in [src/cli/doctor.ts:42-87].\n\nCalls:\n- helper [src/cli/doctor.ts:10]\n";
  await writeExplanation(cwd, key, md, meta);
  return { key, meta, md };
}

function makeApp(): Hono {
  const app = new Hono();
  // homeBase is unused by these tests (project resolution is short-circuited
  // via resolveProjectRoot below so requests hit `cwd` directly, mirroring
  // the pre-per-request-resolution behavior these tests were written against).
  mountExplainRoutes(app, {
    cwd,
    homeBase: cwd,
    secret: SECRET,
    resolveProjectRoot: async () => cwd,
  });
  return app;
}

describe("GET /api/explain/:id (JSON)", () => {
  test("200 returns ExplainResult envelope", async () => {
    const { key } = await seedExplanation();
    const app = makeApp();
    const res = await app.fetch(
      new Request(`http://localhost/api/explain/${key}`, {
        headers: { Authorization: `Bearer ${SECRET}` },
      }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { success: boolean; data: unknown };
    expect(body.success).toBe(true);
    expect(body.data).toMatchObject({
      target: "runDoctor",
      target_node_id: "function:src/cli/doctor.ts:runDoctor",
      evidence_score: 1.0,
      low_confidence: false,
    });
  });

  test("401 when Authorization header missing", async () => {
    const { key } = await seedExplanation();
    const app = makeApp();
    const res = await app.fetch(
      new Request(`http://localhost/api/explain/${key}`),
    );
    expect(res.status).toBe(401);
  });

  test("401 when Bearer secret mismatches", async () => {
    const { key } = await seedExplanation();
    const app = makeApp();
    const res = await app.fetch(
      new Request(`http://localhost/api/explain/${key}`, {
        headers: { Authorization: "Bearer wrong-secret" },
      }),
    );
    expect(res.status).toBe(401);
  });

  test("404 when explanation id missing", async () => {
    const app = makeApp();
    const res = await app.fetch(
      new Request("http://localhost/api/explain/ffffffffffff", {
        headers: { Authorization: `Bearer ${SECRET}` },
      }),
    );
    expect(res.status).toBe(404);
  });

  test("400 when id does not match the 12-hex shape (F5 regex guard)", async () => {
    const app = makeApp();
    const res = await app.fetch(
      new Request("http://localhost/api/explain/...../escape", {
        headers: { Authorization: `Bearer ${SECRET}` },
      }),
    );
    expect([400, 404]).toContain(res.status);
    // With Hono, slashes in the id don't actually match — but a non-hex
    // 12-char param should be 400.
    const r2 = await app.fetch(
      new Request("http://localhost/api/explain/NOTHEXVALID1", {
        headers: { Authorization: `Bearer ${SECRET}` },
      }),
    );
    expect(r2.status).toBe(400);
    const body = (await r2.json()) as { error: string };
    expect(body.error).toBe("invalid id");
  });
});

describe("GET /explain/:id (SSR)", () => {
  test("200 + body contains H1 target name", async () => {
    const { key } = await seedExplanation();
    const app = makeApp();
    const res = await app.fetch(new Request(`http://localhost/explain/${key}`));
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("runDoctor");
  });

  test("low_confidence renders banner", async () => {
    const { key } = await seedExplanation({ lowConfidence: true });
    const app = makeApp();
    const res = await app.fetch(new Request(`http://localhost/explain/${key}`));
    const html = await res.text();
    expect(html.toLowerCase()).toMatch(/low.confidence|⚠/);
  });

  test("404 when explanation id missing", async () => {
    const app = makeApp();
    const res = await app.fetch(
      new Request("http://localhost/explain/ffffffffffff"),
    );
    expect(res.status).toBe(404);
  });
});

describe("GET /explain (list page)", () => {
  test("empty dir shows empty-state copy", async () => {
    const app = makeApp();
    const res = await app.fetch(new Request("http://localhost/explain"));
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("No explanations yet");
    expect(html).toContain("/siltpoke-explain");
  });

  test("populated dir lists entries newest first", async () => {
    await seedExplanation();
    const targetNodeId2 = "function:src/cli/doctor.ts:helper";
    const key2 = cacheKey(targetNodeId2);
    const meta2: ExplanationMeta = {
      schemaVersion: EXPLANATION_SCHEMA_VERSION,
      target: "helper",
      target_node_id: targetNodeId2,
      target_key_sha256: key2,
      graph_indexed_ts: "2026-05-27T10:00:00.000Z",
      brain_usage: {
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
        input_tokens: 100,
        output_tokens: 50,
        total_cost_usd: 0.001,
      },
      evidence_score: 1,
      low_confidence: false,
      depth: 1,
      created_ts: "2026-05-27T11:00:00.000Z", // newer
    };
    await writeExplanation(cwd, key2, "# helper\n", meta2);

    const app = makeApp();
    const res = await app.fetch(new Request("http://localhost/explain"));
    const html = await res.text();
    expect(html).toContain("runDoctor");
    expect(html).toContain("helper");
    // newer entry (helper, created 11:00) appears before runDoctor (10:05)
    expect(html.indexOf("helper")).toBeLessThan(html.indexOf("runDoctor"));
    expect(html).toContain("2 explanations cached");
  });

  test("low_confidence entry gets ⚠ marker in list", async () => {
    await seedExplanation({ lowConfidence: true });
    const app = makeApp();
    const res = await app.fetch(new Request("http://localhost/explain"));
    const html = await res.text();
    expect(html).toContain("⚠");
  });
});

describe("GET /api/explain/:id/stream (SSE)", () => {
  test("emits text/event-stream content-type and Bearer-auths", async () => {
    const { key } = await seedExplanation();
    const app = makeApp();
    const res = await app.fetch(
      new Request(`http://localhost/api/explain/${key}/stream`, {
        headers: { Authorization: `Bearer ${SECRET}` },
      }),
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type") ?? "").toMatch(/text\/event-stream/);
  });

  test("401 when Bearer secret mismatches", async () => {
    const { key } = await seedExplanation();
    const app = makeApp();
    const res = await app.fetch(
      new Request(`http://localhost/api/explain/${key}/stream`, {
        headers: { Authorization: "Bearer wrong" },
      }),
    );
    expect(res.status).toBe(401);
  });

  test("404 when explanation id missing", async () => {
    const app = makeApp();
    const res = await app.fetch(
      new Request("http://localhost/api/explain/ffffffffffff/stream", {
        headers: { Authorization: `Bearer ${SECRET}` },
      }),
    );
    expect(res.status).toBe(404);
  });

  test("stream body contains token events + final done event", async () => {
    const { key } = await seedExplanation({
      markdown: "line one\nline two\nline three\n",
    });
    const app = makeApp();
    const res = await app.fetch(
      new Request(`http://localhost/api/explain/${key}/stream`, {
        headers: { Authorization: `Bearer ${SECRET}` },
      }),
    );
    const body = await res.text();
    expect(body).toContain("event: token");
    expect(body).toContain("line one");
    expect(body).toContain("event: done");
  });
});
