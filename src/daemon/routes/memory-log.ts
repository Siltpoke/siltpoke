// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
// Copyright (c) 2026 Jiaqi Duan
/**
 * GET /api/memory-log — unified memory event stream (Memory Book)
 *
 * Merges facts + critiques + learned_rules into a single timestamp-sorted
 * MemoryEvent[] via the shared loadMemoryEvents() loader.
 *
 * Auth: X-Siltpoke-Secret header (same pattern as /api/facts).
 * Response: { events: MemoryEvent[] } sorted newest-first, 200.
 *           { error: "unauthorized" }, 401 when secret missing / wrong.
 *
 * v1 note: critique `reaction` is null — joining critique archive with
 * preference-log feedback requires a new bulk reader that does not yet exist.
 * Tracked as a v2 concern; honest-null is acceptable.
 */

import type { Hono } from "hono";
import { join } from "node:path";
import type { CritiqueLogEntry } from "../../memory/consolidate";
import { loadAllCritiqueEntries } from "../../memory/consolidate";
import { type CoreMemory, GLOBAL_ONLY, type ProjectScope } from "../../memory/memory";
import { loadMemoryEvents } from "../../memory/memory-log-loader";
import { isAuthorized } from "../auth";
import { resolveRequestProject } from "../project-context";

export interface MemoryLogDeps {
  homeBase: string;
  secret: string;
  /**
   * Loads the canonical memory document (facts + learned_rules), scoped to
   * a project slice (or GLOBAL_ONLY when no project resolves). Mirrors the
   * injection point from FactsDeps in facts.ts.
   */
  readMemory: (homeBase: string, scope?: ProjectScope) => Promise<CoreMemory | null>;
  /**
   * Loads all critique entries from the archive.
   * Injectable so tests can supply an in-memory stub without touching disk.
   * Defaults to the real loadAllCritiqueEntries from consolidate.ts.
   */
  loadCritiques?: (base: string) => Promise<CritiqueLogEntry[]>;
  /**
   * Resolves the `?repo=` query hash (or the daemon's sticky pin/cwd guess)
   * to a project root. Injectable so tests control resolution deterministically
   * without touching the real project-pin / repo-memory disk state.
   * Defaults to the real resolveRequestProject from project-context.ts.
   */
  resolveScope?: (home: string, explicit: string | undefined) => Promise<string | null>;
}

export function mountMemoryLogRoute(app: Hono, deps: MemoryLogDeps): void {
  const loadCritiques = deps.loadCritiques ?? loadAllCritiqueEntries;

  app.get("/api/memory-log", async (c) => {
    if (!isAuthorized(deps.secret, c.req.header("X-Siltpoke-Secret"))) {
      return c.json({ error: "unauthorized" }, 401);
    }

    const projectRoot = deps.resolveScope
      ? await deps.resolveScope(deps.homeBase, c.req.query("repo"))
      : (await resolveRequestProject(deps.homeBase, c.req.query("repo"))).project_root;
    const scope: ProjectScope = projectRoot ?? GLOBAL_ONLY;

    const events = await loadMemoryEvents(deps.homeBase, {
      readMemory: (homeBase) => deps.readMemory(homeBase, scope),
      loadCritiques,
      // Critiques are written project-local (writeCritique's stateBase =
      // <cwd>/.siltpoke), so scope the walk to the resolved project. Without
      // this the episodic half of the Memory Book is empty for every project.
      critiquesBase: projectRoot ? join(projectRoot, ".siltpoke") : undefined,
    });

    return c.json({ events }, 200);
  });
}
