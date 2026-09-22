// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
// Copyright (c) 2026 Jiaqi Duan
/** The client menu renders `name` from GET /api/repo-graph/repos verbatim. */
import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { mountRepoGraphRoutes } from "../../src/daemon/routes/repo-graph";
import { emptyCounters } from "../../src/repo-graph/types";

let home: string;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "sp-repos-label-"));
});
afterEach(() => rmSync(home, { recursive: true, force: true }));

function seed(hash: string, project_root: string, repo_root?: string): void {
  const dir = join(home, "repo-memory", hash);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "meta.json"), JSON.stringify({
    schemaVersion: 1, project_root, proj_hash: hash, last_indexed_ts: "2026-09-14T00:00:00.000Z",
    build_duration_ms: 0, counters: emptyCounters(), ...(repo_root ? { repo_root } : {}),
  }));
}

test("repos list names a sub-folder index `repo / sub` and a repo by its folder name", async () => {
  seed("c3c3c3c3c3c3", "/projects/kata/TypeScript", "/projects/kata");
  seed("d4d4d4d4d4d4", "/projects/kata");
  const app = new Hono();
  mountRepoGraphRoutes(app, { cwd: home, home });
  const body = (await (await app.request("/api/repo-graph/repos")).json()) as { data: { repos: Array<{ id: string; name: string }> } };
  const byId = Object.fromEntries(body.data.repos.map((r) => [r.id, r.name]));
  expect(byId).toEqual({ c3c3c3c3c3c3: "kata / TypeScript", d4d4d4d4d4d4: "kata" });
});
