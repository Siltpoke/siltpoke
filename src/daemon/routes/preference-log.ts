// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Copyright (c) 2026 Jiaqi Duan
/**
 * GET /api/preference-log — preference-log entries + signal counts
 *
 * Query params:
 *   limit  (default 50)
 *   signal (filter: ack | dismiss | forward | feedback)
 */
import type { Hono } from "hono";
import { readPreferenceLog, countBySignal } from "../../preference-log/reader";
import type { PreferenceLogSignal } from "../../preference-log/types";

const VALID_SIGNALS = new Set<string>(["ack", "dismiss", "forward", "feedback"]);

export function mountPreferenceLogApiRoutes(app: Hono): void {
  app.get("/api/preference-log", async (c) => {
    const limitParam = c.req.query("limit");
    const limit = Math.max(1, Math.min(500, Number(limitParam) || 50));
    const rawSignal = c.req.query("signal");
    const signal =
      rawSignal && VALID_SIGNALS.has(rawSignal)
        ? (rawSignal as PreferenceLogSignal)
        : undefined;

    const [entries, counts] = await Promise.all([
      readPreferenceLog({ limit, signal }),
      countBySignal(),
    ]);

    return c.json({
      success: true,
      data: {
        counts,
        entries: [...entries].reverse(),
      },
      meta: { total: entries.length, limit },
    });
  });
}
