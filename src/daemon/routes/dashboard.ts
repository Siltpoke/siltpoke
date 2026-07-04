// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
// Copyright (c) 2026 Jiaqi Duan
/**
 * Dashboard routes — formerly `src/cli/serve.ts`, now mounted into siltpoked.
 *
 *   GET  /            → rendered dashboard HTML (cached until invalidated)
 *   GET  /index.html  → redirect to /
 *   GET  /api/ping    → { ok, mode, pid }
 *   POST /api/action  → record a feed/play/pet/tease, write progression
 *                       Accept: text/html → renders Hero fragment + HX-Trigger
 *                       Accept: application/json (default) → JSON shape (regression-pin)
 *   POST /api/config  → sanitize + merge a config patch, persist to disk
 *   POST /api/refresh → bust the cached HTML
 *
 * Mount AFTER /hooks/stop and /api/version so the daemon's own routes
 * don't get shadowed.
 */
import type { Hono } from "hono";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import {
  readProgression,
  writeProgression,
  recordAction,
  STAT_EFFECTS,
  type PetAction,
} from "../../state/progression";
import { maybeWriteSnapshot } from "../../state/vitalsWriter";
import { buildReport } from "../../cli/report";
import {
  toPetProps,
  deriveMood,
  renderHeroFragment,
  renderStatsPanelOOB,
} from "./dashboard-helpers";
import { SPECIES } from "../../web/creature/parts";
import type { Species } from "../../web/creature/parts";

const VALID_ACTIONS: PetAction[] = ["feed", "play", "pet", "tease", "clean", "sleep"];

const WRITABLE_CONFIG_KEYS = new Set<string>([
  "name",
  "species",
  "language",
  "snark",
  "patience",
  "rigor",
  "chattiness",
  "curiosity",
  "triggerMode",
]);

function sanitizeConfigPatch(
  patch: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(patch)) {
    if (!WRITABLE_CONFIG_KEYS.has(k)) continue;
    if (
      k === "snark" ||
      k === "patience" ||
      k === "rigor" ||
      k === "chattiness" ||
      k === "curiosity"
    ) {
      const n = Number(v);
      if (!Number.isFinite(n) || n < 0 || n > 10) continue;
      out[k] = Math.round(n);
      continue;
    }
    if (typeof v === "string" && v.length <= 200) out[k] = v;
  }
  return out;
}

async function loadConfig(homeBase: string): Promise<Record<string, unknown>> {
  const path = join(homeBase, "config.json");
  if (!existsSync(path)) return {};
  try {
    return JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
  } catch {
    return {};
  }
}

async function saveConfig(
  homeBase: string,
  cfg: Record<string, unknown>,
): Promise<void> {
  await mkdir(homeBase, { recursive: true });
  await writeFile(
    join(homeBase, "config.json"),
    JSON.stringify(cfg, null, 2),
    "utf8",
  );
}

function todayKey(): string {
  return new Date().toISOString().slice(0, 10);
}

export interface DashboardRouteDeps {
  homeBase: string;
  projectCwd?: string;
}

