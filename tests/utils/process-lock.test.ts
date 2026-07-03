import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import {
  mkdtempSync,
  existsSync,
  mkdirSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  acquireLock,
  releaseLock,
  isLockHeld,
  type LockHandle,
} from "../../src/utils/process-lock";

describe("process-lock", () => {
  let dir: string;
  let handle: LockHandle | null = null;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "lock-"));
  });

  afterEach(() => {
    if (handle) {
      try { releaseLock(handle); } catch {}
    }
    handle = null;
  });

  test("acquireLock succeeds when no prior lock exists", () => {
    const lockPath = join(dir, "x.lock");
    handle = acquireLock(lockPath, { version: "test", heartbeatMs: 100 });
    expect(handle).not.toBeNull();
    expect(isLockHeld(lockPath)).toBe(true);
  });

  test("acquireLock throws when another live process holds the lock", () => {
    const lockPath = join(dir, "x.lock");
    handle = acquireLock(lockPath, { version: "test", heartbeatMs: 100 });
    expect(() =>
      acquireLock(lockPath, { version: "test", heartbeatMs: 100 }),
    ).toThrow(/already held/);
  });

  test("acquireLock succeeds when previous holder PID is dead", () => {
    const lockPath = join(dir, "x.lock");
    mkdirSync(lockPath);
    // PID 999999 is assumed not to exist on this system.
    writeFileSync(
      join(lockPath, "owner.json"),
      JSON.stringify({
        pid: 999999,
        startedAt: 0,
        host: "x",
        version: "old",
      }),
    );
    handle = acquireLock(lockPath, { version: "test", heartbeatMs: 100 });
    expect(handle).not.toBeNull();
    expect(isLockHeld(lockPath)).toBe(true);
  });

  test("releaseLock removes the lock dir and stops the heartbeat", () => {
    const lockPath = join(dir, "x.lock");
    handle = acquireLock(lockPath, { version: "test", heartbeatMs: 100 });
    releaseLock(handle);
    handle = null;
    expect(existsSync(lockPath)).toBe(false);
  });

  test("isLockHeld returns false when no lock dir exists", () => {
    expect(isLockHeld(join(dir, "missing.lock"))).toBe(false);
  });

  test("isLockHeld returns false when owner.json is corrupt", () => {
    const lockPath = join(dir, "x.lock");
    mkdirSync(lockPath);
    writeFileSync(join(lockPath, "owner.json"), "not-json");
    expect(isLockHeld(lockPath)).toBe(false);
  });
});
