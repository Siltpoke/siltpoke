import { describe, test, expect, afterEach } from "bun:test";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startDaemon, stopDaemon, type DaemonHandle } from "../../src/daemon/server";

describe("daemon lifecycle", () => {
  let handle: DaemonHandle | null = null;

  afterEach(async () => {
    if (handle) {
      try { await stopDaemon(handle); } catch {}
    }
    handle = null;
  });

  test("startDaemon acquires lock, writes pidfile, binds port; stopDaemon cleans up", async () => {
    const dir = mkdtempSync(join(tmpdir(), "daemon-"));
    handle = await startDaemon({
      port: 0,
      hostname: "127.0.0.1",
      lockPath: join(dir, "siltpoked.lock"),
      pidPath: join(dir, "siltpoked.pid"),
      markerDir: join(dir, "markers"),
      secret: "test-secret",
    });
    expect(existsSync(join(dir, "siltpoked.lock"))).toBe(true);
    expect(existsSync(join(dir, "siltpoked.pid"))).toBe(true);
    expect(existsSync(join(dir, "markers"))).toBe(true);

    // The placeholder /api/ping route should respond.
    const r = await fetch(`http://127.0.0.1:${handle.server.port}/api/ping`);
    expect(r.ok).toBe(true);
    const j = (await r.json()) as { ok: boolean; daemonVersion?: string; protocol?: number; pid?: number; mode?: string };
    expect(j.ok).toBe(true);

    await stopDaemon(handle);
    handle = null;
    expect(existsSync(join(dir, "siltpoked.lock"))).toBe(false);
    expect(existsSync(join(dir, "siltpoked.pid"))).toBe(false);
  });

  test("starting a second daemon on the same lock throws", async () => {
    const dir = mkdtempSync(join(tmpdir(), "daemon-"));
    handle = await startDaemon({
      port: 0, hostname: "127.0.0.1",
      lockPath: join(dir, "siltpoked.lock"),
      pidPath: join(dir, "siltpoked.pid"),
      markerDir: join(dir, "markers"),
      secret: "x",
    });
    await expect(
      startDaemon({
        port: 0, hostname: "127.0.0.1",
        lockPath: join(dir, "siltpoked.lock"),
        pidPath: join(dir, "siltpoked.pid"),
        markerDir: join(dir, "markers"),
        secret: "x",
      })
    ).rejects.toThrow(/already held/);
  });

  test("GET /api/version returns daemonVersion + protocol", async () => {
    const dir = mkdtempSync(join(tmpdir(), "version-"));
    handle = await startDaemon({
      port: 0, hostname: "127.0.0.1",
      lockPath: join(dir, "siltpoked.lock"),
      pidPath: join(dir, "siltpoked.pid"),
      markerDir: join(dir, "markers"),
      secret: "x",
    });
    const r = await fetch(`http://127.0.0.1:${handle.server.port}/api/version`);
    expect(r.ok).toBe(true);
    const j = (await r.json()) as { ok: boolean; daemonVersion?: string; protocol?: number; pid?: number; mode?: string };
    expect(j.daemonVersion).toBe("0.1.0");
    expect(j.protocol).toBe(1);
  });

  test("evicts prior :9876 holder when legacy report.pid points at a live process", async () => {
    const dir = mkdtempSync(join(tmpdir(), "evict-"));

    // Grab an ephemeral port by probing, then release it so the daemon can bind.
    const probe = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch: () => new Response(""),
    });
    const targetPort = probe.port!;
    probe.stop(true);

    // Spawn a sleeper that holds a PID we can SIGTERM.
    const sleeper = Bun.spawn(["sleep", "30"], {
      stdout: "ignore",
      stderr: "ignore",
    });
    const sleeperPid = sleeper.pid!;
    const legacyPidPath = join(dir, "report.pid");
    writeFileSync(legacyPidPath, String(sleeperPid));

    try {
      handle = await startDaemon({
        port: targetPort,
        hostname: "127.0.0.1",
        lockPath: join(dir, "siltpoked.lock"),
        pidPath: join(dir, "siltpoked.pid"),
        markerDir: join(dir, "markers"),
        secret: "x",
        homeBase: dir,
        legacyPidPath,
      });
      // Daemon bound the port successfully → eviction path completed.
      expect(handle.server.port).toBe(targetPort);

      // Wait briefly for SIGTERM to land on the sleeper.
      await new Promise((r) => setTimeout(r, 100));
      let stillAlive = false;
      try {
        process.kill(sleeperPid, 0);
        stillAlive = true;
      } catch {
        stillAlive = false;
      }
      expect(stillAlive).toBe(false);
    } finally {
      try { sleeper.kill(); } catch {}
    }
  });

  test("eviction is no-op when legacy report.pid does not exist", async () => {
    const dir = mkdtempSync(join(tmpdir(), "no-evict-"));
    // legacyPidPath points at a file that does not exist — startDaemon
    // should succeed normally on port 0.
    handle = await startDaemon({
      port: 0,
      hostname: "127.0.0.1",
      lockPath: join(dir, "siltpoked.lock"),
      pidPath: join(dir, "siltpoked.pid"),
      markerDir: join(dir, "markers"),
      secret: "x",
      homeBase: dir,
      legacyPidPath: join(dir, "does-not-exist-report.pid"),
    });
    expect(handle.server.port).toBeGreaterThan(0);
  });

  test("GET / returns dashboard HTML when daemon up", async () => {
    const dir = mkdtempSync(join(tmpdir(), "dashboard-"));
    handle = await startDaemon({
      port: 0,
      hostname: "127.0.0.1",
      lockPath: join(dir, "siltpoked.lock"),
      pidPath: join(dir, "siltpoked.pid"),
      markerDir: join(dir, "markers"),
      secret: "x",
      homeBase: dir,
    });
    const r = await fetch(`http://127.0.0.1:${handle.server.port}/`);
    expect(r.ok).toBe(true);
    const html = await r.text();
    expect(
      html.startsWith("<!") || html.includes("<html") || html.includes("<DOCTYPE"),
    ).toBe(true);
  });
});
