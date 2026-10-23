// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
// Copyright (c) 2026 Jiaqi Duan
/** @jsxImportSource hono/jsx */
/**
 * /settings route — the Agents page.
 *
 * Reads the resolved brain view, the caps and the last recorded calls per
 * request (so a POST /api/brain/roles/:role, or a call that just ran, shows on
 * the next GET without a daemon restart) and SSRs the Settings screen.
 */
import type { Hono } from "hono";
import { type ChatRunStore, localRunStore } from "../../chat/run-store";
import { brainView } from "../../cli/brain-cli";
import { dailyCapsView } from "../../brain/daily-caps-view";
import { readCodexConfigModel } from "../../brain/providers/codex";
import { Layout } from "../_shared/layout";
import { SettingsScreen } from "../screens/Settings";
import { lastCalls } from "../screens/settings-last-calls";

export interface SettingsRouteDeps {
  homeBase: string;
  secret: string;
  /** Where chat call records are read from; local files by default. */
  runStore?: ChatRunStore;
  /** Test seam — the home whose ~/.codex/config.toml names codex's model. Default: the user's home. */
  codexHome?: string;
}

export function mountSettingsRoutes(app: Hono, deps: SettingsRouteDeps): void {
  const store = deps.runStore ?? localRunStore(deps.homeBase);
  app.get("/settings", async (c) => {
    const view = brainView(deps.homeBase);
    const caps = dailyCapsView(deps.homeBase);
    const last = await lastCalls(deps.homeBase, store);
    const codexModel = readCodexConfigModel(deps.codexHome);
    return c.html(
      <Layout title="Settings · siltpoke" secret={deps.secret}>
        <SettingsScreen view={view} secret={deps.secret} caps={caps} last={last} codexModel={codexModel} />
      </Layout>,
    );
  });
}
