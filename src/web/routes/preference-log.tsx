// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
// Copyright (c) 2026 Jiaqi Duan
/** @jsxImportSource hono/jsx */
/**
 * /preference-log SSR route.
 */
import type { Hono } from "hono";
import { Layout } from "../_shared/layout";
import { PreferenceLogScreen } from "../screens/PreferenceLogScreen";
import { readPreferenceLog, countBySignal } from "../../preference-log/reader";

export function mountPreferenceLogRoutes(app: Hono): void {
  app.get("/preference-log", async (c) => {
    const [rawEntries, counts] = await Promise.all([
      readPreferenceLog({ limit: 50 }),
      countBySignal(),
    ]);
    // Most-recent first
    const entries = [...rawEntries].reverse();
    return c.html(
      <Layout title="preference log · siltpoke">
        <PreferenceLogScreen entries={entries} counts={counts} />
      </Layout>,
    );
  });
}
