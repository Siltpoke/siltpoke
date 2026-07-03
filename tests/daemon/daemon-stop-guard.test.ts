/**
 * Daemon stop active-task drain guard.
 *
 * Tests the `checkActiveTask` helper (injectable fetch seam) that `cmdStop`
 * consults before sending SIGTERM.  No real daemon is started; fetch is always
 * mocked.
 *
 * Scenarios:
 *   1. running task present → checkActiveTask returns { block: true, task }
 *   2. no task / task done → checkActiveTask returns { block: false }
 *   3. daemon unreachable (fetch throws) → { block: false }  (fail-open)
 *   4. fetch timeout (AbortError) → { block: false }         (fail-open)
 *   5. malformed / non-200 response → { block: false }       (fail-open)
 *
 * The full stop-CLI-integration cases (--force, non-zero exit, warning text)
 * are covered by the exported `runStopWithGuard` helper which wires
 * checkActiveTask + kill together in a testable way.
 */
import { describe, expect, test } from "bun:test";
import {
  checkActiveTask,
  runStopWithGuard,
  type ActiveTaskCheckResult,
  type FetchFn,
} from "../../src/cli/daemon-stop-guard";

// ── helpers ─────────────────────────────────────────────────────────────────

function makeFetch(body: unknown, status = 200): FetchFn {
  return async (_url, _init) =>
    new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    });
}

function makeFetchThrows(err: Error): FetchFn {
  return async () => {
    throw err;
  };
}

const RUNNING_TASK = {
  id: "t1",
  kind: "arch_generate",
  repo: "abc123",
  status: "running",
  startedTs: new Date(Date.now() - 90_000).toISOString(), // 90 s ago
};

const DONE_TASK = { ...RUNNING_TASK, status: "done" };

// ── checkActiveTask unit tests ─────────────────────────────────────────────

describe("checkActiveTask", () => {
  test("running task → block=true with task data", async () => {
    const fetch = makeFetch({ success: true, data: { task: RUNNING_TASK }, error: null });
    const result = await checkActiveTask("http://127.0.0.1:19999", fetch);
    expect(result.block).toBe(true);
    if (!result.block) throw new Error("unreachable");
    expect(result.task.status).toBe("running");
    expect(result.task.kind).toBe("arch_generate");
    expect(result.task.repo).toBe("abc123");
    expect(typeof result.task.startedAgoMs).toBe("number");
    expect(result.task.startedAgoMs).toBeGreaterThan(0);
  });

  test("no task (data.task null) → block=false", async () => {
    const fetch = makeFetch({ success: true, data: { task: null }, error: null });
    const result = await checkActiveTask("http://127.0.0.1:19999", fetch);
    expect(result.block).toBe(false);
  });

  test("task with done status → block=false", async () => {
    const fetch = makeFetch({ success: true, data: { task: DONE_TASK }, error: null });
    const result = await checkActiveTask("http://127.0.0.1:19999", fetch);
    expect(result.block).toBe(false);
  });

  test("daemon unreachable (fetch throws ECONNREFUSED) → fail-open block=false", async () => {
    const err = Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" });
    const fetch = makeFetchThrows(err);
    const result = await checkActiveTask("http://127.0.0.1:19999", fetch);
    expect(result.block).toBe(false);
  });

  test("fetch timeout (AbortError) → fail-open block=false", async () => {
    const err = new DOMException("The operation was aborted", "AbortError");
    const fetch = makeFetchThrows(err);
    const result = await checkActiveTask("http://127.0.0.1:19999", fetch);
    expect(result.block).toBe(false);
  });

  test("non-200 response → fail-open block=false", async () => {
    const fetch = makeFetch({ success: false, error: "daemon error" }, 500);
    const result = await checkActiveTask("http://127.0.0.1:19999", fetch);
    expect(result.block).toBe(false);
  });

  test("malformed JSON body → fail-open block=false", async () => {
    const fetch: FetchFn = async () =>
      new Response("not json at all", { status: 200, headers: { "content-type": "text/plain" } });
    const result = await checkActiveTask("http://127.0.0.1:19999", fetch);
    expect(result.block).toBe(false);
  });
});

// ── runStopWithGuard integration tests ────────────────────────────────────

describe("runStopWithGuard", () => {
  test("running task, no --force → exits non-zero, stderr mentions --force and 'running'", async () => {
    const fetch = makeFetch({ success: true, data: { task: RUNNING_TASK }, error: null });
    const killed: number[] = [];
    const stderrLines: string[] = [];

    const exitCode = await runStopWithGuard({
      pid: 42,
      force: false,
      baseUrl: "http://127.0.0.1:19999",
      fetchFn: fetch,
      kill: (pid, _sig) => { killed.push(pid); },
      stderr: (msg) => { stderrLines.push(msg); },
      stdout: () => {},
    });

    expect(exitCode).not.toBe(0);
    expect(killed).toHaveLength(0); // SIGTERM NOT sent
    const combined = stderrLines.join("\n");
    expect(combined).toMatch(/--force/);
    expect(combined).toMatch(/running/i);
  });

  test("running task, --force → kill is called, exits 0, fetch is never called", async () => {
    let fetchCallCount = 0;
    const fetch: FetchFn = async (url, init) => {
      fetchCallCount++;
      return makeFetch({ success: true, data: { task: RUNNING_TASK }, error: null })(url, init);
    };
    const killed: number[] = [];

    const exitCode = await runStopWithGuard({
      pid: 42,
      force: true,
      baseUrl: "http://127.0.0.1:19999",
      fetchFn: fetch,
      kill: (pid, _sig) => { killed.push(pid); },
      stderr: () => {},
      stdout: () => {},
    });

    expect(exitCode).toBe(0);
    expect(killed).toContain(42);
    expect(fetchCallCount).toBe(0); // --force must skip the guard fetch entirely
  });

  test("no active task → kill is called normally (exits 0)", async () => {
    const fetch = makeFetch({ success: true, data: { task: null }, error: null });
    const killed: number[] = [];

    const exitCode = await runStopWithGuard({
      pid: 42,
      force: false,
      baseUrl: "http://127.0.0.1:19999",
      fetchFn: fetch,
      kill: (pid, _sig) => { killed.push(pid); },
      stderr: () => {},
      stdout: () => {},
    });

    expect(exitCode).toBe(0);
    expect(killed).toContain(42);
  });

  test("daemon unreachable → kill is called (fail-open, exits 0)", async () => {
    const err = Object.assign(new Error("ECONNREFUSED"), { code: "ECONNREFUSED" });
    const fetch = makeFetchThrows(err);
    const killed: number[] = [];

    const exitCode = await runStopWithGuard({
      pid: 42,
      force: false,
      baseUrl: "http://127.0.0.1:19999",
      fetchFn: fetch,
      kill: (pid, _sig) => { killed.push(pid); },
      stderr: () => {},
      stdout: () => {},
    });

    expect(exitCode).toBe(0);
    expect(killed).toContain(42);
  });

  test("fetch timeout → kill is called (fail-open, exits 0)", async () => {
    const err = new DOMException("aborted", "AbortError");
    const fetch = makeFetchThrows(err);
    const killed: number[] = [];

    const exitCode = await runStopWithGuard({
      pid: 42,
      force: false,
      baseUrl: "http://127.0.0.1:19999",
      fetchFn: fetch,
      kill: (pid, _sig) => { killed.push(pid); },
      stderr: () => {},
      stdout: () => {},
    });

    expect(exitCode).toBe(0);
    expect(killed).toContain(42);
  });
});
