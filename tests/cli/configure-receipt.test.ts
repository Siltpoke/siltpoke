// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
// Copyright (c) 2026 Jiaqi Duan
// [61] PR 2, plan P1.3 (spec §2.3): the plugin path's `configure` records the
// status line and the daemon autostart in the install receipt, before it acts.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { configure, parseArgs } from "../../src/cli/configure";
import { readReceipt } from "../../src/installer/receipt";

let home: string;
let savedSiltpokeHome: string | undefined;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "siltpoke-conf-receipt-"));
  // configure() builds its env from process.env; a SILTPOKE_HOME in the developer's shell
  // would point the receipt (and everything else) at the real ~/.siltpoke (review M5).
  savedSiltpokeHome = process.env.SILTPOKE_HOME;
  delete process.env.SILTPOKE_HOME;
});
afterEach(() => {
  if (savedSiltpokeHome === undefined) delete process.env.SILTPOKE_HOME;
  else process.env.SILTPOKE_HOME = savedSiltpokeHome;
  rmSync(home, { recursive: true, force: true });
});

const env = (): NodeJS.ProcessEnv => ({ ...process.env, HOME: home });
const entry = (id: string) => readReceipt(env())?.entries.find((e) => e.id === id);
const args = (...extra: string[]) =>
  parseArgs(["--name", "S", "--species", "cat", "--lang", "en", "--personality", "sassy", ...extra]);
const quiet = { warn: () => {} };

function writeSettings(body: string): string {
  mkdirSync(join(home, ".claude"), { recursive: true });
  const p = join(home, ".claude", "settings.json");
  writeFileSync(p, body);
  return p;
}

describe("configure → receipt: status line", () => {
  test("--statusline records statusline:claude-code, done, pointing at settings.json and inner.txt", async () => {
    const settings = writeSettings(JSON.stringify({ statusLine: { type: "command", command: "starship prompt" } }));
    await configure(args("--statusline"), home, {
      ...quiet,
      installAutostart: async () => ({ status: "skipped", platform: "test" }),
    });
    expect(entry("statusline:claude-code")).toMatchObject({
      kind: "statusline",
      target: settings,
      byUs: true,
      state: "done",
      level: "uninstall",
      undo: { type: "restore-statusline", inner: join(home, ".siltpoke", "inner.txt") },
    });
  });

  test("no --statusline → nothing recorded for it, even with a settings.json present", async () => {
    writeSettings(JSON.stringify({ model: "x" }));
    await configure(args(), home, quiet);
    expect(entry("statusline:claude-code")).toBeUndefined();
  });

  test("no --statusline but the legacy Stop-hook sweep rewrites settings.json → still no status-line entry", async () => {
    writeSettings(
      JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: "command", command: "bun /old/siltpoke/src/hooks/on-stop.ts" }] }] } }),
    );
    await configure(args(), home, quiet);
    expect(entry("statusline:claude-code")).toBeUndefined();
  });

  test("an unparseable settings.json is left alone and nothing is recorded", async () => {
    writeSettings("{ not json");
    await configure(args("--statusline"), home, quiet);
    expect(entry("statusline:claude-code")).toBeUndefined();
  });
});

describe("configure → receipt: daemon autostart", () => {
  const onSupported = process.platform === "darwin" || process.platform === "linux";

  test.skipIf(!onSupported)("installed → launch-agent:daemon, done, byUs", async () => {
    await configure(args("--daemon"), home, {
      ...quiet,
      // No XDG_CONFIG_HOME: a CI runner sets one, and the expected path is the default.
      env: {},
      installAutostart: async () => ({ status: "installed", platform: process.platform }),
    });
    expect(entry("launch-agent:daemon")).toMatchObject({ kind: "launch-agent", byUs: true, state: "done", level: "uninstall" });
    // The unit path follows the install's home, never the real one (review I2).
    expect(entry("launch-agent:daemon")?.target).toBe(
      process.platform === "darwin"
        ? join(home, "Library", "LaunchAgents", "io.siltpoke.daemon.plist")
        : join(home, ".config", "systemd", "user", "siltpoked.service"),
    );
  });

  test.skipIf(!onSupported)("the installer throws → the entry stays pending, never done", async () => {
    await configure(args("--daemon"), home, {
      ...quiet,
      installAutostart: async () => {
        throw new Error("launchctl bootstrap failed");
      },
    });
    expect(entry("launch-agent:daemon")).toMatchObject({ state: "pending" });
  });

  test.skipIf(!onSupported)("the dispatcher declines → pending, not done", async () => {
    await configure(args("--daemon"), home, {
      ...quiet,
      installAutostart: async () => ({ status: "unavailable", platform: "x", module: "launchd" }),
    });
    expect(entry("launch-agent:daemon")).toMatchObject({ state: "pending" });
  });

  test("daemon not requested → nothing recorded", async () => {
    await configure(args(), home, quiet);
    expect(entry("launch-agent:daemon")).toBeUndefined();
  });
});
