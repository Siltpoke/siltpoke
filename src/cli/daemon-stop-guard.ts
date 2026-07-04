// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
// Copyright (c) 2026 Jiaqi Duan
/**
 * Daemon stop active-task drain guard.
 *
 * Exported helpers (injectable seams for testing):
 *   `checkActiveTask`   — queries GET /api/repo-graph/arch/task, returns whether
 *                         a paid run is in flight. Fail-open on any error.
 *   `runStopWithGuard`  — combines the check + kill; usable both by cmdStop and
 *                         by tests that inject a fake kill / fake fetch.
 *
 * Design:
 * - Fail-open on any fetch error, timeout, non-200, or bad JSON → proceed with
 *   stop so a wedged daemon is never un-stoppable.
 * - 1.5 s AbortSignal.timeout on the fetch → a hanging daemon can't hang the CLI.
 * - Only blocks on `status === "running"`; every terminal status (done, failed,
 *   cancelled, crashed) proceeds normally.
 */

/** Resolved task data when block=true. */
export interface ActiveTaskInfo {
  id: string;
  kind: string;
  repo: string;
  status: string;
  startedTs: string;
  /** Computed client-side: Date.now() − Date.parse(startedTs). */
  startedAgoMs: number;
}

export type ActiveTaskCheckResult =
  | { block: true; task: ActiveTaskInfo }
  | { block: false };

/** Minimal fetch interface — injectable for tests without needing Bun's `preconnect`. */
type FetchFn = (url: string, init?: RequestInit) => Promise<Response>;

/**
 * Query the running daemon's arch/task endpoint.
 *
 * Returns `{ block: true, task }` when a `status === "running"` task exists.
 * Returns `{ block: false }` on any error, non-running task, or absent task.
 *
 * **Intentionally global (no `?repo=` filter)**: the daemon is one-task-at-a-time
 * across ALL repos (`task-registry.ts` enforces this). If ANY paid arch-generate is
 * running — regardless of which repo — sending SIGTERM kills it. The guard is
 * therefore daemon-global, not per-repo. This matches the endpoint's documented
 * no-param behaviour: "no param keeps the global behavior for callers that really
 * want 'anything running on this daemon'" (repo-graph.tsx:691).
 *
 * @param baseUrl  e.g. `http://127.0.0.1:9876`
 * @param fetchFn  injectable for tests; defaults to global `fetch`
 */
export async function checkActiveTask(
  baseUrl: string,
  fetchFn: FetchFn = fetch,
): Promise<ActiveTaskCheckResult> {
  let res: Response;
  try {
    res = await fetchFn(`${baseUrl}/api/repo-graph/arch/task`, {
      signal: AbortSignal.timeout(1500),
    });
  } catch {
    // Unreachable, timeout, or ECONNREFUSED → fail-open.
    return { block: false };
  }

  if (!res.ok) return { block: false };

  let body: unknown;
  try {
    body = await res.json();
  } catch {
    return { block: false };
  }

  // Narrow: body must be { success: true, data: { task: { status, ... } } }
  if (
    typeof body !== "object" ||
    body === null ||
    (body as Record<string, unknown>).success !== true
  ) {
    return { block: false };
  }

  const data = (body as Record<string, unknown>).data as Record<string, unknown> | undefined;
  if (!data || typeof data !== "object") return { block: false };

  const task = data.task as Record<string, unknown> | null | undefined;
  if (!task || typeof task !== "object") return { block: false };

  if (task.status !== "running") return { block: false };

  // All required fields present?
  const id = task.id as string | undefined;
  const kind = task.kind as string | undefined;
  const repo = task.repo as string | undefined;
  const startedTs = task.startedTs as string | undefined;
  if (!id || !kind || !repo || !startedTs) return { block: false };

  const startedAgoMs = Date.now() - new Date(startedTs).getTime();
  if (!Number.isFinite(startedAgoMs)) return { block: false };

  return {
    block: true,
    task: { id, kind, repo, status: "running", startedTs, startedAgoMs },
  };
}

export interface StopWithGuardOpts {
  pid: number;
  force: boolean;
  baseUrl: string;
  fetchFn?: FetchFn;
  kill: (pid: number, signal: string) => void;
  stderr: (msg: string) => void;
  stdout: (msg: string) => void;
}

// Re-export FetchFn so tests can reference it without using typeof fetch.
export type { FetchFn };

/**
 * Core logic of `daemon stop` with the active-task guard wired in.
 *
 * Returns the intended exit code (0 = stop sent or not-needed, non-zero = blocked).
 * Does NOT call `process.exit` — the caller decides (so tests can inspect the
 * return value without the process dying).
 */
export async function runStopWithGuard(opts: StopWithGuardOpts): Promise<number> {
  const { pid, force, baseUrl, kill, stderr, stdout } = opts;
  const fetchFn = opts.fetchFn ?? fetch;

  if (!force) {
    const check = await checkActiveTask(baseUrl, fetchFn);
    if (check.block) {
      const t = check.task;
      const ago = formatAgo(t.startedAgoMs);
      stderr(
        `siltpoked: a paid arch-generate is running (repo=${t.repo}, kind=${t.kind}, started ${ago}).\n` +
          `Stopping now will SIGKILL the run — it will be ledgered as a failed estimate.\n` +
          `Use  siltpoked stop --force  to stop anyway.\n`,
      );
      return 1;
    }
  }

  try {
    kill(pid, "SIGTERM");
    stdout(`Sent SIGTERM to pid=${pid}\n`);
    return 0;
  } catch (err) {
    stderr(`siltpoked: failed to kill pid=${pid}: ${(err as Error).message}\n`);
    return 1;
  }
}

/** Format milliseconds as a human-readable "Xs" / "Xm Ys" string. */
function formatAgo(ms: number): string {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  const rem = s % 60;
  return rem > 0 ? `${m}m ${rem}s ago` : `${m}m ago`;
}
