// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
// Copyright (c) 2026 Jiaqi Duan
import { expect, test } from "bun:test";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cliVersionLookupFor } from "../../src/chat/cli-version";

test("asks each command once and keeps the first line", async () => {
  const calls: string[][] = [];
  const lookup = cliVersionLookupFor(undefined, {
    run: async (argv) => {
      calls.push(argv);
      return "qodercli 1.3.0\nmore text\n";
    },
  });
  expect(await lookup("qodercli")).toBe("qodercli 1.3.0");
  expect(await lookup("qodercli")).toBe("qodercli 1.3.0");
  expect(calls).toEqual([["qodercli", "--version"]]);
});

test("a runner that throws or prints nothing gives null", async () => {
  const throwing = cliVersionLookupFor(undefined, {
    run: async () => {
      throw new Error("ENOENT");
    },
  });
  expect(await throwing("nope")).toBeNull();
  expect(await cliVersionLookupFor(undefined, { run: async () => "  \n" })("blank")).toBeNull();
});

test("a runner that never answers gives null at the deadline, and later asks get null too (never a hang)", async () => {
  const lookup = cliVersionLookupFor(undefined, { run: () => new Promise<string | null>(() => {}), timeoutMs: 50 });
  const t0 = Date.now();
  expect(await lookup("stuck")).toBeNull();
  expect(Date.now() - t0).toBeLessThan(1_000);
  expect(await lookup("stuck")).toBeNull();
});

test("a real command that ignores the polite signal and keeps its output open is cut off", async () => {
  const dir = mkdtempSync(join(tmpdir(), "cli-version-stuck-"));
  try {
    // Ignores SIGTERM and leaves a background child holding stdout.
    writeFileSync(join(dir, "stuckagent"), "#!/bin/sh\ntrap '' TERM\n(sleep 5) &\nsleep 5\n");
    chmodSync(join(dir, "stuckagent"), 0o755);
    const t0 = Date.now();
    expect(await cliVersionLookupFor(dir, { timeoutMs: 200 })("stuckagent")).toBeNull();
    expect(Date.now() - t0).toBeLessThan(3_000);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the daemon's lookup finds a command in the folder it is given, and is the same lookup next time", async () => {
  const dir = mkdtempSync(join(tmpdir(), "cli-version-"));
  try {
    writeFileSync(join(dir, "fakeagent"), "#!/bin/sh\necho 'fakeagent 9.9.9'\n");
    chmodSync(join(dir, "fakeagent"), 0o755);
    expect(await cliVersionLookupFor(dir)("fakeagent")).toBe("fakeagent 9.9.9");
    expect(cliVersionLookupFor(dir)).toBe(cliVersionLookupFor(dir));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
