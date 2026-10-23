// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
// Copyright (c) 2026 Jiaqi Duan
import { describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { maybeRespawnDaemon } from "../../src/hooks/on-stop";

// Defect [69]: a hook that revives the daemon hands it its own environment,
// so the long-lived daemon keeps the reviving host's SILTPOKE_HOST and every
// later Stop that reaches it over HTTP is attributed to that host.
// Temp HOME + recording spawn: never starts a real daemon.

function enabledHome(): string {
  const home = mkdtempSync(join(tmpdir(), "siltpoke-respawn-69-"));
  mkdirSync(join(home, ".siltpoke"), { recursive: true });
  writeFileSync(join(home, ".siltpoke", "config.json"), JSON.stringify({ daemon: { enabled: true } }));
  return home;
}

describe("[69] respawned daemon does not inherit the reviving hook's host", () => {
  it("drops SILTPOKE_HOST from the daemon's environment", async () => {
    let seen: Record<string, string | undefined> | undefined;
    const spawnFn = (_cmd: string[], opts: { env?: Record<string, string | undefined> }) => {
      seen = opts.env;
      return { unref() {} };
    };
    const home = enabledHome();
    const siltpokeHome = join(home, ".siltpoke");
    await maybeRespawnDaemon(
      { HOME: home, SILTPOKE_DAEMON_PORT: "9", SILTPOKE_HOST: "qoder", SILTPOKE_HOME: siltpokeHome, PATH: "/usr/bin" },
      spawnFn as never,
    );
    expect(seen).toBeDefined();
    expect(seen?.SILTPOKE_HOST).toBeUndefined();
    // The rest of the environment still reaches the daemon — including the
    // other SILTPOKE_* settings it needs to find its data.
    expect(seen?.PATH).toBe("/usr/bin");
    expect(seen?.SILTPOKE_HOME).toBe(siltpokeHome);
    expect(seen?.SILTPOKE_DAEMON_PORT).toBe("9");
  });
});
