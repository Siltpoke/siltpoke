// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
// Copyright (c) 2026 Jiaqi Duan
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { mountExplainRoutes } from "../../../src/daemon/routes/explain";
import { cacheKey, writeExplanation } from "../../../src/explain/store";
import { EXPLANATION_SCHEMA_VERSION, type ExplanationMeta } from "../../../src/explain/types";

let dirs: string[] = [];
afterEach(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
  dirs = [];
});

function makeMeta(targetNodeId: string, key: string): ExplanationMeta {
  return {
    schemaVersion: EXPLANATION_SCHEMA_VERSION,
    target: "scoped-explanation-target",
    target_node_id: targetNodeId,
    target_key_sha256: key,
    graph_indexed_ts: "2026-07-16T00:00:00.000Z",
    brain_usage: {
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
      input_tokens: 0,
      output_tokens: 0,
      total_cost_usd: 0,
    },
    evidence_score: 1,
    low_confidence: false,
    depth: 1,
    created_ts: "2026-07-16T00:00:00.000Z",
  };
}

describe("explain routes resolve project per request (not frozen cwd)", () => {
  test("GET /api/explain/:id reads the resolved project's explanation while process.cwd() is /", async () => {
    const home = mkdtempSync(join(tmpdir(), "siltpoke-exp-home-"));
    dirs.push(home);
    const projectRoot = mkdtempSync(join(tmpdir(), "siltpoke-exp-proj-"));
    dirs.push(projectRoot);

    const targetNodeId = "some/file.ts#someFunction";
    const key = cacheKey(targetNodeId);
    await writeExplanation(
      projectRoot,
      key,
      "scoped-explanation-markdown-body",
      makeMeta(targetNodeId, key),
    );

    const realCwd = process.cwd();
    process.chdir("/");
    try {
      const app = new Hono();
      mountExplainRoutes(app, {
        homeBase: home,
        cwd: process.cwd(),
        secret: "",
        resolveProjectRoot: async () => projectRoot,
      });

      const res = await app.request(`/api/explain/${key}`);
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.success).toBe(true);
      expect(body.data.target).toBe("scoped-explanation-target");
      expect(body.data.target_node_id).toBe(targetNodeId);
    } finally {
      process.chdir(realCwd);
    }
  });

  test("GET /explain lists the resolved project's explanations while process.cwd() is /", async () => {
    const home = mkdtempSync(join(tmpdir(), "siltpoke-exp-home-"));
    dirs.push(home);
    const projectRoot = mkdtempSync(join(tmpdir(), "siltpoke-exp-proj-"));
    dirs.push(projectRoot);

    const targetNodeId = "some/other-file.ts#otherFunction";
    const key = cacheKey(targetNodeId);
    await writeExplanation(
      projectRoot,
      key,
      "another-scoped-body",
      makeMeta(targetNodeId, key),
    );

    const realCwd = process.cwd();
    process.chdir("/");
    try {
      const app = new Hono();
      mountExplainRoutes(app, {
        homeBase: home,
        cwd: process.cwd(),
        secret: "",
        resolveProjectRoot: async () => projectRoot,
      });

      const res = await app.request("/explain");
      expect(res.status).toBe(200);
      const html = await res.text();
      expect(html).toContain("scoped-explanation-target");
    } finally {
      process.chdir(realCwd);
    }
  });
});
