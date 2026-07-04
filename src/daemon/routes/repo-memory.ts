// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
// Copyright (c) 2026 Jiaqi Duan
/**
 * GET  /api/repo-memory        — repo-memory index summary
 * POST /api/repo-memory/build  — trigger index build; redirect to /repo-memory
 */
import type { Hono } from "hono";
import { loadIndex, buildRepoMemoryIndex } from "../../repo-memory/index-builder";

export function mountRepoMemoryApiRoutes(app: Hono): void {
  app.get("/api/repo-memory", async (c) => {
    const index = await loadIndex();
    if (!index) {
      return c.json({ success: true, data: null });
    }
    return c.json({
      success: true,
      data: {
        filesIndexed: index.files.length,
        conventions: index.conventions,
        builtAt: index.built_at,
      },
    });
  });

  app.post("/api/repo-memory/build", async (c) => {
    const cwd = process.cwd();
    try {
      const index = await buildRepoMemoryIndex({
        cwd,
        pattern: "src/**/*.{ts,tsx,js,jsx}",
      });
      // If request wants JSON (e.g. API client), return JSON.
      const accept = c.req.header("accept") ?? "";
      if (accept.includes("application/json")) {
        return c.json({
          success: true,
          data: {
            ok: true,
            filesIndexed: index.files.length,
            conventions: index.conventions,
          },
        });
      }
      // Browser form POST: redirect back to the page.
      return c.redirect("/repo-memory", 303);
    } catch (err) {
      const accept = c.req.header("accept") ?? "";
      if (accept.includes("application/json")) {
        return c.json(
          {
            success: false,
            error: err instanceof Error ? err.message : String(err),
          },
          500,
        );
      }
      return c.redirect("/repo-memory", 303);
    }
  });
}
