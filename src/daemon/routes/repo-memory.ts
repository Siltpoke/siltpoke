// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
// Copyright (c) 2026 Jiaqi Duan
/**
 * GET  /api/repo-memory        — repo-memory index summary
 * POST /api/repo-memory/build  — trigger index build; redirect to /repo-memory
 */
import type { Hono } from "hono";
import { siltpokeRoot } from "../../installer/paths";
import { loadIndex, buildRepoMemoryIndex } from "../../repo-memory/index-builder";
import { isAuthorized } from "../auth";
import { resolveRequestProject } from "../project-context";
import { isWriteEligible, type DaemonProject } from "../../memory/active-project";

export interface RepoMemoryApiRouteDeps {
  /**
   * Daemon secret — gates POST /api/repo-memory/build (triggers a
   * potentially-expensive repo scan/rebuild). Absent → fails CLOSED (401).
   * See the daemon-hardening security audit, finding 2. The screen's
   * `<form action="/api/repo-memory/build">` reaches this via the
   * hx-boost + body-level hx-headers cascade set up in Layout.tsx — no
   * per-form change needed (see RepoMemoryWebRouteDeps).
   */
  secret?: string;
  /**
   * Daemon home (~/.siltpoke by default) — the base the per-request project
   * resolver reads its pin/registry from. The daemon runs detached under
   * launchd (process.cwd() === "/"), so the build handler must resolve the
   * target project from here, never from cwd. See the "destructive empty
   * overwrite" fix: a build scoped to "/" scans `/src/**`, finds nothing,
   * and overwrites the real index with an empty one.
   */
  homeBase?: string;
  /** Injectable seam for `resolveRequestProject` (tests only). */
  resolveProject?: (
    home: string,
    explicitProjHash: string | undefined,
  ) => Promise<DaemonProject>;
  /** Injectable seam for `buildRepoMemoryIndex` (tests only). */
  buildIndex?: typeof buildRepoMemoryIndex;
}

export function mountRepoMemoryApiRoutes(app: Hono, deps: RepoMemoryApiRouteDeps = {}): void {
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
    // Secret-gate — triggers a repo scan/rebuild; an unauthenticated
    // cross-origin POST (blind CSRF, hx-boosted form or plain fetch) could
    // otherwise trigger this for free. Fail CLOSED. See finding 2.
    if (!isAuthorized(deps.secret ?? "", c.req.header("X-Siltpoke-Secret"))) {
      return c.json({ success: false, error: "unauthorized" }, 401);
    }
    const home = deps.homeBase ?? siltpokeRoot();
    const proj = deps.resolveProject
      ? await deps.resolveProject(home, c.req.query("repo") ?? undefined)
      : await resolveRequestProject(home, c.req.query("repo") ?? undefined);
    // Writes may only target an intentional selection (explicit ?repo= or the
    // sticky pin) — never a recency guess ("recent") or a dead resolution
    // ("stale"/"none"). A guessed target here would silently overwrite the
    // wrong project's index. See finding: destructive empty overwrite.
    if (!proj.project_root || !isWriteEligible(proj.source)) {
      return c.json(
        { success: false, error: "no project selected — open a repo first (?repo=<hash>)" },
        400,
      );
    }
    try {
      const index = await (deps.buildIndex ?? buildRepoMemoryIndex)({
        cwd: proj.project_root,
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
