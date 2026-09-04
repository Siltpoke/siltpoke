// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
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
import { resolveRequestProject } from "../../daemon/project-context";
import { GLOBAL_ONLY } from "../../memory/memory";

export interface HomeRouteDeps {
  homeBase?: string;
  /**
   * Daemon secret — forwarded to `<Layout secret>`, which sets `hx-headers`
   * on `<body>` (so `ActionChip`'s `hx-post="/api/action"` carries
   * `X-Siltpoke-Secret`) and projects `data-secret` onto FloatingChat.
   * Absent → unauthenticated 401 (fail-closed), same as every other route.
   */
  secret?: string;
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
    let proj: Awaited<ReturnType<typeof resolveRequestProject>>;
    try {
      proj = await resolveRequestProject(homeBase, c.req.query("repo"));
      // One-time canonical ?repo= seed redirect: promote a fresh landing's
      // recency/sticky pick to an explicit URL so it's shareable/bookmarkable
      // and survives a reload without re-guessing. Guarded on the `repo`
      // query param being absent so a request that already carries ?repo=
      // (including the redirect target itself) never redirects again — no loop.
      if (c.req.query("repo") === undefined && proj.proj_hash) {
        return c.redirect(`${c.req.path}?repo=${proj.proj_hash}`, 302);
      }
      data = await getHomeData({
        basePath: homeBase,
        memoryScope: proj.project_root ?? GLOBAL_ONLY,
      });
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
      <Layout title={`${data.pet.name} · siltpoke`} secret={deps.secret}>
        <Home
          data={data}
          view={view}
          shellName={shellName}
          resolvedProject={{
            source: proj.source,
            displayName: proj.display_name,
            projHash: proj.proj_hash,
          }}
        />
      </Layout>,
    );
  });
}
