// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
// Copyright (c) 2026 Jiaqi Duan
/** @jsxImportSource hono/jsx */
/**
 * /settings route — the dashboard review-brain selector (Slice C / Task 8).
 *
 * Reads the resolved brain view per-request (so a POST /api/brain/roles/:role
 * is reflected on the next GET without a daemon restart) and SSRs the Settings
 * screen. The screen's Save island posts to the secret-gated brain route.
 */
import type { Hono } from "hono";
import { brainView } from "../../cli/brain-cli";
import { Layout } from "../_shared/layout";
import { SettingsScreen } from "../screens/Settings";

export interface SettingsRouteDeps {
  homeBase: string;
  secret: string;
}

export function mountSettingsRoutes(app: Hono, deps: SettingsRouteDeps): void {
  app.get("/settings", (c) => {
    const view = brainView(deps.homeBase);
    return c.html(
      <Layout title="Settings · siltpoke" secret={deps.secret}>
        <SettingsScreen view={view} secret={deps.secret} />
      </Layout>,
    );
  });
}
