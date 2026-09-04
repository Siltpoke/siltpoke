// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
// Copyright (c) 2026 Jiaqi Duan
import { describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setDaemonEnabled } from "../../src/config/write-daemon-enabled";
import { maybeRespawnDaemon } from "../../src/hooks/on-stop";

// `daemon.enabled` lives in `<siltpokeRoot>/config.json` (~/.siltpoke/config.json,
// see src/installer/paths.ts's siltpokeRoot()) — NOT `<HOME>/config.json` directly.
// This helper writes to the same `.siltpoke` subdir maybeRespawnDaemon actually
// reads, so the gate tests exercise the real resolution instead of a path the
// implementation never touches.
function homeWith(daemonEnabled?: boolean): string {
  const home = mkdtempSync(join(tmpdir(), "siltpoke-respawn-"));
  if (daemonEnabled !== undefined) {
    const siltpokeDir = join(home, ".siltpoke");
    mkdirSync(siltpokeDir, { recursive: true });
    writeFileSync(
      join(siltpokeDir, "config.json"),
      JSON.stringify({ daemon: { enabled: daemonEnabled } }),
    );
  }
  return home;
}

describe("maybeRespawnDaemon daemon.enabled gate", () => {
  it("does NOT spawn when daemon.enabled is false", async () => {
    let spawned = 0;
    const spawnFn = () => {
      spawned++;
      return { unref() {} };
    };
    // port 9876 is down in test → without the gate it WOULD spawn.
    await maybeRespawnDaemon({ HOME: homeWith(false) }, spawnFn);
    expect(spawned).toBe(0);
  });

  it("does NOT spawn when config is absent (default off)", async () => {
    let spawned = 0;
    const spawnFn = () => {
      spawned++;
      return { unref() {} };
    };
    await maybeRespawnDaemon({ HOME: homeWith(undefined) }, spawnFn);
    expect(spawned).toBe(0);
  });

  it("spawns when daemon.enabled is true and the port is down", async () => {
    let spawned = 0;
    const spawnFn = () => {
      spawned++;
      return { unref() {} };
    };
    // Use an unlikely port so probeDaemon fails fast → respawn attempted.
    await maybeRespawnDaemon(
      { HOME: homeWith(true), SILTPOKE_DAEMON_PORT: "9" },
      spawnFn,
    );
    expect(spawned).toBe(1);
  });

  it("composes end-to-end with setDaemonEnabled — the dashboard's write path and the respawn gate's read path must agree on the same config.json", async () => {
    // Regression test: report.ts's openDashboard() calls
    // setDaemonEnabled(homeBase, true) with homeBase = `<HOME>/.siltpoke`. If
    // maybeRespawnDaemon ever reads `daemon.enabled` from a different
    // directory (e.g. raw `<HOME>/config.json`), this composes to a silent
    // no-op: the user opts in via the dashboard, but the respawn gate never
    // sees it and the daemon never comes back after it dies.
    const home = mkdtempSync(join(tmpdir(), "siltpoke-respawn-e2e-"));
    const homeBase = join(home, ".siltpoke");
    mkdirSync(homeBase, { recursive: true });
    await setDaemonEnabled(homeBase, true);

    let spawned = 0;
    const spawnFn = () => {
      spawned++;
      return { unref() {} };
    };
    await maybeRespawnDaemon({ HOME: home, SILTPOKE_DAEMON_PORT: "9" }, spawnFn);
    expect(spawned).toBe(1);
  });
});
