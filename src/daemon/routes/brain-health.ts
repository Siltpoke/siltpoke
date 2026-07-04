// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
// Copyright (c) 2026 Jiaqi Duan
/**
 * Brain health route.
 *
 * GET /api/brain-health
 *   Response 200: { success: true, data: { show, line, consecutive_failures,
 *                   last_failure, breaker, last_success_ts } }
 *
 * Feeds the dashboard ephemeral health strip. Same predicate as the
 * state-card ⚠ line (src/state/brain-health.ts brainUnhealthySignal):
 * show=true only while unhealthy; clears automatically on the next
 * Brain success — the strip simply stops rendering.
 */
import type { Hono } from "hono";
import { join } from "node:path";
import {
  readBrainHealth,
  brainUnhealthySignal,
} from "../../state/brain-health";

export interface BrainHealthRouteDeps {
  /** Override ~/.siltpoke (for test isolation). */
  homeBase?: string;
}

function defaultHomeBase(): string {
  return join(process.env.HOME ?? "", ".siltpoke");
}

export function mountBrainHealthRoute(
  app: Hono,
  deps: BrainHealthRouteDeps = {},
): void {
  app.get("/api/brain-health", (c) => {
    const homeBase = deps.homeBase ?? defaultHomeBase();
    const health = readBrainHealth(homeBase);
    const signal = brainUnhealthySignal(health, new Date());
    return c.json({
      success: true,
      data: {
        show: signal.show,
        line: signal.line,
        consecutive_failures: health.consecutive_failures,
        last_failure: health.last_failure,
        breaker: health.breaker,
        last_success_ts: health.last_success_ts,
      },
    });
  });
}
