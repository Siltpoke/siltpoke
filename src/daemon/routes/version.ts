// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
// Copyright (c) 2026 Jiaqi Duan
/**
 * Version route.
 *
 * GET /api/version
 *   { daemonVersion, protocol, build: BuildStamp, line: BuildLine }
 *
 * `daemonVersion` is the hand-maintained protocol-compat number and says
 * nothing about which code is running. `build` is the measured answer to that
 * question: the sha256 of the file THIS process loaded, that same path's
 * content now, and the commit whose committed copy of the bundle has the boot
 * content. Kept distinct on purpose — collapsing them into one "version"
 * string is how a build identity starts lying.
 *
 * Complements /api/daemon-health, which reports the CHECKOUT's git HEAD at
 * boot. That answers "what was this directory on", not "what is this process
 * running"; the two diverge whenever `dist/` was not rebuilt, or the checkout
 * moved after the daemon started.
 */
import type { Hono } from "hono";
import { readBuildStamp } from "../../build-stamp/capture";
import { type BuildStamp, formatBuildLine } from "../../build-stamp/format";

export interface VersionRouteDeps {
  /** Measured build stamp for this process. Injectable for tests. */
  readBuildStamp?: () => BuildStamp;
}

export function mountVersionRoute(app: Hono, deps: VersionRouteDeps = {}): void {
  const readStamp = deps.readBuildStamp ?? readBuildStamp;
  app.get("/api/version", (c) => {
    // A capture failure must not take the endpoint down: this is the surface a
    // reader consults precisely when something is already wrong.
    let build: BuildStamp | null = null;
    try {
      build = readStamp();
    } catch {
      build = null;
    }
    return c.json({
      daemonVersion: "0.1.1",
      protocol: 1,
      build,
      line: build ? formatBuildLine(build) : { show: false, state: "unknown", text: "", title: "" },
    });
  });
}
