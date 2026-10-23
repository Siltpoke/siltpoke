// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
// Copyright (c) 2026 Jiaqi Duan
/**
 * Defect [51] (audit §57.3, §60.1, §62.3): a review's diff-summary step ran 196
 * and 271 seconds although every agent call has a 90-second timeout.
 *
 * Every provider waited the same way: on timeout, kill the agent's process,
 * then read its stdout and stderr to the end. "The end" is when every holder of
 * the pipe has closed it — and an agent CLI that started a child of its own
 * leaves that child holding the pipe after the parent is killed. So the read
 * waited for the child, however long it lived, and the timeout bounded nothing.
 *
 * Each test spawns a REAL process whose background child keeps stdout open for
 * 6 seconds, with a 300 ms timeout. Before the fix every provider returned
 * after ~6 s; the promise is: within the timeout plus a short grace.
 */
import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { callBrainRaw } from "../../src/brain/brain";
import { makeAgyProvider } from "../../src/brain/providers/agy";
import { makeCodeBuddyProvider, makeQoderProvider } from "../../src/brain/providers/ccfork-reviewer";
import { makeCodexProvider } from "../../src/brain/providers/codex";

const CHILD_HOLDS_PIPE_S = 6;
const TIMEOUT_MS = 300;
/** Timeout + the grace the fix allows + generous slack for a loaded machine. */
const BOUND_MS = 4_000;

/** Ignore the agent argv; run a shell whose background child keeps the pipes open. */
const lingeringChild = ((_argv: string[], opts: Parameters<typeof Bun.spawn>[1]) =>
  Bun.spawn(["/bin/sh", "-c", `sleep ${CHILD_HOLDS_PIPE_S} & sleep ${CHILD_HOLDS_PIPE_S}`], {
    ...(opts as object),
    cwd: mkdtempSync(join(tmpdir(), "siltpoke-linger-")),
  })) as unknown as typeof Bun.spawn;

async function elapsedMs(call: () => Promise<unknown>): Promise<number> {
  const t0 = Date.now();
  await call().catch(() => undefined);
  return Date.now() - t0;
}

const opts = {
  systemPrompt: "s",
  contextBundle: "c",
  timeoutMs: TIMEOUT_MS,
  spawnFn: lingeringChild,
  brainContext: { cwd: tmpdir() },
};

describe("[51] a timed-out agent call returns within its timeout, not when a child lets go", () => {
  test("claude", async () => {
    expect(await elapsedMs(() => callBrainRaw(opts as never))).toBeLessThan(BOUND_MS);
  }, 15_000);

  test("codebuddy", async () => {
    expect(await elapsedMs(() => makeCodeBuddyProvider().callRaw(opts as never))).toBeLessThan(BOUND_MS);
  }, 15_000);

  test("qoder", async () => {
    expect(await elapsedMs(() => makeQoderProvider().callRaw(opts as never))).toBeLessThan(BOUND_MS);
  }, 15_000);

  test("codex", async () => {
    expect(await elapsedMs(() => makeCodexProvider().callRaw(opts as never))).toBeLessThan(BOUND_MS);
  }, 15_000);

  test("agy", async () => {
    expect(await elapsedMs(() => makeAgyProvider().callRaw(opts as never))).toBeLessThan(BOUND_MS);
  }, 15_000);
});

describe("[51] drainProcess keeps everything a normal process prints", () => {
  test("large stdout AND large stderr are both read whole (no stall on a full pipe)", async () => {
    const { drainProcess } = await import("../../src/brain/drain-process");
    // 200 KB on each stream: read one after the other, the unread pipe fills
    // (~64 KB) and the writer blocks forever. stderr is written FIRST, because
    // the old code read stdout first.
    const proc = Bun.spawn(
      ["/bin/sh", "-c", "head -c 204800 /dev/zero | tr '\\0' e >&2; head -c 204800 /dev/zero | tr '\\0' o; exit 3"],
      { stdout: "pipe", stderr: "pipe" },
    );
    const t0 = Date.now();
    const r = await drainProcess(proc);
    expect(Date.now() - t0).toBeLessThan(BOUND_MS);
    expect(r.exitCode).toBe(3);
    expect(r.stdout.length).toBe(204800);
    expect(r.stderr.length).toBe(204800);
    expect(r.stdout).toBe("o".repeat(204800));
  }, 15_000);

  test("output that arrives after the process exits, within the grace, is kept", async () => {
    const { drainProcess } = await import("../../src/brain/drain-process");
    const proc = Bun.spawn(["/bin/sh", "-c", "(sleep 0.3; printf late) & exit 0"], { stdout: "pipe", stderr: "pipe" });
    const r = await drainProcess(proc, 2_000);
    expect(r.stdout).toBe("late");
  }, 15_000);

  test("output written before a lingering child is not lost", async () => {
    const { drainProcess } = await import("../../src/brain/drain-process");
    const proc = Bun.spawn(["/bin/sh", "-c", "printf 'RESULT'; sleep 6 &"], { stdout: "pipe", stderr: "pipe" });
    const r = await drainProcess(proc, 300);
    expect(r.stdout).toBe("RESULT");
    expect(r.exitCode).toBe(0);
  }, 15_000);
});
