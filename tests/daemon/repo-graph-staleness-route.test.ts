// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
// Copyright (c) 2026 Jiaqi Duan
/**
 * Task 4 (index-staleness-surfacing slice ②) — dashboard staleness endpoint:
 *
 *   GET /api/repo-graph/staleness?repo=<projHash> → { success, data: StalenessVerdict }
 *
 * Deliberately NO mocking of readIndexStaleness — every fixture builds a
 * real index via runIndexBuild, edits real files on disk, and asserts on the
 * REAL fingerprint re-hash + verdict math. This is the same real-fixture
 * discipline as staleness-verdict / index-health's own tests (Tasks 1-3);
 * mocking the staleness computation here would only prove the route calls a
 * function, never that the wiring (proj-hash lookup, project_root
 * resolution, config load) actually lines up end to end.
 */
import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { mountRepoGraphRoutes } from "../../src/daemon/routes/repo-graph";
import { runIndexBuild } from "../../src/repo-graph/builder";
import { computeProjHash } from "../../src/repo-graph/proj-hash";

/** Seed `n` indexed files, build the real index, then edit exactly one of
 *  them so `content_changed === 1` — the caller picks `n` to land on either
 *  side of the default 20% stale threshold (1/5 = stale, 1/6 = drifting). */
async function seedAndDrift(home: string, repo: string, n: number): Promise<void> {
  mkdirSync(join(repo, "src"), { recursive: true });
  const names = Array.from({ length: n }, (_, i) => `f${i}`);
  for (const name of names) {
    writeFileSync(join(repo, "src", `${name}.ts`), `export const ${name}=1;\n`);
  }
  await runIndexBuild({ cwd: repo, force: true, home });
  // Edit exactly one file's content AFTER the build so its fingerprint no
  // longer matches — this is what content_changed counts.
  writeFileSync(join(repo, "src", `${names[0]}.ts`), `export const ${names[0]}=999;\n`);
}

describe("GET /api/repo-graph/staleness", () => {
  test("real stale repo (1/5 = 20%) → level stale, content_changed 1", async () => {
    const home = mkdtempSync(join(tmpdir(), "sp-home-"));
    const repo = mkdtempSync(join(tmpdir(), "sp-repo-"));
    await seedAndDrift(home, repo, 5);

    const app = new Hono();
    mountRepoGraphRoutes(app, { cwd: repo, home });
    const res = await app.request(`/api/repo-graph/staleness?repo=${computeProjHash(repo)}`);
    const body = (await res.json()) as {
      success: boolean;
      data: { level: string; counts: { content_changed: number } };
    };
    expect(res.status).toBe(200);
    expect(body.success).toBe(true);
    expect(body.data.level).toBe("stale");
    expect(body.data.counts.content_changed).toBe(1);
  });

  test("real drifting repo (1/6 ≈ 16.7%) → level drifting", async () => {
    const home = mkdtempSync(join(tmpdir(), "sp-home-"));
    const repo = mkdtempSync(join(tmpdir(), "sp-repo-"));
    await seedAndDrift(home, repo, 6);

    const app = new Hono();
    mountRepoGraphRoutes(app, { cwd: repo, home });
    const res = await app.request(`/api/repo-graph/staleness?repo=${computeProjHash(repo)}`);
    const body = (await res.json()) as { success: boolean; data: { level: string } };
    expect(res.status).toBe(200);
    expect(body.data.level).toBe("drifting");
  });

  test("missing ?repo= → 400 bad_repo", async () => {
    const home = mkdtempSync(join(tmpdir(), "sp-home-"));
    const repo = mkdtempSync(join(tmpdir(), "sp-repo-"));
    const app = new Hono();
    mountRepoGraphRoutes(app, { cwd: repo, home });
    const res = await app.request("/api/repo-graph/staleness");
    const body = (await res.json()) as { success: boolean; data: null; error: string };
    expect(res.status).toBe(400);
    expect(body.success).toBe(false);
    expect(body.data).toBeNull();
    expect(body.error).toBe("bad_repo");
  });

  test("malformed ?repo= (fails proj-hash shape) → 400 bad_repo", async () => {
    const home = mkdtempSync(join(tmpdir(), "sp-home-"));
    const repo = mkdtempSync(join(tmpdir(), "sp-repo-"));
    const app = new Hono();
    mountRepoGraphRoutes(app, { cwd: repo, home });
    const res = await app.request("/api/repo-graph/staleness?repo=not-a-hash");
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("bad_repo");
  });

  test("valid-shaped but unknown repo hash → 400 unknown_repo", async () => {
    const home = mkdtempSync(join(tmpdir(), "sp-home-"));
    const repo = mkdtempSync(join(tmpdir(), "sp-repo-"));
    const app = new Hono();
    mountRepoGraphRoutes(app, { cwd: repo, home });
    const res = await app.request("/api/repo-graph/staleness?repo=aaaaaaaaaaaa");
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("unknown_repo");
  });
});
