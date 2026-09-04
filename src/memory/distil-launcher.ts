// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
import { basename, join } from "node:path";
import { readPending, pendingQueuePath } from "./pending-queue";
import { isLockHeld } from "../utils/process-lock";

export interface LaunchDeps {
  spawnFn?: (argv: string[]) => void;
  isLockHeldFn?: (lockPath: string) => boolean;
  workerPath?: string;
  lockPath?: string;
}

function defaultSpawn(argv: string[]): void {
  // Detached + SILTPOKE_INTERNAL so the worker survives hook teardown and its
  // own reflection subprocess is recursion-guarded (mirrors src/explain/providers.ts).
  const proc = Bun.spawn(argv, {
    stdin: "ignore",
    stdout: "ignore",
    stderr: "ignore",
    env: { ...process.env, SILTPOKE_INTERNAL: "1" },
    detached: true,
  });
  proc.unref();
}

/**
 * In-hook launcher — the ONLY Build-2 write-path work that runs inside a Stop /
 * SessionStart hook. Zero LLM, zero queue mutation: if the pending queue is
 * non-empty and no worker holds the global lock, spawn ONE detached worker and
 * return immediately. A spawn failure is swallowed (must never break the hook).
 */
export async function maybeLaunchDistilWorker(
  homeBase: string, stateBase: string, cwd: string, deps: LaunchDeps = {},
): Promise<{ launched: boolean; reason?: "empty" | "locked" }> {
  const spawnFn = deps.spawnFn ?? defaultSpawn;
  const isHeld = deps.isLockHeldFn ?? isLockHeld;
  const lockPath = deps.lockPath ?? join(homeBase, "distil-worker.lock");
  // The default worker path must resolve differently depending on how THIS
  // launcher module itself is currently running, because it ships two ways:
  //   - BUNDLED: esbuild inlines this file into dist/siltpoke-stop.js, so
  //     import.meta.dir is .../dist and the compiled worker sits right next
  //     to it as dist/siltpoke-distil.js.
  //   - SOURCE: fork-host installs (src/installer/host-adapter.ts) wire the
  //     Stop hook as `bun <repoRoot>/src/hooks/on-stop.ts`, run straight from
  //     source. There import.meta.dir is .../src/memory, which has no sibling
  //     siltpoke-distil.js — the worker entry point instead lives at
  //     src/hooks/on-distil-worker.ts (bun runs .ts directly, no build step).
  const workerPath =
    deps.workerPath ??
    (basename(import.meta.dir) === "dist"
      ? join(import.meta.dir, "siltpoke-distil.js")
      : join(import.meta.dir, "..", "hooks", "on-distil-worker.ts"));

  const entries = await readPending(pendingQueuePath(stateBase));
  if (entries.length === 0) return { launched: false, reason: "empty" };
  if (isHeld(lockPath)) return { launched: false, reason: "locked" };

  try {
    spawnFn(["bun", workerPath, "--home", homeBase, "--state", stateBase, "--cwd", cwd]);
    return { launched: true };
  } catch {
    return { launched: false };
  }
}
