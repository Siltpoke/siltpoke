// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
// Copyright (c) 2026 Jiaqi Duan
import type { Hono } from "hono";
import type { HookEvent } from "../../router/router";
import { isAuthorized } from "../auth";
import { claimMarker, completeMarker, deriveStopMarkerKey } from "../marker";

export interface HooksRouteDeps {
  markerDir: string;
  secret: string;
  handleStopHook: (event: HookEvent) => Promise<unknown>;
}

interface StopPayload extends HookEvent {
  session_id: string;
}

export function mountHooksRoute(app: Hono, deps: HooksRouteDeps): void {
  app.post("/hooks/stop", async (c) => {
    if (!isAuthorized(deps.secret, c.req.header("X-Siltpoke-Secret"))) {
      return c.json({ error: "unauthorized" }, 401);
    }
    const event = (await c.req.json()) as StopPayload;

    // Detached review — runs the Brain call after the HTTP response returns.
    const reviewDetached = (): void => {
      void (async () => {
        try {
          await deps.handleStopHook(event);
        } catch {
          // the hook pipeline logs its own fatals; never surface here
        }
      })();
    };

    // Same key derivation as on-stop.ts (session_id + transcript-content hash),
    // so the curl fast-path (this route) and the on-stop.ts command fallback —
    // which Claude Code fires for the SAME Stop event — race for the SAME
    // marker and dedupe against each other by design.
    const key = deriveStopMarkerKey(event);
    if (key === null) {
      // No usable transcript to key on: fail soft — review, cannot dedupe.
      reviewDetached();
      return c.json({ ok: true, undeduped: true }, 202);
    }

    let claimed: boolean;
    try {
      claimed = claimMarker(deps.markerDir, key);
    } catch {
      // Marker subsystem error (e.g. unwritable dir): fail soft — never let a
      // broken dedupe layer drop a real review.
      reviewDetached();
      return c.json({ ok: true, undeduped: true, key }, 202);
    }
    if (!claimed) {
      // Duplicate delivery is the dedupe working. Non-2xx here surfaces as a
      // red "Stop hook error" in Claude Code, so answer 200.
      return c.json({ ok: true, duplicate: true, key }, 200);
    }

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
