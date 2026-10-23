// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
// Copyright (c) 2026 Jiaqi Duan
//
// Defect [53]: a pet that existed before agy's plugin was installed never
// reached agy's statusline. The Stop hook now wires it once config.json exists.
// Runs the real hooks/agy-stop.sh against a temp HOME; never touches ~/.gemini.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AGY_HINT_TEXT } from "../../src/hooks/agy-setup-hint";
import { isOurAgyStatusLine } from "../../src/installer/agy-statusline";

const REPO = process.cwd();
const SHELL = existsSync("/bin/dash") ? "/bin/dash" : "sh";

let home: string;
let settingsPath: string;
let marker: string;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "siltpoke-agy-wire-"));
  settingsPath = join(home, ".gemini", "antigravity-cli", "settings.json");
  marker = join(home, ".siltpoke", ".agy-pet-wired");
});
afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

function runHook(extra: Record<string, string> = {}) {
  const env: Record<string, string | undefined> = { ...process.env, HOME: home, ANTIGRAVITY_PLUGIN_ROOT: REPO };
  for (const k of ["SILTPOKE_HOME", "ANTIGRAVITY_HOME", "GEMINI_HOME", "ANTIGRAVITY_HOOKS_HOME"]) delete env[k];
  Object.assign(env, extra);
  return Bun.spawnSync([SHELL, join(REPO, "hooks", "agy-stop.sh")], {
    env,
    stdin: new TextEncoder().encode('{"session_id":"agy-wire"}'),
  });
}

function writeSettings(obj: unknown): void {
  mkdirSync(join(home, ".gemini", "antigravity-cli"), { recursive: true });
  writeFileSync(settingsPath, `${JSON.stringify(obj, null, 2)}\n`);
}
function readSettings(): Record<string, unknown> {
  return JSON.parse(readFileSync(settingsPath, "utf8")) as Record<string, unknown>;
}
function haveConfig(): void {
  mkdirSync(join(home, ".siltpoke"), { recursive: true });
  writeFileSync(join(home, ".siltpoke", "config.json"), "{}");
}
function statusCommand(): string {
  return (readSettings().statusLine as { command: string }).command;
}

