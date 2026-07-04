// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
// Copyright (c) 2026 Jiaqi Duan
/**
 * Daemon health route.
 *
 * GET /api/daemon-health
 *   Response 200: { success: true, data: {
 *     bootSha, bootTime, headSha, commitsBehind, state
 *   } }
 *   state ∈ "current" | "behind" | "unknown".
 *
 * Reports which siltpoke SOURCE-repo commit the daemon booted from and how far
 * behind current repo HEAD it is — so a merged fix can't silently fail to take
 * effect (the $1.45 stale-daemon scenario). bootSha/bootTime are captured once
 * at boot (cached); headSha + commitsBehind are derived per request via a cheap
 * local git op. Any git error → state "unknown", logged once, endpoint still 200s.
 */
import type { Hono } from "hono";
import {
  type BootBuild,
  computeStaleness,
  type DaemonState,
  type GitProbe,
  makeGitProbe,
  readBootBuild,
} from "../build-state";

export interface DaemonHealthRouteDeps {
  /** Cached boot build (siltpoke source-repo SHA + time). Injectable for tests. */
  readBootBuild?: () => BootBuild;
  /** Git probe bound to the siltpoke source repo. Injectable for tests. */
  gitProbe?: GitProbe;
}

let loggedProbeError = false;

export function mountDaemonHealthRoute(
  app: Hono,
  deps: DaemonHealthRouteDeps = {},
): void {
  const getBoot = deps.readBootBuild ?? readBootBuild;
  const probe = deps.gitProbe ?? makeGitProbe();

  app.get("/api/daemon-health", (c) => {
    const { bootSha, bootTime } = getBoot();
    // The real probe swallows git errors (returns null), but guard the whole
    // derivation so ANY probe throw — headSha, isAncestor, or countBetween —
    // degrades to "unknown" + 200, never a 500.
    let headSha: string | null = null;
    let commitsBehind: number | null = null;
    let state: DaemonState = "unknown";
    try {
      headSha = probe.headSha();
      ({ commitsBehind, state } = computeStaleness(bootSha, headSha, probe));
    } catch (err) {
      // Request-time git error → degrade to unknown, log once, still 200.
      if (!loggedProbeError) {
        loggedProbeError = true;
        console.error("[daemon-health] git probe failed; reporting unknown:", err);
      }
      headSha = null;
      commitsBehind = null;
      state = "unknown";
    }
    return c.json({
      success: true,
      data: { bootSha, bootTime, headSha, commitsBehind, state },
    });
  });
}
