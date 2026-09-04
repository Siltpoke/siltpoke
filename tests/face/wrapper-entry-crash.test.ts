// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
// Copyright (c) 2026 Jiaqi Duan
//
// Regression coverage for the statusline entry's total-function guarantee:
// no matter what fails mid-render, the CLI entry (src/face/wrapper.ts's
// `if (import.meta.main)` block) must exit 0 and print NOTHING to stdout or
// stderr. The shim (src/installer/shim.ts) uses `exec` to hand exit code and
// stdout straight through to the user's Claude Code status line — it cannot
// buffer the bundle's output to inspect it first without breaking streaming
// — so the bundle itself must never crash loudly.
//
// This exercises the class of fault installFaultNet() exists to catch: one
// that arrives OUTSIDE this file's own try/catch (a detached timer callback,
// or a fire-and-forget promise rejection) via SILTPOKE_TEST_FAULT, a
// test-only env seam mirroring SILTPOKE_TEST_MOCK_STREAM in
// src/daemon/server.ts — never set in real installs. A 20ms artificial delay
// (also gated on the same env var) makes the injected fault win the race
// against the real render, so the test proves behavior under a fault that
// genuinely arrives mid-flight, not one that loses to this process's own
// exit.
import { expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const WRAPPER = join(import.meta.dir, "../../src/face/wrapper.ts");

async function runWrapperSubprocess(
  home: string,
  env: Record<string, string> = {},
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const proc = Bun.spawn(["bun", WRAPPER], {
    env: { ...process.env, HOME: home, ...env },
    stdin: new Response(JSON.stringify({ cwd: "/tmp" })).body,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { exitCode, stdout, stderr };
}

function makeHome(): string {
  const home = mkdtempSync(join(tmpdir(), "wrapper-entry-crash-"));
  mkdirSync(join(home, ".siltpoke"), { recursive: true });
  writeFileSync(
    join(home, ".siltpoke", "config.json"),
    JSON.stringify({ name: "Pip", species: "slime" }),
  );
  return home;
}

test("control: with no injected fault, the entry still renders normally", async () => {
  const home = makeHome();
  const { exitCode, stdout, stderr } = await runWrapperSubprocess(home);
  expect(exitCode).toBe(0);
  expect(stdout).toContain("Pip");
  expect(stderr).toBe("");
});

test("unhandled promise rejection mid-render: exit 0, empty stdout, empty stderr", async () => {
  const home = makeHome();
  const { exitCode, stdout, stderr } = await runWrapperSubprocess(home, {
    SILTPOKE_TEST_FAULT: "unhandled-rejection",
  });
  expect(exitCode).toBe(0);
  expect(stdout).toBe("");
  expect(stderr).toBe("");
});

test("uncaught exception from a detached callback mid-render: exit 0, empty stdout, empty stderr", async () => {
  const home = makeHome();
  const { exitCode, stdout, stderr } = await runWrapperSubprocess(home, {
    SILTPOKE_TEST_FAULT: "uncaught-exception",
  });
  expect(exitCode).toBe(0);
  expect(stdout).toBe("");
  expect(stderr).toBe("");
});

test("fault is logged to disk (debuggable trace) even though nothing reaches the user", async () => {
  const home = makeHome();
  await runWrapperSubprocess(home, { SILTPOKE_TEST_FAULT: "uncaught-exception" });
  const logPath = join(home, ".siltpoke", "logs", "errors.log");
  expect(existsSync(logPath)).toBe(true);
  const contents = readFileSync(logPath, "utf8");
  expect(contents).toContain("FATAL uncaughtException");
});