export function mountDashboardRoutes(
  app: Hono,
  deps: DashboardRouteDeps,
): void {
  let cachedHtml: string | null = null;
  const invalidate = (): void => {
    cachedHtml = null;
  };

  // Moved from "/" to "/dashboard" so Home (src/web/screens/Home.tsx)
  // can claim "/". Legacy CLI siltpoke-report consumers (bun run dashboard / siltpoke report)
  // must use the new path. /index.html still redirects to / (Home) for canonical entry.
  app.get("/dashboard", async () => {
    if (!cachedHtml) {
      const result = await buildReport({
        homeBase: deps.homeBase,
        projectCwd: deps.projectCwd,
        serveMode: true,
      });
      cachedHtml = await readFile(result.outPath, "utf8");
    }
    return new Response(cachedHtml, {
      headers: {
        "content-type": "text/html; charset=utf-8",
        "cache-control": "no-store",
      },
    });
  });

  app.get("/index.html", (c) => c.redirect("/"));

  app.get("/api/ping", (c) =>
    c.json({
      ok: true,
      mode: deps.projectCwd ? "project" : "global",
      pid: process.pid,
    }),
  );

  app.post("/api/action", async (c) => {
    // HTMX posts form-encoded by default; programmatic callers post JSON.
    // Accept both so the UI buttons and external/test clients both work.
    let action: unknown;
    const contentType = c.req.header("content-type") ?? "";
    if (contentType.includes("application/json")) {
      try {
        const body = (await c.req.json()) as { action?: unknown };
        action = body.action;
      } catch {
        return c.json({ error: "invalid json" }, 400);
      }
    } else {
      try {
        const form = await c.req.parseBody();
        action = form.action;
      } catch {
        return c.json({ error: "invalid form body" }, 400);
      }
    }
    if (
      typeof action !== "string" ||
      !VALID_ACTIONS.includes(action as PetAction)
    ) {
      return c.json(
        { error: "invalid action — must be feed/play/pet/tease" },
        400,
      );
    }
    const prog = await readProgression(deps.homeBase);
    // Snapshot vitals for yesterday BEFORE recording today's action.
    const now = new Date();
    await maybeWriteSnapshot(prog, now, deps.homeBase);
    const result = recordAction(prog, todayKey(), action as PetAction);
    await writeProgression(deps.homeBase, result.next);
    invalidate();

    // Content-negotiation:
    //   HX-Request: true   → HTMX click — return Hero fragment + OOB stats panel
    //   Accept: text/html  → explicit HTML request — same as HTMX
    //   default            → JSON shape (regression-pin — existing consumers)
    // HX-Request is the reliable HTMX signal: htmx sends Accept: */* by default
    // so accept-only sniffing fires JSON back into the browser, which boost
    // then swaps as a full document. HX-Request is unambiguous.
    const accept = c.req.header("Accept") ?? "";
    const isHtmx = c.req.header("HX-Request") === "true";
    if (isHtmx || accept.includes("text/html")) {
      const cfg = await loadConfig(deps.homeBase);
      const name = typeof cfg.name === "string" ? cfg.name : "siltpoke";
      const speciesRaw = typeof cfg.species === "string" ? cfg.species : "slime";
      // Narrow to Species via SPECIES record keys (canonical source). When
      // a new species lands in parts.ts SPECIES, this guard updates without
      // requiring a manual edit here.
      const VALID_SPECIES = Object.keys(SPECIES) as Species[];
      const species: Species = (VALID_SPECIES as readonly string[]).includes(speciesRaw)
        ? (speciesRaw as Species)
        : "slime";

      const derivedMood = deriveMood(result, action as PetAction);
      const petProps = toPetProps(result, name, species, action as PetAction);
      const progression = {
        xp: result.next.xp,
        xp_to_next: result.next.xp_to_next_level,
      };

      // Stat delta = 0 when capped (recordAction short-circuits without
      // applying effects). Client uses this to render the +/- banner.
      const statDelta = result.capped
        ? {}
        : (STAT_EFFECTS[action as PetAction] as Record<string, number>);

      const triggerPayload = JSON.stringify({
        "action-result": {
          level: result.next.level,
          mood: derivedMood,
          name,
          species,
          action: action as PetAction,
          awarded: result.awarded,
          capped: result.capped,
          grumpy: result.grumpy,
          stat_delta: statDelta,
        },
      });

      const fragment = renderHeroFragment(petProps, progression);
      // OOB swap so the StatsPanel (outside #hero) reflects new hp/hunger/
      // energy/mood/bond/XP without a full reload.
      const statsOOB = renderStatsPanelOOB(result.next, now);
      return new Response(fragment + statsOOB, {
        status: 200,
        headers: {
          "content-type": "text/html; charset=utf-8",
          // HX-Trigger-After-Swap fires AFTER #hero is replaced so the
          // action-result listener queries the fresh DOM. Plain HX-Trigger
          // fires before swap → scatter/banner get appended to the
          // about-to-be-removed #hero and disappear instantly.
          "HX-Trigger-After-Swap": triggerPayload,
        },
      });
    }

    return c.json({
      ok: true,
      action,
      awarded: result.awarded,
      capped: result.capped,
      grumpy: result.grumpy,
      action_count: result.action_count,
      tease_count: result.tease_count,
      level: result.next.level,
      xp: result.next.xp,
      xp_to_next_level: result.next.xp_to_next_level,
    });
  });

  app.post("/api/config", async (c) => {
    let patch: unknown;
    try {
      patch = await c.req.json();
    } catch {
      return c.json({ error: "invalid json" }, 400);
    }
    if (typeof patch !== "object" || patch === null) {
      return c.json({ error: "expected object body" }, 400);
    }
    const clean = sanitizeConfigPatch(patch as Record<string, unknown>);
    const current = await loadConfig(deps.homeBase);
    const merged = { ...current, ...clean };
    await saveConfig(deps.homeBase, merged);
    invalidate();
    return c.json({ ok: true, config: merged });
  });

  app.post("/api/refresh", (c) => {
    invalidate();
    return c.json({ ok: true });
  });
}
