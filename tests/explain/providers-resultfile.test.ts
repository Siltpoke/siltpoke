/**
 * Kernel-direct fd write for arch-run result files.
 *
 * The daemon-side drain coroutine (`drainToFile`) is replaced with a
 * kernel-direct fd: `Bun.spawn({ stdout: fd })` so the CHILD writes its own
 * output directly to the file. When the daemon dies mid-run the child keeps its
 * dup of the fd and finishes writing — the paid result is never lost regardless
 * of daemon liveness.
 *
 * Two test suites:
 *   1. spawnArchToFile — low-level fd-spawn helper (stub argv).
 *   2. makeArchBrainProvider — end-to-end provider integration (stub `claude`).
 */
import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, closeSync, existsSync, mkdtempSync, openSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeArchBrainProvider, spawnArchToFile } from "../../src/explain/providers";

// ─── helpers ────────────────────────────────────────────────────────────────

const ORIG_PATH = process.env.PATH;
const tmps: string[] = [];
afterEach(() => {
  process.env.PATH = ORIG_PATH;
  for (const d of tmps.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** A fake `claude` that emits the `--output-format json` stream shape we parse. */
function stubClaude(jsonEvents: unknown): string {
  const dir = mkdtempSync(join(tmpdir(), "stub-claude-"));
  tmps.push(dir);
  const payload = JSON.stringify(jsonEvents).replaceAll("'", "'\\''");
  // Drain stdin so the producer's stdin.end() doesn't EPIPE, then print JSON.
  writeFileSync(join(dir, "claude"), `#!/bin/sh\ncat >/dev/null\nprintf '%s' '${payload}'\n`);
  chmodSync(join(dir, "claude"), 0o755);
  return dir;
}

const FAKE_STREAM = [
  {
    type: "result",
    result: "the answer",
    total_cost_usd: 0.0123,
    usage: { input_tokens: 100, output_tokens: 50, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
  },
];

// ─── Suite 1: spawnArchToFile ────────────────────────────────────────────────

describe("spawnArchToFile — kernel-direct fd write", () => {
  test("child writes result file kernel-direct (daemon does not drain)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "q4-fd-"));
    tmps.push(dir);
    const out = join(dir, "task-1.out");
    const { proc } = spawnArchToFile(
      ["bash", "-c", "printf 'CHUNK_A'; sleep 0.05; printf 'CHUNK_B'"],
      { resultFilePath: out },
    );
    await proc.exited;
    expect(existsSync(out)).toBe(true);
    expect(readFileSync(out, "utf8")).toBe("CHUNK_ACHUNK_B");
  });

  test("result file completes even if the parent never reads the pipe", async () => {
    const dir = mkdtempSync(join(tmpdir(), "q4-fd-"));
    tmps.push(dir);
    const out = join(dir, "task-2.out");
    const { proc } = spawnArchToFile(
      ["bash", "-c", "printf 'L1\\n'; sleep 0.2; printf 'L2_LATE\\n'"],
      { resultFilePath: out },
    );
    await proc.exited;
    expect(readFileSync(out, "utf8")).toBe("L1\nL2_LATE\n");
  });

  test("Finding 1 regression: result-file fd is closed on Bun.spawn throw (no fd leak)", () => {
    // Bun.spawn throws synchronously for a missing binary
    // ("Executable not found in $PATH"). Confirmed: the throw IS synchronous on
    // Bun 1.x — see test output for "spawn THREW synchronously".
    // Before the fix, openSync ran but closeSync never ran → fd leaked.
    // After the fix, the catch block closes the fd before re-throwing.
    //
    // To assert fd-closure indirectly: open a sentinel fd BEFORE the throw,
    // trigger the throw, open another sentinel fd AFTER. If the leaked fd was
    // consuming fd slots the post-throw sentinel would have a higher fd number
    // than (pre-throw sentinel + 1). After the fix both sentinels are adjacent
    // (or very close), proving no fd was leaked between them.
    //
    // Note: this is a probabilistic heuristic — if the OS reuses the closed fd
    // immediately (which it will under normal conditions) the post-throw sentinel
    // gets fd == pre-sentinel + 1.  A leaked fd would shift it by +2 (one for the
    // leaked result-file fd + one for the spawner internal fds). In practice the
    // adjacency check reliably detects the regression in a single-threaded test.
    const dir = mkdtempSync(join(tmpdir(), "q4-fd-leak-"));
    tmps.push(dir);
    const resultFilePath = join(dir, "should-be-cleaned.out");

    // sentinel BEFORE
    const sentinelA = openSync("/dev/null", "r");

    // trigger the throw — binary does not exist
    expect(() =>
      spawnArchToFile(["definitely-not-a-real-binary-xyz-abc"], { resultFilePath }),
    ).toThrow();

    // sentinel AFTER
    const sentinelB = openSync("/dev/null", "r");

    // If the fd was leaked: sentinelB > sentinelA + 1 (leaked fd sits between them).
    // After the fix: sentinelB === sentinelA + 1 (OS reused the closed slot).
    // Allow a slack of +1 for Bun internals, but not +2 (which would indicate a leak).
    const gap = sentinelB - sentinelA;
    // Clean up sentinels
    closeSync(sentinelA);
    closeSync(sentinelB);
    expect(gap).toBeLessThanOrEqual(1); // fd was closed — reused immediately
  });
});

// ─── Suite 2: makeArchBrainProvider (end-to-end integration) ────────────────

describe("claude -p provider — per-task result file", () => {
  test("stdout is written to the result file AND readable after the in-memory result is dropped", async () => {
    const stubDir = stubClaude(FAKE_STREAM);
    process.env.PATH = `${stubDir}:${ORIG_PATH}`;
    const tasksDir = mkdtempSync(join(tmpdir(), "siltpoke-tasks-"));
    tmps.push(tasksDir);
    const resultFilePath = join(tasksDir, "task-xyz.out");

    const provider = makeArchBrainProvider();
    const { markdown, usage } = await provider({
      systemPrompt: "s",
      contextBundle: "c",
      resultFilePath,
    });
    // in-memory path still works (back-compat) ...
    expect(markdown).toBe("the answer");
    expect(usage.total_cost_usd).toBe(0.0123);

    // ... AND the raw stdout was written to the file by the child (kernel-direct).
    // Simulate daemon death: we hold ONLY the file now. Parsing it recovers the
    // same paid result.
    const fileBytes = readFileSync(resultFilePath, "utf8");
    const events = JSON.parse(fileBytes) as Array<{ type?: string; result?: string; total_cost_usd?: number }>;
    const final = events.reverse().find((e) => e.type === "result");
    expect(final!.result).toBe("the answer");
    expect(final!.total_cost_usd).toBe(0.0123);
  });

  test("signal + resultFilePath together (production combo: detached child + wired never-aborted signal) still completes + writes the file", async () => {
    // The production daemon call passes BOTH `signal: controller.signal` AND a
    // `resultFilePath` → spawnOpts carries `signal` + `killSignal:"SIGTERM"` +
    // `detached:true` simultaneously. This proves the combo doesn't break normal
    // completion.
    //
    // LIVE-SMOKE-REQUIRED: this test does NOT prove survival across the daemon
    // process exiting — a detached child outliving its parent + finishing + writing
    // its file is verified OUT-OF-BAND by the mandatory guided live-smoke step at
    // PR wrap-up, not by this in-suite test.
    const stubDir = stubClaude(FAKE_STREAM);
    process.env.PATH = `${stubDir}:${ORIG_PATH}`;
    const tasksDir = mkdtempSync(join(tmpdir(), "siltpoke-tasks-"));
    tmps.push(tasksDir);
    const resultFilePath = join(tasksDir, "task-combo.out");

    const provider = makeArchBrainProvider();
    // A real AbortController that is NEVER aborted — exactly the live (non-cancelled)
    // production path: the signal is wired but the run completes normally.
    const { markdown, usage } = await provider({
      systemPrompt: "s",
      contextBundle: "c",
      signal: new AbortController().signal,
      resultFilePath,
    });
    // (a) the in-memory result is returned normally despite signal + detached
    expect(markdown).toBe("the answer");
    expect(usage.total_cost_usd).toBe(0.0123);
    // (b) the .out file was written to completion by the child (kernel-direct)
    const fileBytes = readFileSync(resultFilePath, "utf8");
    const events = JSON.parse(fileBytes) as Array<{ type?: string; result?: string; total_cost_usd?: number }>;
    const final = events.reverse().find((e) => e.type === "result");
    expect(final!.result).toBe("the answer");
    expect(final!.total_cost_usd).toBe(0.0123);
  });

  test("no resultFilePath → byte-identical legacy behavior (no file written, result in memory)", async () => {
    const stubDir = stubClaude(FAKE_STREAM);
    process.env.PATH = `${stubDir}:${ORIG_PATH}`;
    const provider = makeArchBrainProvider();
    const { markdown } = await provider({ systemPrompt: "s", contextBundle: "c" });
    expect(markdown).toBe("the answer"); // CLI path unchanged
  });
});
