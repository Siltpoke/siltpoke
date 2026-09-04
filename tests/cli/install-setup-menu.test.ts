// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
// Copyright (c) 2026 Jiaqi Duan
import { describe, expect, test } from "bun:test";
import { runInstall } from "../../src/cli/install";

// Safety stub: if any test in this file explicitly accepts the autostart
// question, this stub keeps it from dispatching the REAL platform installer
// (launchctl!) on dev machines — mirrors the noopAutostart pattern in
// tests/cli/install.test.ts. (Prompt now defaults to "no" as of 2026-07-18,
// when the daemon became opt-in, so an accept-defaults fake IO no longer installs
// autostart on its own — this stub is belt-and-suspenders.)
const noopAutostart = async () =>
  ({ status: "skipped", platform: "test" }) as const;

describe("runInstall interactive setup menu (registry-driven, Task 4)", () => {
  test("bun run setup (interactive) offers + wires codebuddy when its binary is present", async () => {
    const { mkdtempSync, mkdirSync, writeFileSync, existsSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const home = mkdtempSync(join(tmpdir(), "setup-menu-"));
    mkdirSync(join(home, ".claude"), { recursive: true });
    writeFileSync(join(home, ".claude", "settings.json"), "{}");
    mkdirSync(join(home, ".codebuddy"), { recursive: true });
    const repoRoot = process.cwd();
    const exec = ((_cmd: string, args: string[]) => {
      const bin = args[args.length - 1];
      return { status: bin === "codebuddy" || bin === "claude" ? 0 : 1, stdout: "" };
    }) as unknown as import("../../src/installer/prereq").Exec;
    const io = { async readLine() { return ""; }, write() {} }; // accept defaults
    await runInstall({
      env: { HOME: home, CI: "true" } as NodeJS.ProcessEnv,
      repoRoot,
      noninteractive: false,
      exec,
      io,
      installAutostartFn: noopAutostart,
    });
    expect(existsSync(join(home, ".codebuddy", "settings.json"))).toBe(true);
  });
});
