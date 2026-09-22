// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
// Copyright (c) 2026 Jiaqi Duan
/**
 * `/siltpoke-doctor`'s daemon-alive row.
 *
 * Split out of `doctor-daemon-check.test.ts` when the identity cases below
 * pushed that file past the repo's 400-LOC soft cap.
 *
 * The identity cases are audit defect `[5b]`
 * (an internal design note §26.3): the row used to
 * accept any 2xx on `/api/ping` as proof that siltpoke answered, so any server
 * holding the port was reported as a live daemon — and it always probed a
 * hardcoded 9876, so a user who set `SILTPOKE_DAEMON_PORT` got a red row about
 * a port nothing ever listened on.
 */
import { describe, expect, test } from "bun:test";
import { checkDaemonAlive } from "../../src/cli/doctor-daemon-check";

describe("doctor daemon-alive — /api/ping probe", () => {
  const OFF_DETAIL = "daemon: off (opt-in — open /siltpoke-dashboard to enable)";
  const ENABLED_UNREACHABLE_DETAIL =
    "daemon.enabled is true but /api/ping is unreachable — try /siltpoke-restart-daemon";
  const PORT_TAKEN_DETAIL =
    "something is answering on the daemon's port but it is not siltpoked — free the port, or set SILTPOKE_DAEMON_PORT to another one";

  /**
   * What a real siltpoked answers on `/api/ping` (`src/daemon/routes/dashboard.ts`).
   * The stubs used to be `{ ok: true } as Response`, which no responder on earth
   * looks like — so they could not tell siltpoke apart from a stranger holding
   * the port, which is audit defect `[5b]`.
   */
  const pingResponse = (body: unknown, ok = true) =>
    ({ ok, text: async () => JSON.stringify(body) }) as Response;
  /** A body the transport never finishes delivering — a timeout mid-read. */
  const unreadableBody = () =>
    ({
      ok: true,
      text: async () => {
        throw new DOMException("signal timed out", "TimeoutError");
      },
    }) as unknown as Response;
  /** A stranger: the read succeeds, the bytes just are not JSON. */
  const rawBody = (text: string, ok = true) =>
    ({ ok, text: async () => text }) as Response;
  const SILTPOKED_PING = { service: "siltpoked", ok: true, mode: "global", pid: 42 };

  test("daemon up (200 on /api/ping) → ✓ pass, no detail", async () => {
    const r = await checkDaemonAlive({
      fetchFn: async () => pingResponse(SILTPOKED_PING),
    });
    expect(r.name).toBe("daemon alive (/api/ping)");
    expect(r.pass).toBe(true);
    expect(r.status).toBe("pass");
    expect(r.detail).toBeNull();
  });

  test("down + daemon.enabled=false (default) → ◦ info 'daemon: off (opt-in...)', pass stays true", async () => {
    const r = await checkDaemonAlive({
      fetchFn: async () => {
        throw new Error("ECONNREFUSED");
      },
      loadDaemonConfigFn: async () => ({ enabled: false }),
    });
    expect(r.pass).toBe(true);
    expect(r.status).toBe("info");
    expect(r.detail).toBe(OFF_DETAIL);
  });

  test("non-200 response + daemon.enabled=false → ◦ info 'daemon: off (opt-in...)' (never a red fail)", async () => {
    const r = await checkDaemonAlive({
      fetchFn: async () => pingResponse(SILTPOKED_PING, false),
      loadDaemonConfigFn: async () => ({ enabled: false }),
    });
    expect(r.pass).toBe(true);
    expect(r.status).toBe("info");
    expect(r.detail).toBe(OFF_DETAIL);
  });

  test("down + daemon.enabled=true → ✗ genuine fail (opted in but unreachable)", async () => {
    const r = await checkDaemonAlive({
      fetchFn: async () => {
        throw new Error("ECONNREFUSED");
      },
      loadDaemonConfigFn: async () => ({ enabled: true }),
    });
    expect(r.pass).toBe(false);
    expect(r.detail).toBe(ENABLED_UNREACHABLE_DETAIL);
  });

  test("a stranger holding the port is NOT reported as a live daemon", async () => {
    // A catch-all dev server answering 200 + HTML on every path is the common
    // case. `res.ok` alone made this row say "daemon alive ✓" about it.
    const r = await checkDaemonAlive({
      fetchFn: async () => rawBody("<!doctype html><title>not siltpoke</title>"),
      loadDaemonConfigFn: async () => ({ enabled: true }),
    });
    expect(r.pass).toBe(false);
    // NOT the "unreachable — try restart" copy: the port WAS reached, and
    // restarting the daemon cannot free it.
    expect(r.detail).toBe(PORT_TAKEN_DETAIL);
  });

  test("a foreign JSON health endpoint answering {ok:true} is also not the daemon", async () => {
    const r = await checkDaemonAlive({
      fetchFn: async () => pingResponse({ ok: true }),
      loadDaemonConfigFn: async () => ({ enabled: true }),
    });
    expect(r.pass).toBe(false);
    expect(r.detail).toBe(PORT_TAKEN_DETAIL);
  });

  test("a stranger is flagged even when the daemon is opted OUT", async () => {
    // The `daemon: off` info row describes an expected state. A stranger on
    // the port is not one — it breaks the daemon the moment the user opts in.
    const r = await checkDaemonAlive({
      fetchFn: async () => pingResponse({ ok: true }),
      loadDaemonConfigFn: async () => ({ enabled: false }),
    });
    expect(r.pass).toBe(false);
    expect(r.detail).toBe(PORT_TAKEN_DETAIL);
  });

  test("nobody answering still reads as unreachable, not as a stranger", async () => {
    const r = await checkDaemonAlive({
      fetchFn: async () => {
        throw new Error("ECONNREFUSED");
      },
      loadDaemonConfigFn: async () => ({ enabled: true }),
    });
    expect(r.detail).toBe(ENABLED_UNREACHABLE_DETAIL);
  });

  test("a body that could not be READ is 'unreachable', NOT 'port taken'", async () => {
    // Regression: the stranger verdict used to be set the instant a 2xx came
    // back, before the body was read. A real siltpoked that is briefly slow
    // under load throws on the body read too (the same AbortSignal bounds it),
    // so it was told a port squatter had taken its port. Restarting, not
    // port-hunting, is the right advice here.
    const r = await checkDaemonAlive({
      fetchFn: async () => unreadableBody(),
      loadDaemonConfigFn: async () => ({ enabled: true }),
    });
    expect(r.pass).toBe(false);
    expect(r.detail).toBe(ENABLED_UNREACHABLE_DETAIL);
  });

  test("a body that could not be READ, daemon opted out → the ordinary 'off' row", async () => {
    const r = await checkDaemonAlive({
      fetchFn: async () => unreadableBody(),
      loadDaemonConfigFn: async () => ({ enabled: false }),
    });
    expect(r.pass).toBe(true);
    expect(r.status).toBe("info");
    expect(r.detail).toBe(OFF_DETAIL);
  });

  test("a siltpoked from before the `service` marker is still recognised", async () => {
    // Upgrade path: rejecting it would red an otherwise healthy install.
    const r = await checkDaemonAlive({
      fetchFn: async () => pingResponse({ ok: true, mode: "project", pid: 7 }),
    });
    expect(r.pass).toBe(true);
    expect(r.status).toBe("pass");
  });

  test("aims at SILTPOKE_DAEMON_PORT, not a hardcoded 9876", async () => {
    const prev = process.env.SILTPOKE_DAEMON_PORT;
    process.env.SILTPOKE_DAEMON_PORT = "9999";
    try {
      const seen: string[] = [];
      await checkDaemonAlive({
        fetchFn: async (input) => {
          seen.push(String(input));
          return pingResponse(SILTPOKED_PING);
        },
      });
      expect(seen).toEqual(["http://127.0.0.1:9999/api/ping"]);
    } finally {
      if (prev === undefined) delete process.env.SILTPOKE_DAEMON_PORT;
      else process.env.SILTPOKE_DAEMON_PORT = prev;
    }
  });

  test("falls back to 9876 when nothing is set (positive control for the line above)", async () => {
    const prevA = process.env.SILTPOKE_DAEMON_PORT;
    const prevB = process.env.PORT;
    delete process.env.SILTPOKE_DAEMON_PORT;
    delete process.env.PORT;
    try {
      const seen: string[] = [];
      await checkDaemonAlive({
        fetchFn: async (input) => {
          seen.push(String(input));
          return pingResponse(SILTPOKED_PING);
        },
      });
      expect(seen).toEqual(["http://127.0.0.1:9876/api/ping"]);
    } finally {
      if (prevA !== undefined) process.env.SILTPOKE_DAEMON_PORT = prevA;
      if (prevB !== undefined) process.env.PORT = prevB;
    }
  });

  test("probes the injectable ping URL", async () => {
    const seen: string[] = [];
    await checkDaemonAlive({
      daemonPingUrl: "http://127.0.0.1:1/api/ping",
      fetchFn: async (input) => {
        seen.push(String(input));
        return pingResponse(SILTPOKED_PING);
      },
    });
    expect(seen).toEqual(["http://127.0.0.1:1/api/ping"]);
  });
});

