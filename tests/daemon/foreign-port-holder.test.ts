// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
// Copyright (c) 2026 Jiaqi Duan
/**
 * A stranger on the dashboard port must not be reported as "siltpoked already
 * running".
 *
 * WHY — audit defect `[5b]`, second half
 * (an internal design note). `isPortHealthy` asked
 * `GET /api/ping` and accepted ANY 2xx as proof that the responder was siltpoke.
 * Plenty of ordinary dev servers answer 200 to an unknown path (a SPA catch-all
 * returning index.html is the common one). When such a server owned 9876, the
 * CLI printed `siltpoked already running on http://127.0.0.1:9876` and exited 0
 * — pointing the user at a URL that is not siltpoke, and hiding the real
 * problem, which is that the port is taken.
 *
 * The fix identifies the responder from its body, so the assertion here is about
 * WHICH error comes back, not about whether one does.
 */
import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DaemonAlreadyRunningError,
  isSiltpokedPing,
  startDaemon,
  stopDaemon,
} from "../../src/daemon/server";

/**
 * Scratch dirs are deliberately NOT removed afterwards. A live daemon's
 * process-lock heartbeat re-stats its lock file on an interval and exits
 * fail-closed when the directory vanishes — deleting the dir under it killed
 * the whole test runner (`[process-lock] lock dir unreachable … exiting
 * fail-closed`, exit 2). `tests/daemon/smoke.e2e.test.ts` leaves its dirs for
 * the same reason; the OS reaps them.
 */
function scratch(): string {
  return mkdtempSync(join(tmpdir(), "siltpoke-foreign-port-"));
}

/** Start a daemon aimed at `port` and return whatever it threw, or null. */
async function startDaemonAgainst(port: number | undefined): Promise<unknown> {
  if (port === undefined) throw new Error("no port to aim at");
  const base = scratch();
  try {
    const handle = await startDaemon({
      port,
      hostname: "127.0.0.1",
      lockPath: join(base, "siltpoked.lock"),
      pidPath: join(base, "siltpoked.pid"),
      markerDir: join(base, "markers"),
      secret: "test-secret",
      homeBase: base,
    });
    await stopDaemon(handle);
    return null;
  } catch (err) {
    return err;
  }
}

describe("a foreign server on the dashboard port", () => {
  test("is not mistaken for a running siltpoked", async () => {
    // A catch-all server: 200 + HTML on every path, including /api/ping.
    const foreign = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch: () => new Response("<!doctype html><title>not siltpoke</title>"),
    });
    try {
      const err = await startDaemonAgainst(foreign.port);
      expect(err).not.toBeNull();
      expect(err).not.toBeInstanceOf(DaemonAlreadyRunningError);
    } finally {
      foreign.stop(true);
    }
  });

  test("a foreign JSON API that answers {ok:true} is also not siltpoked", async () => {
    // `ok: true` alone is a common health-check shape — it identifies nothing.
    const foreign = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch: () => Response.json({ ok: true }),
    });
    try {
      const err = await startDaemonAgainst(foreign.port);
      expect(err).not.toBeNull();
      expect(err).not.toBeInstanceOf(DaemonAlreadyRunningError);
    } finally {
      foreign.stop(true);
    }
  });

  test("positive control — a real siltpoked IS recognised", async () => {
    const base = scratch();
    const handle = await startDaemon({
      port: 0,
      hostname: "127.0.0.1",
      lockPath: join(base, "siltpoked.lock"),
      pidPath: join(base, "siltpoked.pid"),
      markerDir: join(base, "markers"),
      secret: "test-secret",
      homeBase: base,
    });
    try {
      const err = await startDaemonAgainst(handle.server.port);
      expect(err).toBeInstanceOf(DaemonAlreadyRunningError);
    } finally {
      await stopDaemon(handle);
    }
  });
});

describe("isSiltpokedPing", () => {
  test("accepts the current body", () => {
    expect(
      isSiltpokedPing({ service: "siltpoked", ok: true, mode: "global", pid: 1 }),
    ).toBe(true);
  });

  test("accepts a pre-`service` siltpoked, so an upgrade steps down gracefully", () => {
    expect(isSiltpokedPing({ ok: true, mode: "project", pid: 42 })).toBe(true);
    expect(isSiltpokedPing({ ok: true, mode: "global", pid: 42 })).toBe(true);
  });

  test("rejects the bodies a stranger is likely to send", () => {
    expect(isSiltpokedPing({ ok: true })).toBe(false);
    expect(isSiltpokedPing({ status: "ok" })).toBe(false);
    expect(isSiltpokedPing({ ok: true, mode: "global" })).toBe(false); // no pid
    expect(isSiltpokedPing({ ok: true, pid: 42 })).toBe(false); // no mode
    expect(isSiltpokedPing({ ok: true, mode: "other", pid: 42 })).toBe(false);
    expect(isSiltpokedPing("<!doctype html>")).toBe(false);
    expect(isSiltpokedPing(null)).toBe(false);
    expect(isSiltpokedPing(undefined)).toBe(false);
  });
});
