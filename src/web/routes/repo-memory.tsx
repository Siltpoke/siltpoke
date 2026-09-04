// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
// Copyright (c) 2026 Jiaqi Duan
/** @jsxImportSource hono/jsx */
/**
 * /repo-memory SSR route.
 */
import type { Hono } from "hono";
import { Layout } from "../_shared/layout";
import { RepoMemoryScreen } from "../screens/RepoMemoryScreen";
import { loadIndex } from "../../repo-memory/index-builder";
import { resolveRequestProject } from "../../daemon/project-context";

export interface RepoMemoryWebRouteDeps {
  /**
   * Daemon secret — forwarded to `<Layout secret>`, which sets `hx-headers`
   * on `<body>`. `hx-boost="true"` (also on body) intercepts the screen's
   * plain `<form method="post" action="/api/repo-memory/build">` and
   * reissues it as an htmx request, so it inherits `hx-headers` — no
   * per-form change needed. Powers the newly-gated
   * `POST /api/repo-memory/build` (finding 2).
   */
  secret?: string;
  /**
   * Daemon home — resolves the page's proj_hash (?repo= > sticky pin > most
   * recently active) so it can be baked into the build form's `action` URL
   * as `?repo=` (a hidden `<input>` would land in the POST body, not the
   * query string the API route reads). Without this, the build POST would
   * have no `?repo=` to hand the API route's explicit-only write guard, and
   * the build would 400.
   */
  homeBase?: string;
  /** Injectable seam for `resolveRequestProject` (tests only). */
  resolveProject?: typeof resolveRequestProject;
}

export function mountRepoMemoryRoutes(app: Hono, deps: RepoMemoryWebRouteDeps = {}): void {
  app.get("/repo-memory", async (c) => {
    const index = await loadIndex();
    const resolve = deps.resolveProject ?? resolveRequestProject;
    const proj = deps.homeBase
      ? await resolve(deps.homeBase, c.req.query("repo") ?? undefined)
      : null;
    return c.html(
      <Layout title="repo memory · siltpoke" secret={deps.secret}>
        <RepoMemoryScreen index={index} projHash={proj?.proj_hash ?? null} />
      </Layout>,
    );
  });
}
