// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
// Copyright (c) 2026 Jiaqi Duan
import {
  mkdirSync,
  rmSync,
  readFileSync,
  existsSync,
  utimesSync,
} from "node:fs";
import { join } from "node:path";
import { hostname } from "node:os";
import { atomicWrite } from "./atomic-write";

export class LockHeldError extends Error {
  constructor(public readonly pid: number) {
    super(`lock already held by pid=${pid}`);
    this.name = "LockHeldError";
  }
}

export interface LockOptions {
  version: string;
  heartbeatMs: number;
}

interface OwnerJson {
  pid: number;
  startedAt: number;
  host: string;
  version: string;
}

// `heartbeat: ReturnType<typeof setInterval>` is `Timer` under Bun and
// `NodeJS.Timeout` under Node. Both are accepted by `clearInterval`.
export interface LockHandle {
  path: string;
  ownerPath: string;
  heartbeat: ReturnType<typeof setInterval>;
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export function isLockHeld(lockPath: string): boolean {
  if (!existsSync(lockPath)) return false;
  const ownerPath = join(lockPath, "owner.json");
  if (!existsSync(ownerPath)) return false;
  try {
    const owner = JSON.parse(readFileSync(ownerPath, "utf8")) as OwnerJson;
    return isAlive(owner.pid);
  } catch {
    return false;
  }
}

/**
 * Acquires the daemon singleton lock via mkdir-atomic.
 *
 * Known limitations (deferred to a future hardening pass):
 * 1. EEXIST recovery is not strictly race-free — between `rmSync` of a stale
 *    lock and the second `mkdirSync`, a third caller could win. Probability is
 *    very low in single-user dev usage but acknowledged.
 * 2. PID-reuse not cross-checked. `owner.startedAt` is persisted for a future
 *    cross-check against OS process start-time (`/proc/<pid>/stat` on Linux,
 *    `sysctl KERN_PROC` on macOS), but the current `isAlive(pid)` check alone
 *    cannot distinguish "live Siltpoke daemon" from "unrelated process whose
 *    PID was reused after the daemon crashed."
 */
export function acquireLock(
  lockPath: string,
  opts: LockOptions,
): LockHandle {
  try {
    mkdirSync(lockPath, { recursive: false });
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== "EEXIST") throw err;
    const ownerPath = join(lockPath, "owner.json");
    if (existsSync(ownerPath)) {
      try {
        const owner = JSON.parse(
          readFileSync(ownerPath, "utf8"),
        ) as OwnerJson;
        if (isAlive(owner.pid)) {
          throw new LockHeldError(owner.pid);
        }
      } catch (parseErr) {
        if (parseErr instanceof LockHeldError) throw parseErr;
        // Owner JSON unreadable — treat as stale.
      }
    }
    rmSync(lockPath, { recursive: true, force: true });
    mkdirSync(lockPath, { recursive: false });
  }
  const ownerPath = join(lockPath, "owner.json");
  const owner: OwnerJson = {
    pid: process.pid,
    startedAt: Date.now(),
    host: hostname(),
    version: opts.version,
  };
  atomicWrite(ownerPath, JSON.stringify(owner));
  let heartbeatFailures = 0;
  const heartbeat = setInterval(() => {
    const now = new Date();
    try {
      utimesSync(lockPath, now, now);
      heartbeatFailures = 0;
    } catch (err) {
      heartbeatFailures += 1;
      process.stderr.write(
        `[process-lock] heartbeat failed (${heartbeatFailures}): ${(err as Error).message}\n`,
      );
      if (heartbeatFailures >= 2) {
        process.stderr.write(
          `[process-lock] lock dir unreachable after 2 attempts — exiting fail-closed\n`,
        );
        process.exit(2);
      }
    }
  }, opts.heartbeatMs);
  return { path: lockPath, ownerPath, heartbeat };
}

export function releaseLock(handle: LockHandle): void {
  clearInterval(handle.heartbeat);
  try {
    rmSync(handle.path, { recursive: true, force: true });
  } catch (err) {
    process.stderr.write(
      `[process-lock] releaseLock cleanup failed: ${(err as Error).message}\n`,
    );
  }
}
