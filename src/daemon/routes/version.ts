// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
// Copyright (c) 2026 Jiaqi Duan
import type { Hono } from "hono";

export function mountVersionRoute(app: Hono): void {
  app.get("/api/version", (c) =>
    c.json({ daemonVersion: "0.1.0", protocol: 1 }),
  );
}
