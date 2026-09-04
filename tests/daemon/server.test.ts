import { describe, test, expect, afterEach } from "bun:test";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  startDaemon,
  stopDaemon,
  DaemonAlreadyRunningError,
  type DaemonHandle,
} from "../../src/daemon/server";
import { resetNavAvailability } from "../../src/web/routes/nav";

describe("daemon lifecycle", () => {
  let handle: DaemonHandle | null = null;

  afterEach(async () => {
    if (handle) {
      try { await stopDaemon(handle); } catch {}
    }
    handle = null;
    resetNavAvailability();
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
      // Without this, `startDaemon` falls back to `siltpokeRoot()` — the real
      // ~/.siltpoke — and its boot-time retention sweep deletes from it.
      // `tests/_setup/isolate-siltpoke-home.ts` also covers this process-wide;
      // both exist because one is a rule to remember and one is mechanical.
      homeBase: dir,
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
      homeBase: dir,
    });
    await expect(
      startDaemon({
        port: 0, hostname: "127.0.0.1",
        lockPath: join(dir, "siltpoked.lock"),
        pidPath: join(dir, "siltpoked.pid"),
        markerDir: join(dir, "markers"),
        secret: "x",
        homeBase: dir,
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
      homeBase: dir,
    });
    const r = await fetch(`http://127.0.0.1:${handle.server.port}/api/version`);
    expect(r.ok).toBe(true);
    const j = (await r.json()) as { ok: boolean; daemonVersion?: string; protocol?: number; pid?: number; mode?: string };
    expect(j.daemonVersion).toBe("0.1.1");
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

  test("evicts prior holder recorded in the current-gen siltpoked.pid (not just report.pid)", async () => {
    // Regression: the launchd + /siltpoke-report spawn paths BOTH write
    // siltpoked.pid. A restarting daemon must evict a prior holder found in
    // siltpoked.pid, not only the legacy report.pid — otherwise the two race
    // to bind :9876 and the loser crash-flaps under KeepAlive.
    const dir = mkdtempSync(join(tmpdir(), "evict-self-"));

    const probe = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response("") });
    const targetPort = probe.port!;
    probe.stop(true);

    const sleeper = Bun.spawn(["sleep", "30"], { stdout: "ignore", stderr: "ignore" });
    const sleeperPid = sleeper.pid!;
    const siltpokedPidPath = join(dir, "siltpoked.pid");
    writeFileSync(siltpokedPidPath, String(sleeperPid));

    try {
      handle = await startDaemon({
        port: targetPort,
        hostname: "127.0.0.1",
        lockPath: join(dir, "siltpoked.lock"),
        pidPath: siltpokedPidPath,
        markerDir: join(dir, "markers"),
        secret: "x",
        homeBase: dir,
        legacyPidPath: join(dir, "report.pid"), // absent → only siltpoked.pid drives eviction
      });
      expect(handle.server.port).toBe(targetPort);

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

  test("steps down with DaemonAlreadyRunningError when a HEALTHY daemon already owns the port", async () => {
    // With pid files empty, eviction no-ops. A second daemon then hits
    // EADDRINUSE. It must NOT crash with a raw bind error under launchd
    // KeepAlive — it must detect the healthy incumbent and step down cleanly.
    const dir1 = mkdtempSync(join(tmpdir(), "incumbent-"));
    const probe = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response("") });
    const targetPort = probe.port!;
    probe.stop(true);

    handle = await startDaemon({
      port: targetPort,
      hostname: "127.0.0.1",
      lockPath: join(dir1, "siltpoked.lock"),
      pidPath: join(dir1, "siltpoked.pid"),
      markerDir: join(dir1, "markers"),
      secret: "x",
      homeBase: dir1,
    });
    expect(handle.server.port).toBe(targetPort);

    const dir2 = mkdtempSync(join(tmpdir(), "newcomer-"));
    await expect(
      startDaemon({
        port: targetPort,
        hostname: "127.0.0.1",
        lockPath: join(dir2, "siltpoked.lock"),
        pidPath: join(dir2, "siltpoked.pid"),
        markerDir: join(dir2, "markers"),
        secret: "x",
        homeBase: dir2,
      }),
    ).rejects.toBeInstanceOf(DaemonAlreadyRunningError);

    // The newcomer must not leave a stale pidfile pointing at its dead self.
    expect(existsSync(join(dir2, "siltpoked.pid"))).toBe(false);
  });

  test("steps down with DaemonAlreadyRunningError on a SHARED lock when the incumbent is healthy", async () => {
    // Production reality: both spawn paths share one ~/.siltpoke/siltpoked.lock,
    // so a restart hits acquireLock's LockHeldError BEFORE Bun.serve — this is
    // the routine "re-setup while a daemon is up" collision. It must resolve to
    // a clean typed step-down (CLI → exit 0), never a raw LockHeldError that
    // crash-flaps under launchd KeepAlive.
    const dir = mkdtempSync(join(tmpdir(), "shared-lock-"));
    const probe = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response("") });
    const targetPort = probe.port!;
    probe.stop(true);

    const shared = {
      lockPath: join(dir, "siltpoked.lock"),
      pidPath: join(dir, "siltpoked.pid"),
      markerDir: join(dir, "markers"),
    };
    handle = await startDaemon({
      port: targetPort,
      hostname: "127.0.0.1",
      secret: "x",
      homeBase: dir,
      ...shared,
    });
    expect(handle.server.port).toBe(targetPort);

    // Second daemon, SAME lock + pid + port (exactly how the CLI wires it).
    await expect(
      startDaemon({
        port: targetPort,
        hostname: "127.0.0.1",
        secret: "x",
        homeBase: dir,
        ...shared,
      }),
    ).rejects.toBeInstanceOf(DaemonAlreadyRunningError);

    // The healthy incumbent's pidfile must be left intact (the newcomer bailed
    // before touching it).
    expect(existsSync(shared.pidPath)).toBe(true);
    // ...and the incumbent is still serving.
    const r = await fetch(`http://127.0.0.1:${targetPort}/api/ping`);
    expect(r.ok).toBe(true);
  });

  test("rethrows the raw bind error when the port is held by an UNHEALTHY process", async () => {
    // A non-siltpoked process squatting the port must surface as a real error,
    // never be masked as "already running".
    const dir1 = mkdtempSync(join(tmpdir(), "squatter-"));
    const squatter = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch: () => new Response("nope", { status: 500 }),
    });
    const targetPort = squatter.port!;

    const dir2 = mkdtempSync(join(tmpdir(), "newcomer2-"));
    try {
      const err = await startDaemon({
        port: targetPort,
        hostname: "127.0.0.1",
        lockPath: join(dir2, "siltpoked.lock"),
        pidPath: join(dir2, "siltpoked.pid"),
        markerDir: join(dir2, "markers"),
        secret: "x",
        homeBase: dir2,
      }).then(
        () => null,
        (e) => e,
      );
      expect(err).not.toBeNull();
      expect(err).not.toBeInstanceOf(DaemonAlreadyRunningError);
    } finally {
      squatter.stop(true);
    }
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

  test("rejects a request with a foreign Host header (DNS-rebinding guard)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "hostguard-"));
    handle = await startDaemon({
      port: 0,
      hostname: "127.0.0.1",
      lockPath: join(dir, "siltpoked.lock"),
      pidPath: join(dir, "siltpoked.pid"),
      markerDir: join(dir, "markers"),
      secret: "x",
      homeBase: dir,
    });
    const r = await fetch(`http://127.0.0.1:${handle.server.port}/`, {
      headers: { Host: "evil.com" },
    });
    expect(r.status).toBe(403);
  });

  test("accepts requests with Host: 127.0.0.1:<port> and Host: localhost:<port>", async () => {
    const dir = mkdtempSync(join(tmpdir(), "hostguard-ok-"));
    handle = await startDaemon({
      port: 0,
      hostname: "127.0.0.1",
      lockPath: join(dir, "siltpoked.lock"),
      pidPath: join(dir, "siltpoked.pid"),
      markerDir: join(dir, "markers"),
      secret: "x",
      homeBase: dir,
    });
    const port = handle.server.port;
    const r1 = await fetch(`http://127.0.0.1:${port}/api/ping`, {
      headers: { Host: `127.0.0.1:${port}` },
    });
    expect(r1.status).toBe(200);
    const r2 = await fetch(`http://127.0.0.1:${port}/api/ping`, {
      headers: { Host: `localhost:${port}` },
    });
    expect(r2.status).toBe(200);
  });
});
