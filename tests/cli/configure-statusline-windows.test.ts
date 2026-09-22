// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
// Copyright (c) 2026 Jiaqi Duan
//
// Defect [10] at the level that actually broke: what `configure --statusline`
// WRITES into settings.json. The unit tests for the resolver live in
// tests/installer/statusline-interpreter.test.ts; this file asserts the wiring,
// because a resolver nothing calls fixes nothing.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { configure, parseArgs } from "../../src/cli/configure";

let home: string;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "siltpoke-statusline-win-"));
});
afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

const noAutostart = {
  installAutostart: async () => ({ status: "skipped" as const, platform: "test" }),
};

const args = parseArgs([
  "--name", "S", "--species", "slime", "--lang", "en",
  "--personality", "sassy", "--statusline",
]);

function writtenCommand(): string {
  const settings = JSON.parse(
    readFileSync(join(home, ".claude", "settings.json"), "utf8"),
  ) as { statusLine?: { command?: string } };
  return settings.statusLine?.command ?? "";
}

describe("configure --statusline on win32", () => {
  test("writes Git Bash, not the bare `sh` that never existed on Windows", async () => {
    await configure(args, home, {
      ...noAutostart,
      statuslineInterpreter: {
        platform: "win32",
        which: (b) => (b === "bash" ? "C:\\Program Files\\Git\\bin\\bash.exe" : null),
        exists: () => false,
      },
    });
    const command = writtenCommand();
    expect(command).toContain('"C:/Program Files/Git/bin/bash.exe"');
    expect(command).toContain("statusline.sh");
    expect(command.startsWith("sh ")).toBe(false);
  });

  test("warns, and still writes a Git Bash command, when no bash can be found", async () => {
    const warnings: string[] = [];
    await configure(args, home, {
      ...noAutostart,
      warn: (m) => warnings.push(m),
      statuslineInterpreter: {
        platform: "win32",
        which: () => null,
        exists: () => false,
      },
    });
    expect(writtenCommand()).toContain("bash.exe");
    expect(warnings.some((w) => w.includes("Git Bash"))).toBe(true);
  });
});

describe("configure --statusline on POSIX", () => {
  test("is unchanged — still the bare `sh <shim>` every existing install has", async () => {
    await configure(args, home, {
      ...noAutostart,
      statuslineInterpreter: {
        platform: "darwin",
        which: (b) => (b === "sh" ? "/bin/sh" : null),
        exists: () => false,
      },
    });
    const command = writtenCommand();
    expect(command.startsWith("sh ")).toBe(true);
    expect(command).toContain(join(home, ".siltpoke", "bin", "statusline.sh"));
  });
});
