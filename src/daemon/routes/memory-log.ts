// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
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
import { isAuthorized } from "../auth";
import { loadMemoryEvents } from "../../memory/memory-log-loader";
import type { CoreMemory } from "../../memory/memory";
import type { CritiqueLogEntry } from "../../memory/consolidate";
import { loadAllCritiqueEntries } from "../../memory/consolidate";

export interface MemoryLogDeps {
  homeBase: string;
  secret: string;
  /**
   * Loads the canonical memory document (facts + learned_rules).
   * Mirrors the injection point from FactsDeps in facts.ts.
   */
  readMemory: (homeBase: string) => Promise<CoreMemory | null>;
  /**
   * Loads all critique entries from the archive.
   * Injectable so tests can supply an in-memory stub without touching disk.
   * Defaults to the real loadAllCritiqueEntries from consolidate.ts.
   */
  loadCritiques?: (homeBase: string) => Promise<CritiqueLogEntry[]>;
}

export function mountMemoryLogRoute(app: Hono, deps: MemoryLogDeps): void {
  const loadCritiques = deps.loadCritiques ?? loadAllCritiqueEntries;

  app.get("/api/memory-log", async (c) => {
    if (!isAuthorized(deps.secret, c.req.header("X-Siltpoke-Secret"))) {
      return c.json({ error: "unauthorized" }, 401);
    }

    const events = await loadMemoryEvents(deps.homeBase, {
      readMemory: deps.readMemory,
      loadCritiques,
    });

    return c.json({ events }, 200);
  });
}
