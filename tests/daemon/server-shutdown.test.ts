/**
 * Daemon SIGTERM zombie fix.
 *
 * Root cause: stopDaemon() tore down server/lock/pidfile but never cleared the
 * two background setInterval timers (decay tick + 24h trace retention) and
 * never forced process.exit. The live timers pinned the event loop, so a
 * `stop` (SIGTERM-only, no SIGKILL escalation) hung forever → zombie daemon.
 *
 * These tests are deterministic — no real process spawn, no `ps` polling:
 *   1. stopDaemon clears BOTH background timers (decay cleanup + retention).
 *   2. the SIGTERM handler calls the injected exit fn (status 0) AFTER
 *      stopDaemon resolves.
 */
import { describe, expect, test } from "bun:test";
import {
  stopDaemon,
  makeShutdownHandler,
  type DaemonHandle,
} from "../../src/daemon/server";

// A DaemonHandle stub with no real server/lock — only the teardown seams that
// stopDaemon touches. server.stop / releaseLock are spied to confirm order is
// preserved; the focus is the two NEW timer-clearing responsibilities.
function makeStubHandle(): {
  handle: DaemonHandle;
  calls: { stopDecay: number; serverStop: number; stopWatchers: number };
} {
  const calls = { stopDecay: 0, serverStop: 0, stopWatchers: 0 };

  // A real setInterval handle so clearInterval(handle.retentionTimer) is exercised
  // for real. Long interval + unref so it never fires / never pins this runner.
  const retentionTimer = setInterval(() => {}, 60 * 60 * 1000);
  (retentionTimer as { unref?: () => void }).unref?.();
  const handle: DaemonHandle = {
    // biome-ignore lint/suspicious/noExplicitAny: minimal stub, only .stop is called
    server: { stop: (_force?: boolean) => { calls.serverStop++; } } as any,
    // biome-ignore lint/suspicious/noExplicitAny: releaseLock tolerates a stub lock
    lock: { path: "/tmp/stub.lock" } as any,
    pidPath: "/tmp/this-path-should-not-exist-b1.pid",
    stopDecay: () => { calls.stopDecay++; },
    retentionTimer,
    taskRegistry: { stopWatchers: () => { calls.stopWatchers++; } },
  };
  return { handle, calls };
}

describe("daemon shutdown — timer teardown", () => {
  test("stopDaemon clears the decay tick and the retention timer", async () => {
    const { handle, calls } = makeStubHandle();

    // Spy global clearInterval to confirm stopDaemon clears the retention timer
    // SPECIFICALLY. This bites: drop the `clearInterval(handle.retentionTimer)`
    // line from stopDaemon and `cleared` no longer contains it → test fails.
    const cleared: unknown[] = [];
    const realClear = globalThis.clearInterval;
    globalThis.clearInterval = ((t: unknown) => {
      cleared.push(t);
      realClear(t as ReturnType<typeof setInterval>);
    }) as typeof clearInterval;
    try {
      await stopDaemon(handle);
    } finally {
      globalThis.clearInterval = realClear;
    }

    // The decay cleanup fn (returned by startDecayTick, previously discarded)
    // must now be invoked.
    expect(calls.stopDecay).toBe(1);
    // The retention timer (the OTHER root-cause timer) must actually be cleared.
    expect(cleared).toContain(handle.retentionTimer);
    // The server must still be stopped (existing behavior preserved).
    expect(calls.serverStop).toBe(1);
  });

  test("stopDaemon calls stopWatchers() on the taskRegistry (Bug B — no poll timer pins event loop)", async () => {
    const { handle, calls } = makeStubHandle();
    await stopDaemon(handle);
    expect(calls.stopWatchers).toBe(1);
  });

  test("makeShutdownHandler calls exit(0) after stopDaemon resolves", async () => {
    const { handle, calls } = makeStubHandle();
    const exitCalls: number[] = [];
    let stopResolvedBeforeExit = false;

    const exit = (code: number) => {
      // stopDaemon must have run (decay cleared) before exit fires.
      stopResolvedBeforeExit = calls.stopDecay === 1;
      exitCalls.push(code);
    };

    const handler = makeShutdownHandler(handle, exit);
    await handler();

    expect(exitCalls).toEqual([0]);
    expect(stopResolvedBeforeExit).toBe(true);
  });
});
