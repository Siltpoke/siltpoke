// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Copyright (c) 2026 Jiaqi Duan
/** @jsxImportSource hono/jsx */
/**
 * Home route.
 *
 * Uses getHomeData() as the single data source.
 * TopBar mount dropped — brand + pet meta live in sidebar chip and Home
 * content header per the locked layout.
 *
 * topbarBadgesFromData is kept for external tests that import it.
 */
import type { Hono } from "hono";
import { join } from "node:path";
import { homedir } from "node:os";
import { Home } from "../screens/Home";
import type { TopBarBadge } from "../primitives/TopBar";
import { Layout } from "../_shared/layout";
import { getHomeData, type HomeData } from "../screens/Home.data";
import { tokens } from "../tokens/tokens";

export interface HomeRouteDeps {
  homeBase?: string;
}

/**
 * Map HomeData.topbarBadges → TopBarBadge[] for TopBar rendering.
 *
 * Kept for backward-compat with external tests. TopBar is no longer mounted
 * on the Home route, but this mapper remains usable by other routes or
 * future screens that need badge → TopBar translation.
 */
export function topbarBadgesFromData(
  badges: HomeData["topbarBadges"],
): TopBarBadge[] {
  const result: TopBarBadge[] = [];

  if (badges.wellFed) {
    result.push({ id: "well-fed", label: "well-fed", tone: "good" });
  }

  result.push({
    id: "dressed",
    label: "dressed",
    value: badges.sinceDressed,
    tone: "neutral",
  });

  if (badges.todayCount > 0) {
    result.push({
      id: "today",
      label: "today",
      value: `${badges.todayCount} new`,
      tone: "good",
    });
  }

  return result;
}

/**
 * Inline degraded-state body for filesystem-failure paths. Keeps the user
 * on the rendered shell rather than dropping to Hono's default JSON 500.
 */
function HomeErrorBody({ message }: { message: string }) {
  return (
    <main
      style={{
        padding: "48px 24px",
        textAlign: "center",
        color: tokens.color.ink2,
        fontFamily: tokens.font.body,
      }}
    >
      <h1 style={{ fontFamily: tokens.font.display, color: tokens.color.ink }}>
        siltpoke
      </h1>
      <p>{message}</p>
      <p style={{ fontSize: 12, color: tokens.color.ink3, marginTop: 24 }}>
        Try refreshing or check daemon logs.
      </p>
    </main>
  );
}

export function mountHomeRoutes(app: Hono, deps: HomeRouteDeps = {}): void {
  const homeBase =
    deps.homeBase ?? process.env.SILTPOKE_HOME ?? join(homedir(), ".siltpoke");

  app.get("/", async (c) => {
    let data: HomeData;
    try {
      data = await getHomeData({ basePath: homeBase });
    } catch (err) {
      const msg = err instanceof Error ? err.message : "unknown error";
      return c.html(
        <Layout title="siltpoke">
          <HomeErrorBody message={`Could not load pet data: ${msg}`} />
        </Layout>,
        500,
      );
    }
    const viewParam = c.req.query("view");
    const view: "dashboard" | "toy" = viewParam === "toy" ? "toy" : "dashboard";
    const shellName = c.req.query("shell") ?? "blush";
    return c.html(
      <Layout title={`${data.pet.name} · siltpoke`}>
        <Home data={data} view={view} shellName={shellName} />
      </Layout>,
    );
  });
}
