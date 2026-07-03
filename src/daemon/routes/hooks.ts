// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Copyright (c) 2026 Jiaqi Duan
import type { Hono } from "hono";
import { claimMarker, completeMarker, markerKey } from "../marker";
import { isAuthorized } from "../auth";
import type { HookEvent } from "../../router/router";

export interface HooksRouteDeps {
  markerDir: string;
  secret: string;
  handleStopHook: (event: HookEvent) => Promise<unknown>;
}

interface StopPayload extends HookEvent {
  session_id: string;
  stop_event_timestamp_ms: number;
}

export function mountHooksRoute(app: Hono, deps: HooksRouteDeps): void {
  app.post("/hooks/stop", async (c) => {
    if (!isAuthorized(deps.secret, c.req.header("X-Siltpoke-Secret"))) {
      return c.json({ error: "unauthorized" }, 401);
    }
    const event = (await c.req.json()) as StopPayload;
    const key = markerKey({
      session_id: event.session_id,
      stop_event_timestamp_ms: event.stop_event_timestamp_ms,
    });
    if (!claimMarker(deps.markerDir, key)) {
      // Duplicate delivery is the dedupe working (http fast-path and the
      // on-stop.ts fallback race for the same marker by design). Non-2xx here
      // surfaces as a red "Stop hook error" in Claude Code, so answer 200.
      return c.json({ ok: true, duplicate: true, key }, 200);
    }
    // Detach the Brain call so the HTTP response returns immediately.
    void (async () => {
      try {
        await deps.handleStopHook(event);
      } finally {
        completeMarker(deps.markerDir, key);
      }
    })();
    return c.json({ ok: true, key }, 202);
  });
}