describe("existing pet reaches agy's statusline", () => {
  test("config.json exists + no statusLine: wired to the pet command (not the hint), other settings kept", () => {
    haveConfig();
    writeSettings({ colorScheme: "x" });
    runHook();
    const cmd = statusCommand();
    expect(cmd).toContain(join(REPO, "dist", "siltpoke-card.js"));
    expect(cmd).toContain("--agent antigravity");
    expect(cmd).not.toContain(AGY_HINT_TEXT);
    expect(isOurAgyStatusLine(cmd)).toBe(true);
    expect(readSettings().colorScheme).toBe("x");
    expect(existsSync(marker)).toBe(true);
  });

  test("config.json exists + no settings.json at all: file is created with the pet", () => {
    haveConfig();
    runHook();
    expect(statusCommand()).toContain("siltpoke-card.js");
  });

  test("config.json exists + the old [34] hint in the slot: the hint is replaced by the pet", () => {
    haveConfig();
    writeSettings({});
    rmSync(join(home, ".siltpoke", "config.json"));
    runHook(); // no config: [34] hint wired
    expect(statusCommand()).toContain(AGY_HINT_TEXT);
    rmSync(marker, { force: true });
    haveConfig();
    runHook();
    expect(statusCommand()).toContain("siltpoke-card.js");
    expect(statusCommand()).not.toContain(AGY_HINT_TEXT);
  });

  test("the user's own statusLine is left byte-identical, and not re-examined every turn", () => {
    haveConfig();
    writeSettings({ statusLine: { type: "command", command: "echo mine" } });
    const before = readFileSync(settingsPath);
    runHook();
    expect(readFileSync(settingsPath).equals(before)).toBe(true);
    expect(existsSync(marker)).toBe(true); // marked: no bun start on later turns
  });

  test("already the pet: no write (mtime unchanged) on a repeat turn", () => {
    haveConfig();
    writeSettings({});
    runHook();
    const old = new Date(Date.now() - 3_600_000);
    utimesSync(settingsPath, old, old);
    rmSync(marker, { force: true }); // force the wiring to be re-examined
    const before = readFileSync(settingsPath);
    runHook();
    expect(statSync(settingsPath).mtimeMs).toBe(old.getTime());
    expect(readFileSync(settingsPath).equals(before)).toBe(true);
  });

  test("once marked, a pet the user deleted is not put back", () => {
    haveConfig();
    writeSettings({});
    runHook();
    const s = readSettings();
    delete s.statusLine;
    writeSettings(s);
    runHook();
    expect(readSettings().statusLine).toBeUndefined();
  });

  test("unparseable settings.json: untouched, and retried (not marked) once fixed", () => {
    haveConfig();
    mkdirSync(join(home, ".gemini", "antigravity-cli"), { recursive: true });
    writeFileSync(settingsPath, "{ not json");
    runHook();
    expect(readFileSync(settingsPath, "utf8")).toBe("{ not json");
    expect(existsSync(marker)).toBe(false);
    writeSettings({ colorScheme: "x" });
    runHook();
    expect(statusCommand()).toContain("siltpoke-card.js");
  });

  test("a non-object settings.json ([]) is untouched", () => {
    haveConfig();
    mkdirSync(join(home, ".gemini", "antigravity-cli"), { recursive: true });
    writeFileSync(settingsPath, "[]");
    runHook();
    expect(readFileSync(settingsPath, "utf8")).toBe("[]");
  });

  test("a symlinked settings.json stays a symlink and is never written", () => {
    haveConfig();
    const real = join(home, "dotfiles-settings.json");
    writeFileSync(real, `${JSON.stringify({ colorScheme: "x" }, null, 2)}\n`);
    mkdirSync(join(home, ".gemini", "antigravity-cli"), { recursive: true });
    symlinkSync(real, settingsPath);
    const before = readFileSync(real);
    runHook();
    expect(lstatSync(settingsPath).isSymbolicLink()).toBe(true);
    expect(readFileSync(real).equals(before)).toBe(true);
    expect(existsSync(marker)).toBe(true); // will not change: stop retrying
  });

  test("no-agy (no card under the plugin root) is not marked: retried once the card exists", () => {
    haveConfig();
    writeSettings({});
    const emptyRoot = mkdtempSync(join(tmpdir(), "siltpoke-agy-noroot-"));
    try {
      // hooks/agy-stop.sh needs dist/agy-stop.js under the root, so call the CLI directly.
      Bun.spawnSync(["bun", join(REPO, "dist", "agy-stop.js"), "--wire-pet", emptyRoot], {
        env: { ...process.env, HOME: home, SILTPOKE_HOME: "" },
        stdin: "ignore",
      });
    } finally {
      rmSync(emptyRoot, { recursive: true, force: true });
    }
    expect(readSettings().statusLine).toBeUndefined();
    expect(existsSync(marker)).toBe(false);
  });

  test("no config.json: the [34] hint is unchanged and no pet is wired", () => {
    writeSettings({ colorScheme: "x" });
    runHook();
    expect(statusCommand()).toContain(AGY_HINT_TEXT);
    expect(statusCommand()).not.toContain("siltpoke-card.js");
    expect(existsSync(marker)).toBe(false);
  });
});

describe("SILTPOKE_HOME is honoured by the shell and the marker alike", () => {
  test("marker lands where the shell looks, and the second turn does not start bun", () => {
    const custom = join(home, "custom-siltpoke");
    mkdirSync(custom, { recursive: true });
    writeFileSync(join(custom, "config.json"), "{}");
    writeSettings({});
    // A bun that logs each call, then runs the real one.
    const stubDir = join(home, "stub");
    const log = join(home, "bun-calls.log");
    mkdirSync(stubDir);
    writeFileSync(join(stubDir, "bun"), `#!/bin/sh\necho "$@" >> '${log}'\nexec '${process.execPath}' "$@"\n`, { mode: 0o755 });
    const env = { SILTPOKE_HOME: custom, PATH: `${stubDir}:${process.env.PATH}` };
    const wireCalls = () =>
      existsSync(log) ? readFileSync(log, "utf8").split("\n").filter((l) => l.includes("--wire-pet")).length : 0;

    runHook(env);
    expect(statusCommand()).toContain("siltpoke-card.js");
    expect(existsSync(join(custom, ".agy-pet-wired"))).toBe(true);
    expect(existsSync(join(home, ".siltpoke", ".agy-pet-wired"))).toBe(false);
    expect(wireCalls()).toBe(1);

    runHook(env);
    expect(wireCalls()).toBe(1);
  });

  test("[34] hint path with SILTPOKE_HOME set: a config at the default location does not count", () => {
    const custom = join(home, "custom-siltpoke");
    mkdirSync(custom, { recursive: true });
    haveConfig();
    writeSettings({});
    runHook({ SILTPOKE_HOME: custom });
    expect(statusCommand()).toContain(AGY_HINT_TEXT);
    expect(statusCommand()).not.toContain("siltpoke-card.js");
  });
});
