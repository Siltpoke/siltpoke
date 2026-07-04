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

export function mountRepoMemoryRoutes(app: Hono): void {
  app.get("/repo-memory", async (c) => {
    const index = await loadIndex();
    return c.html(
      <Layout title="repo memory · siltpoke">
        <RepoMemoryScreen index={index} />
      </Layout>,
    );
  });
}
