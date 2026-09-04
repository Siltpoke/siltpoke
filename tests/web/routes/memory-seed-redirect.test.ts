// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
// Copyright (c) 2026 Jiaqi Duan
/**
 * One-time canonical `?repo=` seed redirect on GET /memory (Task 12).
 *
 * A fresh landing (no `?repo=`) that resolves a project (sticky pin, in this
 * fixture) is promoted to the explicit URL via a single 302 — so the pick is
 * shareable/bookmarkable and survives a reload without re-guessing. The loop
 * guard: a request that already carries `?repo=` must never redirect again,
 * even when it resolves the exact same project.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { Hono } from "hono";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mountMemoryRoutes } from "../../../src/web/routes/memory";
import { emptyProject, writeProject, resolveProjectRoot } from "../../../src/memory/project";
import { writeProjectPin } from "../../../src/state/project-pin";
import { writeGlobal, emptyGlobal } from "../../../src/memory/global";
import { computeProjHash } from "../../../src/repo-graph/proj-hash";

let dirs: string[] = [];
afterEach(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
  dirs = [];
});

async function makeApp(): Promise<{ app: Hono; projHash: string }> {
  const home = mkdtempSync(join(tmpdir(), "siltpoke-seed-redirect-home-"));
  dirs.push(home);
  const projectRoot = mkdtempSync(join(tmpdir(), "siltpoke-seed-redirect-proj-"));
  dirs.push(projectRoot);

  await writeGlobal(home, emptyGlobal());
  const resolved = resolveProjectRoot(projectRoot);
  await writeProject(home, resolved.project_id, emptyProject(resolved));

  const projHash = computeProjHash(projectRoot);
  await writeProjectPin(home, projHash);

  const app = new Hono();
  mountMemoryRoutes(app, { homeBase: home, secret: "" });
  return { app, projHash };
}

describe("GET /memory — one-time canonical ?repo= seed redirect", () => {
  test("bare landing with a pinned project 302s to ?repo=<hash>", async () => {
    const { app, projHash } = await makeApp();
    const res = await app.request("/memory");
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe(`/memory?repo=${projHash}`);
  });

  test("a request that already carries ?repo= is NOT redirected (loop guard)", async () => {
    const { app, projHash } = await makeApp();
    const res = await app.request(`/memory?repo=${projHash}`);
    expect(res.status).toBe(200);
  });
});
