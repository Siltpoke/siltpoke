// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
// Copyright (c) 2026 Jiaqi Duan
/**
 * Defect [51]'s follow-ups (audit §117 "后续"). `[51]` bounded the READ after a
 * timeout; two waits were left:
 *
 * 1. An agent that ignores SIGTERM never exits, so `proc.exited` — and the
 *    drain waiting on it — never settles. The timeout sent one SIGTERM and
 *    nothing after it.
 * 2. Explain and the model-list refresh still read output "to the end", so a
 *    child holding the pipe held the call (the shape `[51]` fixed in reviews).
 *
 * Every test runs a REAL process. Bounds carry generous slack for a loaded machine.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { callBrainRaw } from "../../src/brain/brain";
import { stopProcess } from "../../src/brain/drain-process";
import { defaultRunner } from "../../src/brain/model-lists";
import { makeAgyProvider } from "../../src/brain/providers/agy";
import { makeCodeBuddyProvider, makeQoderProvider } from "../../src/brain/providers/ccfork-reviewer";
import { makeCodexProvider } from "../../src/brain/providers/codex";
import { makeDefaultBrainProvider } from "../../src/explain/providers";

const IGNORES_TERM = `trap '' TERM; sleep 8`;
const TIMEOUT_MS = 300;
/** Timeout + SIGKILL grace (2 s) + drain grace (2 s) + slack. Before: 8 s. */
const STUBBORN_BOUND_MS = 6_500;
/** A lingering child is cut by the drain grace alone. Before: 6 s. */
const LINGER_BOUND_MS = 4_000;

async function elapsedMs(call: () => Promise<unknown>): Promise<number> {
  const t0 = Date.now();
  await call().catch(() => undefined);
  return Date.now() - t0;
}

describe("stopProcess — SIGTERM, then SIGKILL if it is still running", () => {
  test("a process that ignores SIGTERM is gone shortly after the grace", async () => {
    const proc = Bun.spawn(["/bin/sh", "-c", IGNORES_TERM], { stdout: "ignore", stderr: "ignore" });
    await Bun.sleep(300); // let sh install the trap before it is signalled
    const t0 = Date.now();
    stopProcess(proc, 200);
    await proc.exited;
    expect(Date.now() - t0).toBeLessThan(3_000);
    expect(proc.signalCode).toBe("SIGKILL");
  }, 10_000);

  test("a process that exits on SIGTERM is not sent SIGKILL", async () => {
    const signals: unknown[] = [];
    stopProcess({ kill: (s?: unknown) => signals.push(s ?? "SIGTERM"), exited: Promise.resolve(0) }, 50);
    await Bun.sleep(150);
    expect(signals).toEqual(["SIGTERM"]);
  });

  test("a process handle without `exited` (a test double) is still sent SIGTERM", () => {
    const signals: unknown[] = [];
    stopProcess({ kill: (s?: unknown) => signals.push(s ?? "SIGTERM") }, 50);
    expect(signals).toEqual(["SIGTERM"]);
  });
});

/** Ignore the agent argv; run a shell that ignores SIGTERM. */
const stubborn = ((_argv: string[], opts: Parameters<typeof Bun.spawn>[1]) =>
  Bun.spawn(["/bin/sh", "-c", IGNORES_TERM], {
    ...(opts as object),
    cwd: mkdtempSync(join(tmpdir(), "siltpoke-stubborn-")),
  })) as unknown as typeof Bun.spawn;

const opts = {
  systemPrompt: "s",
  contextBundle: "c",
  timeoutMs: TIMEOUT_MS,
  spawnFn: stubborn,
  brainContext: { cwd: tmpdir() },
};

describe("a timed-out agent that ignores SIGTERM still returns", () => {
  for (const [name, call] of [
    ["claude", () => callBrainRaw(opts as never)],
    ["codebuddy", () => makeCodeBuddyProvider().callRaw(opts as never)],
    ["qoder", () => makeQoderProvider().callRaw(opts as never)],
    ["codex", () => makeCodexProvider().callRaw(opts as never)],
    ["agy", () => makeAgyProvider().callRaw(opts as never)],
  ] as const) {
    test(name, async () => {
      expect(await elapsedMs(call)).toBeLessThan(STUBBORN_BOUND_MS);
    }, 15_000);
  }
});

describe("model-list refresh is bounded", () => {
  test("a CLI that ignores SIGTERM", async () => {
    expect(await elapsedMs(() => defaultRunner(["/bin/sh", "-c", IGNORES_TERM], TIMEOUT_MS))).toBeLessThan(
      STUBBORN_BOUND_MS,
    );
  }, 15_000);

  test("a CLI whose child holds stdout after it exits keeps what it printed", async () => {
    const t0 = Date.now();
    const res = await defaultRunner(["/bin/sh", "-c", "sleep 6 & echo model-a"], 5_000);
    expect(Date.now() - t0).toBeLessThan(LINGER_BOUND_MS);
    expect(res.stdout.trim()).toBe("model-a");
    expect(res.code).toBe(0);
  }, 15_000);
});

describe("explain is bounded when claude's child holds the pipes", () => {
  const ORIG_PATH = process.env.PATH;
  const dirs: string[] = [];
  afterEach(() => {
    process.env.PATH = ORIG_PATH;
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  test("file-output path: the answer is read from the file without waiting for the child", async () => {
    const dir = mkdtempSync(join(tmpdir(), "stub-claude-linger-fd-"));
    dirs.push(dir);
    writeFileSync(
      join(dir, "claude"),
      [
        "#!/bin/sh",
        "cat > /dev/null",
        // stdout is the result file here; the child holds stderr, the one pipe left.
        "sleep 6 &",
        `printf '%s' '{"type":"result","result":"from-file","usage":{"input_tokens":1,"output_tokens":1}}'`,
        "",
      ].join("\n"),
      "utf8",
    );
    chmodSync(join(dir, "claude"), 0o755);
    process.env.PATH = `${dir}:/usr/bin:/bin`;
    const t0 = Date.now();
    const out = await makeDefaultBrainProvider()({
      systemPrompt: "s",
      contextBundle: "c",
      cwd: dir,
      resultFilePath: join(dir, "result.json"),
      platform: "darwin",
    });
    expect(Date.now() - t0).toBeLessThan(LINGER_BOUND_MS);
    expect(JSON.stringify(out)).toContain("from-file");
  }, 15_000);

  test("the answer comes back without waiting for the child", async () => {
    const dir = mkdtempSync(join(tmpdir(), "stub-claude-linger-"));
    dirs.push(dir);
    writeFileSync(
      join(dir, "claude"),
      [
        "#!/bin/sh",
        "cat > /dev/null",
        "sleep 6 &",
        `printf '%s' '{"type":"result","result":"ok","usage":{"input_tokens":1,"output_tokens":1}}'`,
        "",
      ].join("\n"),
      "utf8",
    );
    chmodSync(join(dir, "claude"), 0o755);
    process.env.PATH = `${dir}:/usr/bin:/bin`;
    const t0 = Date.now();
    const out = await makeDefaultBrainProvider()({ systemPrompt: "s", contextBundle: "c", cwd: dir, platform: "darwin" });
    expect(Date.now() - t0).toBeLessThan(LINGER_BOUND_MS);
    expect(JSON.stringify(out)).toContain("ok");
  }, 15_000);
});
