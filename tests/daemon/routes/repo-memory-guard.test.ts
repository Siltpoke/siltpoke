// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
// Copyright (c) 2026 Jiaqi Duan
import { describe, expect, test } from "bun:test";
import { Hono } from "hono";
import { mountRepoMemoryApiRoutes } from "../../../src/daemon/routes/repo-memory";

const SECRET = "test-secret";

describe("POST /api/repo-memory/build — explicit-only guard + scoped scan", () => {
  test("rejects (400) when no explicit/sticky project resolves", async () => {
    const app = new Hono();
    mountRepoMemoryApiRoutes(app, {
      secret: SECRET,
      homeBase: "/fake",
      resolveProject: async () => ({ project_root: null, source: "none" }),
    } as any);

    const res = await app.request("/api/repo-memory/build", {
      method: "POST",
      headers: { "X-Siltpoke-Secret": SECRET },
    });

    expect(res.status).toBe(400);
    expect(await res.text()).toContain("no project");
  });

  test("rejects (400) when resolution is only a recency guess (source: recent)", async () => {
    const app = new Hono();
    mountRepoMemoryApiRoutes(app, {
      secret: SECRET,
      homeBase: "/fake",
      resolveProject: async () => ({ project_root: "/some/recent/root", source: "recent" }),
    } as any);

    const res = await app.request("/api/repo-memory/build", {
      method: "POST",
      headers: { "X-Siltpoke-Secret": SECRET },
    });

    expect(res.status).toBe(400);
    expect(await res.text()).toContain("no project");
  });

  test("scans the resolved project root, not process.cwd()/'/', when source is explicit", async () => {
    let scannedCwd = "";
    const app = new Hono();
    mountRepoMemoryApiRoutes(app, {
      secret: SECRET,
      homeBase: "/fake",
      resolveProject: async () => ({ project_root: "/resolved/root", source: "explicit" }),
      buildIndex: async ({ cwd }: { cwd: string }) => {
        scannedCwd = cwd;
        return { files: [], conventions: [], built_at: new Date().toISOString() } as any;
      },
    } as any);

    const res = await app.request("/api/repo-memory/build?repo=abcdef012345", {
      method: "POST",
      headers: { "X-Siltpoke-Secret": SECRET },
    });

    expect(scannedCwd).toBe("/resolved/root");
    expect(res.status).toBe(303);
  });

  test("401s when the secret header is missing or wrong (resolveProject never called)", async () => {
    let called = false;
    const app = new Hono();
    mountRepoMemoryApiRoutes(app, {
      secret: SECRET,
      homeBase: "/fake",
      resolveProject: async () => {
        called = true;
        return { project_root: "/resolved/root", source: "explicit" };
      },
    } as any);

    const res = await app.request("/api/repo-memory/build", { method: "POST" });

    expect(res.status).toBe(401);
    expect(called).toBe(false);
  });
});
