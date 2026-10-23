// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
// Copyright (c) 2026 Jiaqi Duan
// [61] PR 2, plan P1.3 (spec §2.3): the source install records what it wires
// into other tools — the Claude Code status line + hooks, slash-command files,
// daemon autostart — in the install receipt, pending before and done after.
import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runInstall, symlinkCommands } from "../../src/cli/install";
import { readReceipt } from "../../src/installer/receipt";
import type { WizardIO } from "../../src/installer/wizard";

let tmp: string;
let env: NodeJS.ProcessEnv;
let repoRoot: string;
let cmdsDir: string;

const io = (answers: string[] = []): WizardIO => {
  let i = 0;
  return { readLine: async () => answers[i++] ?? "", write: () => {} };
};
const noOllama = async () => ({ enabled: false });
const noAutostart = async () => ({ status: "skipped", platform: "test" }) as const;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "siltpoke-install-receipt-"));
  mkdirSync(join(tmp, ".claude"), { recursive: true });
  writeFileSync(join(tmp, ".claude", "settings.json"), JSON.stringify({ statusLine: { type: "command", command: "starship prompt" } }));
  env = { HOME: tmp, CI: "true" };
  repoRoot = join(tmp, "repo");
  mkdirSync(join(repoRoot, ".claude-plugin", "commands"), { recursive: true });
  writeFileSync(join(repoRoot, ".claude-plugin", "commands", "siltpoke-fake.md"), "---\ndescription: fake\n---\nbody");
  cmdsDir = join(tmp, ".claude", "commands");
});
afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

const entry = (id: string) => readReceipt(env)?.entries.find((e) => e.id === id);
const run = (extra: Parameters<typeof runInstall>[0] = {}) =>
  runInstall({
    env,
    repoRoot,
    noninteractive: true,
    io: io(),
    presetAgents: ["claude-code"],
    setupOllamaFn: noOllama,
    installAutostartFn: noAutostart,
    ...extra,
  });

describe("runInstall → receipt", () => {
  test("Claude Code: status line and hooks recorded, done, pointing at settings.json", async () => {
    await run();
    const settings = join(tmp, ".claude", "settings.json");
    expect(entry("statusline:claude-code")).toMatchObject({ kind: "statusline", target: settings, byUs: true, state: "done" });
    expect(entry("hook:claude-code")).toMatchObject({
      kind: "host-hook",
      target: settings,
      byUs: true,
      state: "done",
      undo: { type: "remove-hook-entries", match: repoRoot },
    });
  });

  test("slash-command link recorded per file, ours, with where it points", async () => {
    await run();
    const dest = join(cmdsDir, "siltpoke-fake.md");
    expect(entry(`file:${dest}`)).toMatchObject({
      kind: "file",
      target: dest,
      byUs: true,
      state: "done",
      level: "uninstall",
      undo: { type: "remove-link", under: join(repoRoot, ".claude-plugin", "commands") },
    });
  });

  test("the local-model setup is handed the install's env, so its receipt entry lands in the same home", async () => {
    let seen: NodeJS.ProcessEnv | undefined;
    await run({
      setupOllamaFn: async (o) => {
        seen = o.env;
        return { enabled: false };
      },
    });
    expect(seen).toBe(env);
  });

  test("the user declining the install records nothing", async () => {
    await run({ noninteractive: false, io: io(["n"]), presetAgents: ["claude-code"] });
    expect(readReceipt(env)).toBeNull();
  });

  test("no settings.json and no secondary host → nothing wired, nothing recorded", async () => {
    rmSync(join(tmp, ".claude", "settings.json"));
    await run();
    expect(readReceipt(env)?.entries ?? []).toEqual([]);
  });

  test.skipIf(process.platform !== "darwin" && process.platform !== "linux")(
    "autostart accepted → launch-agent:daemon recorded, done",
    async () => {
      await run({
        noninteractive: false,
        io: io(["yes", "Mochi", "cat", "zh-CN", "1", "y"]), // proceed, 4 pet answers, autostart
        presetAgents: ["claude-code"],
        installAutostartFn: async () => ({ status: "installed", platform: process.platform }),
        platform: "linux", // keeps the menu-bar question out of the way
      });
      expect(entry("launch-agent:daemon")).toMatchObject({ kind: "launch-agent", state: "done" });
      // `platform` is honoured and the path follows the install's home (review I2).
      expect(entry("launch-agent:daemon")?.target).toBe(join(tmp, ".config", "systemd", "user", "siltpoked.service"));
    },
  );

  test("autostart question answered no → no launch-agent entry", async () => {
    await run({ noninteractive: false, io: io(["yes", "Mochi", "cat", "zh-CN", "1", "n"]), presetAgents: ["claude-code"], platform: "linux" });
    expect(entry("launch-agent:daemon")).toBeUndefined();
  });
});

describe("symlinkCommands → receipt", () => {
  const plugin = (): string => join(repoRoot, ".claude-plugin", "commands");
  const dest = (): string => join(cmdsDir, "siltpoke-fake.md");

  test("a command file that was there before and is not ours is recorded byUs false", async () => {
    mkdirSync(cmdsDir, { recursive: true });
    writeFileSync(dest(), "the user's own command");
    await symlinkCommands(plugin(), cmdsDir, "darwin", env);
    expect(entry(`file:${dest()}`)).toMatchObject({ byUs: false, state: "done" });
  });

  test("a stale link from an earlier siltpoke install (points into the plugin dir) is still ours", async () => {
    mkdirSync(cmdsDir, { recursive: true });
    symlinkSync(join(plugin(), "siltpoke-fake.md"), dest());
    await symlinkCommands(plugin(), cmdsDir, "darwin", env);
    expect(entry(`file:${dest()}`)).toMatchObject({ byUs: true });
  });

  test("a link pointing somewhere else is not ours", async () => {
    mkdirSync(cmdsDir, { recursive: true });
    writeFileSync(join(tmp, "elsewhere.md"), "x");
    symlinkSync(join(tmp, "elsewhere.md"), dest());
    await symlinkCommands(plugin(), cmdsDir, "darwin", env);
    expect(entry(`file:${dest()}`)).toMatchObject({ byUs: false });
  });

  test("win32 copies: the entry stores the content hash, not a link target", async () => {
    await symlinkCommands(plugin(), cmdsDir, "win32", env);
    const sha = createHash("sha256").update("---\ndescription: fake\n---\nbody").digest("hex");
    expect(entry(`file:${dest()}`)).toMatchObject({ byUs: true, state: "done", undo: { type: "remove-if-hash", sha256: sha } });
  });

  test("win32: a differing file already at the destination is not ours", async () => {
    mkdirSync(cmdsDir, { recursive: true });
    writeFileSync(dest(), "edited by the user");
    await symlinkCommands(plugin(), cmdsDir, "win32", env);
    expect(entry(`file:${dest()}`)).toMatchObject({ byUs: false });
  });

  test("non-.md files are not recorded", async () => {
    writeFileSync(join(plugin(), "notes.txt"), "x");
    await symlinkCommands(plugin(), cmdsDir, "darwin", env);
    expect(readReceipt(env)?.entries.map((e) => e.target)).toEqual([dest()]);
  });
});
