import { describe, test, expect, afterEach } from "bun:test";
import { startDaemon, stopDaemon, type DaemonHandle } from "../../src/daemon/server";
import { resetNavAvailability } from "../../src/web/routes/nav";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

describe("daemon smoke (real port)", () => {
  let handle: DaemonHandle | null = null;

  afterEach(async () => {
    if (handle) {
      try { await stopDaemon(handle); } catch {}
    }
    handle = null;
    resetNavAvailability();
  });

  test("Bun.serve binds 127.0.0.1 and /api/ping responds", async () => {
    const dir = mkdtempSync(join(tmpdir(), "smoke-"));
    handle = await startDaemon({
      port: 0, hostname: "127.0.0.1",
      lockPath: join(dir, "siltpoked.lock"),
      pidPath: join(dir, "siltpoked.pid"),
      markerDir: join(dir, "markers"),
      secret: "x",
      homeBase: dir,
    });
    const r = await fetch(`http://127.0.0.1:${handle.server.port}/api/ping`);
    expect(r.ok).toBe(true);
    const json = (await r.json()) as { ok: boolean; daemonVersion?: string; protocol?: number; pid?: number; mode?: string };
    expect(json.ok).toBe(true);
  });

  test("does NOT bind ::1 (IPv6) when hostname is 127.0.0.1", async () => {
    const dir = mkdtempSync(join(tmpdir(), "smoke-v6-"));
    handle = await startDaemon({
      port: 0, hostname: "127.0.0.1",
      lockPath: join(dir, "siltpoked.lock"),
      pidPath: join(dir, "siltpoked.pid"),
      markerDir: join(dir, "markers"),
      secret: "x",
      homeBase: dir,
    });
    let v6Reachable = false;
    try {
      const r = await fetch(`http://[::1]:${handle.server.port}/api/ping`, {
        signal: AbortSignal.timeout(500),
      });
      v6Reachable = r.ok;
    } catch {
      // expected
    }
    expect(v6Reachable).toBe(false);
  });
});
