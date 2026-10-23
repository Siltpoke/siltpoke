import { test, expect, beforeEach, afterEach } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
  existsSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runInstall } from "../../src/cli/install";
import { runUninstall } from "../../src/cli/uninstall";
import type { AutostartUninstallResult } from "../../src/installer/autostart";
import type { WizardIO } from "../../src/installer/wizard";

let tmp: string;
let claudeHome: string;
let env: NodeJS.ProcessEnv;
let repoRoot: string;

// Install-heavy tests run a real install (copy files + write settings) and clock
// ~4s clean — under the 5000ms Bun default. Any concurrent load (full-suite run,
// a background model pull) tips them over → flaky timeout. Give them headroom.
const INSTALL_TIMEOUT_MS = 20_000;

function fakeIO(answers: string[]): WizardIO {
  let i = 0;
  return {
    async readLine() {
      return answers[i++] ?? "";
    },
    write(_s: string) {},
  };
}

function capturingIO(answers: string[]): { io: WizardIO; output: () => string } {
  let i = 0;
  let out = "";
  return {
    io: {
      async readLine() {
        return answers[i++] ?? "";
      },
      write(s: string) {
        out += s;
      },
    },
    output: () => out,
  };
}

// Every runUninstall call in this file injects a stub so tests NEVER touch the
// real machine's LaunchAgents / systemd user units.
const stubAutostartCleanup = async (): Promise<AutostartUninstallResult> => ({
  status: "not-installed",
  platform: "test",
});

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "siltpoke-uninst-"));
  claudeHome = join(tmp, ".claude");
  mkdirSync(claudeHome, { recursive: true });
  env = { HOME: tmp } as NodeJS.ProcessEnv;
  repoRoot = join(tmp, "repo");
  mkdirSync(join(repoRoot, ".claude-plugin", "commands"), { recursive: true });
  writeFileSync(
    join(repoRoot, ".claude-plugin", "commands", "siltpoke-fake.md"),
    "x",
  );
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

// Same guard for the install side (T2's wizard autostart step): without this
// stub, freshInstall's exhausted fakeIO answers default the autostart question
// to yes and install a REAL LaunchAgent on the test machine.
const noopAutostart = async () =>
  ({ status: "skipped", platform: "test" }) as const;

/** The real local-model setup spawns `ollama pull` for a ~4.7 GB model.
 *  runInstall used to skip it only when `CI === "true"`, and this file's env is
 *  a bare `{ HOME: tmp }` that inherits nothing — so the calls below that got
 *  far enough pulled and loaded that model for real. This file accounted for
 *  all 8 `ollama` subprocesses a full suite run spawned (measured 2026-09-18
 *  against a stand-in server on :11434); the freshInstall() path is the one
 *  that reaches it, while the `user_aborted` call returns earlier and passes
 *  the no-op for consistency, not because it ever pulled. */
const noopOllama = async () => ({ enabled: false }) as const;

async function freshInstall(): Promise<void> {
  writeFileSync(
    join(claudeHome, "settings.json"),
    JSON.stringify({ statusLine: { command: "old-cmd" } }),
  );
  await runInstall({
    env,
    repoRoot,
    noninteractive: false,
    // "1" selects Claude Code (index 1) from the interactive agent
    // multi-select BEFORE the install-confirm/personality prompts. Without
    // it, the picker probes the REAL machine's PATH for `command -v claude`
    // (via detectAgents' default exec) and, on a machine that happens not to
    // have a `claude` binary on PATH (any stock Linux CI runner — unlike a
    // dev's own Mac, which has it from daily use), the 3 failed match
    // attempts on the leftover answers below fall back to an EMPTY default
    // selection: wantsClaude ends up false, and the entire settings.json
    // install path (backup, statusLine swap, hook registration) silently
    // no-ops. See tests/cli/install.test.ts for the same "1"-first
    // convention already used by every other interactive runInstall() call.
    io: fakeIO(["1", "yes", "Mochi", "cat", "en"]),
    installAutostartFn: noopAutostart,
    setupOllamaFn: noopOllama,
  });
}

test("uninstall: refuses when SILTPOKE_INTERNAL=1", async () => {
  const r = await runUninstall({
    env: { ...env, SILTPOKE_INTERNAL: "1" } as NodeJS.ProcessEnv,
    repoRoot,
    io: fakeIO([]),
    uninstallAutostartFn: stubAutostartCleanup,
  });
  expect(r.status).toBe("internal_subprocess");
});

test("uninstall: no settings.json → no_settings", async () => {
  const r = await runUninstall({
    env,
    repoRoot,
    io: fakeIO([]),
    uninstallAutostartFn: stubAutostartCleanup,
  });
  expect(r.status).toBe("no_settings");
});

test("uninstall: happy path gives the old status line back and removes siltpoke's hooks", async () => {
  await freshInstall();
  const installed = readFileSync(join(claudeHome, "settings.json"), "utf8");
  expect(installed).toContain("wrapper.ts");
  expect(installed).toContain("handle-session-start.ts");

  const r = await runUninstall({
    env,
    repoRoot,
    noninteractive: false,
    io: fakeIO(["n"]), // decline purge
    uninstallAutostartFn: stubAutostartCleanup,
  });
  expect(r.status).toBe("uninstalled");
  expect(r.siltpoke_home_purged).toBe(false);
  expect(r.settings_changed).toEqual([
    "statusLine restored",
    "Stop hook removed",
    "SessionStart hook removed",
  ]);

  const after = JSON.parse(readFileSync(join(claudeHome, "settings.json"), "utf8"));
  expect(after.statusLine.command).toBe("old-cmd");
  expect(after.hooks).toBeUndefined();
}, INSTALL_TIMEOUT_MS);

function settingsNow(): Record<string, any> {
  return JSON.parse(readFileSync(join(claudeHome, "settings.json"), "utf8"));
}

function writeSettings(s: unknown): void {
  writeFileSync(join(claudeHome, "settings.json"), JSON.stringify(s, null, 2));
}

// Defect [62] (audit §71.1): the backup is a copy of the whole file from setup
// time. Copying it back erased everything the user changed afterwards.
test("uninstall [62]: a key the user added after setup survives", async () => {
  await freshInstall();
  const s = settingsNow();
  s.enabledPlugins = { "other@market": true };
  s.permissions = { allow: ["Bash(ls:*)"] };
  writeSettings(s);

  await runUninstall({
    env,
    repoRoot,
    noninteractive: false,
    io: fakeIO(["n"]),
    uninstallAutostartFn: stubAutostartCleanup,
  });

  const after = settingsNow();
  expect(after.enabledPlugins).toEqual({ "other@market": true });
  expect(after.permissions).toEqual({ allow: ["Bash(ls:*)"] });
  expect(after.statusLine.command).toBe("old-cmd");
  expect(JSON.stringify(after)).not.toContain("wrapper.ts");
  expect(JSON.stringify(after)).not.toContain("on-stop.ts");
  expect(JSON.stringify(after)).not.toContain("/hooks/stop");
  expect(JSON.stringify(after)).not.toContain("handle-session-start.ts");
}, INSTALL_TIMEOUT_MS);

test("uninstall [62]: the user's own Stop and SessionStart hooks survive", async () => {
  await freshInstall();
  const s = settingsNow();
  s.hooks.Stop.push({ matcher: "", hooks: [{ type: "command", command: "say done" }] });
  s.hooks.SessionStart.push({ matcher: "", hooks: [{ type: "command", command: "echo hi" }] });
  s.hooks.PreToolUse = [{ matcher: "Bash", hooks: [{ type: "command", command: "lint" }] }];
  writeSettings(s);

  const r = await runUninstall({
    env,
    repoRoot,
    noninteractive: false,
    io: fakeIO(["n"]),
    uninstallAutostartFn: stubAutostartCleanup,
  });

  expect(r.status).toBe("uninstalled");
  const after = settingsNow();
  expect(after.hooks).toEqual({
    Stop: [{ matcher: "", hooks: [{ type: "command", command: "say done" }] }],
    SessionStart: [{ matcher: "", hooks: [{ type: "command", command: "echo hi" }] }],
    PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "lint" }] }],
  });
}, INSTALL_TIMEOUT_MS);

test("uninstall [62]: someone else's /hooks/stop hooks survive; siltpoke's old loopback http entry goes", async () => {
  await freshInstall();
  const s = settingsNow();
  const foreignCurl = { type: "command", command: "curl -X POST https://ci.example.com/hooks/stop" };
  const foreignHttp = { type: "http", url: "https://ci.example.com/hooks/stop" };
  const oldOurs = { type: "http", url: "http://127.0.0.1:9876/hooks/stop" };
  s.hooks.Stop.push({ matcher: "", hooks: [foreignCurl, foreignHttp] });
  s.hooks.Stop.push({ matcher: "", hooks: [oldOurs] });
  writeSettings(s);

  await runUninstall({
    env,
    repoRoot,
    noninteractive: false,
    io: fakeIO(["n"]),
    uninstallAutostartFn: stubAutostartCleanup,
  });

  expect(settingsNow().hooks).toEqual({
    Stop: [{ matcher: "", hooks: [foreignCurl, foreignHttp] }],
  });
}, INSTALL_TIMEOUT_MS);

test("uninstall [62]: with no earlier status line saved, the statusLine key is removed", async () => {
  await freshInstall();
  rmSync(join(tmp, ".siltpoke", "inner.txt"), { force: true });

  const r = await runUninstall({
    env,
    repoRoot,
    noninteractive: false,
    io: fakeIO(["n"]),
    uninstallAutostartFn: stubAutostartCleanup,
  });

  expect(r.settings_changed[0]).toBe("statusLine removed");
  expect(settingsNow().statusLine).toBeUndefined();
}, INSTALL_TIMEOUT_MS);

test("uninstall [62]: a user's padding on the status line is kept when the command goes back", async () => {
  await freshInstall();
  const s = settingsNow();
  s.statusLine.padding = 2;
  writeSettings(s);

  await runUninstall({
    env,
    repoRoot,
    noninteractive: false,
    io: fakeIO(["n"]),
    uninstallAutostartFn: stubAutostartCleanup,
  });

  expect(settingsNow().statusLine).toEqual({ type: "command", command: "old-cmd", padding: 2 });
}, INSTALL_TIMEOUT_MS);

test("uninstall [62]: a symlinked settings.json stays a link and its target is updated", async () => {
  await freshInstall();
  const fs = require("node:fs");
  const real = join(tmp, "dotfiles-settings.json");
  fs.renameSync(join(claudeHome, "settings.json"), real);
  fs.symlinkSync(real, join(claudeHome, "settings.json"));

  await runUninstall({
    env,
    repoRoot,
    noninteractive: false,
    io: fakeIO(["n"]),
    uninstallAutostartFn: stubAutostartCleanup,
  });

  expect(fs.lstatSync(join(claudeHome, "settings.json")).isSymbolicLink()).toBe(true);
  expect(JSON.parse(readFileSync(real, "utf8")).statusLine.command).toBe("old-cmd");
}, INSTALL_TIMEOUT_MS);

test("uninstall [62]: a status line the user changed since setup is left alone", async () => {
  await freshInstall();
  const s = settingsNow();
  s.statusLine = { type: "command", command: "my-new-line" };
  writeSettings(s);

  const r = await runUninstall({
    env,
    repoRoot,
    noninteractive: false,
    io: fakeIO(["n"]),
    uninstallAutostartFn: stubAutostartCleanup,
  });

  expect(settingsNow().statusLine).toEqual({ type: "command", command: "my-new-line" });
  expect(r.settings_changed).not.toContain("statusLine restored");
}, INSTALL_TIMEOUT_MS);

test("uninstall [62]: the backup file is kept and named in the output", async () => {
  await freshInstall();
  const backupsBefore = require("node:fs")
    .readdirSync(claudeHome)
    .filter((n: string) => n.startsWith("settings.json.pre-siltpoke-"));
  expect(backupsBefore.length).toBeGreaterThan(0);

  const contentBefore = readFileSync(join(claudeHome, backupsBefore[0]), "utf8");

  const { io, output } = capturingIO(["n"]);
  const r = await runUninstall({
    env,
    repoRoot,
    noninteractive: false,
    io,
    uninstallAutostartFn: stubAutostartCleanup,
  });

  const backupsAfter = require("node:fs")
    .readdirSync(claudeHome)
    .filter((n: string) => n.startsWith("settings.json.pre-siltpoke-"));
  expect(backupsAfter).toEqual(backupsBefore);
  expect(readFileSync(join(claudeHome, backupsBefore[0]), "utf8")).toBe(contentBefore);
  // The real timestamped file, not the `settings.json.pre-siltpoke` pointer.
  expect(r.backup_kept).toBe(require("node:fs").realpathSync(join(claudeHome, backupsBefore[0])));
  expect(output()).toContain(r.backup_kept as string);
  expect(output()).not.toContain("restored settings.json from");
}, INSTALL_TIMEOUT_MS);

test("uninstall [62]: an unreadable settings.json is left byte-for-byte as it was", async () => {
  await freshInstall();
  const broken = '{ "statusLine": { "command": "bun x/src/face/wrapper.ts" }, oops';
  writeFileSync(join(claudeHome, "settings.json"), broken);

  const { io, output } = capturingIO(["n"]);
  const r = await runUninstall({
    env,
    repoRoot,
    noninteractive: false,
    io,
    uninstallAutostartFn: stubAutostartCleanup,
  });

  expect(readFileSync(join(claudeHome, "settings.json"), "utf8")).toBe(broken);
  expect(r.settings_changed).toEqual([]);
  expect(output()).toContain("not valid JSON");
}, INSTALL_TIMEOUT_MS);

test("uninstall: --purge deletes ~/.siltpoke/", async () => {
  await freshInstall();
  const r = await runUninstall({
    env,
    repoRoot,
    purge: true,
    io: fakeIO([]),
    uninstallAutostartFn: stubAutostartCleanup,
  });
  expect(r.siltpoke_home_purged).toBe(true);
  expect(existsSync(join(tmp, ".siltpoke"))).toBe(false);
}, INSTALL_TIMEOUT_MS);

test("uninstall: with no backup the status line still comes back from inner.txt", async () => {
  await freshInstall();
  // remove backups + symlink so the fallback path engages
  const entries = require("node:fs").readdirSync(claudeHome) as string[];
  for (const name of entries) {
    if (name.startsWith("settings.json.pre-siltpoke")) {
      rmSync(join(claudeHome, name), { force: true });
    }
  }
  const r = await runUninstall({
    env,
    repoRoot,
    noninteractive: false,
    io: fakeIO(["n"]),
    uninstallAutostartFn: stubAutostartCleanup,
  });
  expect(r.backup_kept).toBeNull();
  const after = JSON.parse(readFileSync(join(claudeHome, "settings.json"), "utf8"));
  expect(after.statusLine.command).toBe("old-cmd");
  expect(after.hooks).toBeUndefined();
}, INSTALL_TIMEOUT_MS);

test("uninstall: a broken backup symlink does not crash it", async () => {
  await freshInstall();
  // Delete the actual backup files but leave the symlink dangling
  const fs = await import("node:fs");
  const entries = fs.readdirSync(claudeHome);
  for (const name of entries) {
    if (
      name.startsWith("settings.json.pre-siltpoke-") &&
      !fs.lstatSync(join(claudeHome, name)).isSymbolicLink()
    ) {
      fs.rmSync(join(claudeHome, name), { force: true });
    }
  }
  // Symlink is still there but points at a now-missing file
  const r = await runUninstall({
    env,
    repoRoot,
    noninteractive: false,
    io: fakeIO(["n"]),
    uninstallAutostartFn: stubAutostartCleanup,
  });
  expect(r.status).toBe("uninstalled");
  expect(r.settings_changed).toContain("statusLine restored");
}, INSTALL_TIMEOUT_MS);

test("install: refuses to back up settings.json that already points at a different siltpoke checkout", async () => {
  const otherWrapper =
    "bun /some/other/checkout/of/siltpoke/src/face/wrapper.ts";
  writeFileSync(
    join(claudeHome, "settings.json"),
    JSON.stringify({ statusLine: { command: otherWrapper } }),
  );
  const { runInstall } = await import("../../src/cli/install");
  const r = await runInstall({
    env,
    repoRoot,
    noninteractive: false,
    // "1" selects Claude Code deterministically — see the comment on
    // freshInstall() above. Without it, on a machine with no `claude`
    // binary on PATH, wantsClaude ends up false and the collision guard
    // this test exists to verify never even runs.
    io: fakeIO(["1", "yes"]),
    installAutostartFn: noopAutostart,
    setupOllamaFn: noopOllama,
  });
  expect(r.status).toBe("user_aborted");
  // No backup created
  const fs = await import("node:fs");
  const entries = fs.readdirSync(claudeHome);
  const backups = entries.filter((n) =>
    n.startsWith("settings.json.pre-siltpoke"),
  );
  expect(backups).toHaveLength(0);
}, INSTALL_TIMEOUT_MS);

test("uninstall: double-uninstall idempotent", async () => {
  await freshInstall();
  await runUninstall({
    env,
    repoRoot,
    noninteractive: false,
    io: fakeIO(["n"]),
    uninstallAutostartFn: stubAutostartCleanup,
  });
  // Now run again — settings.json has no wrapper anymore
  const r = await runUninstall({
    env,
    repoRoot,
    noninteractive: false,
    io: fakeIO(["n"]),
    uninstallAutostartFn: stubAutostartCleanup,
  });
  expect(r.status).toBe("uninstalled");
}, INSTALL_TIMEOUT_MS);

test("uninstall: removes daemon autostart and prints one info line (AC10)", async () => {
  await freshInstall();
  let calls = 0;
  const { io, output } = capturingIO(["n"]);
  const r = await runUninstall({
    env,
    repoRoot,
    noninteractive: false,
    io,
    uninstallAutostartFn: async () => {
      calls++;
      return { status: "removed", platform: "darwin" };
    },
  });
  expect(r.status).toBe("uninstalled");
  expect(calls).toBe(1);
  expect(r.autostart_removed).toBe(true);
  const autostartLines = output()
    .split("\n")
    .filter((l) => l.includes("autostart"));
  expect(autostartLines).toHaveLength(1);
}, INSTALL_TIMEOUT_MS);

test("uninstall: silent no-op when no autostart installed (AC10)", async () => {
  await freshInstall();
  const { io, output } = capturingIO(["n"]);
  const r = await runUninstall({
    env,
    repoRoot,
    noninteractive: false,
    io,
    uninstallAutostartFn: stubAutostartCleanup,
  });
  expect(r.status).toBe("uninstalled");
  expect(r.autostart_removed).toBe(false);
  expect(output()).not.toContain("autostart");
}, INSTALL_TIMEOUT_MS);

test("uninstall: autostart cleanup failure never blocks uninstall (AC10)", async () => {
  await freshInstall();
  const r = await runUninstall({
    env,
    repoRoot,
    noninteractive: false,
    io: fakeIO(["n"]),
    uninstallAutostartFn: async () => {
      throw new Error("launchctl exploded");
    },
  });
  expect(r.status).toBe("uninstalled");
  expect(r.autostart_removed).toBe(false);
}, INSTALL_TIMEOUT_MS);

// The closing line has to say what this run did to Claude Code, not a fixed
// sentence with a command name cut out of the wrapper path.
async function closingLine(): Promise<{ line: string; changed: string[] }> {
  const { io, output } = capturingIO(["n"]);
  const r = await runUninstall({
    env,
    repoRoot,
    noninteractive: false,
    io,
    uninstallAutostartFn: stubAutostartCleanup,
  });
  const line = output().split("\n").find((l) => l.trim().startsWith("done.")) ?? "";
  return { line, changed: r.settings_changed };
}

test("uninstall closing line: status line restored -> restart so the status line change takes effect, no command fragment", async () => {
  await freshInstall();
  const { line, changed } = await closingLine();
  expect(changed).toContain("statusLine restored");
  expect(line).toBe("  done. Restart Claude Code so the status line change takes effect.");
  expect(line).not.toContain("bun");
  expect(line).not.toContain("wrap");
}, INSTALL_TIMEOUT_MS);

test("uninstall closing line: nothing of siltpoke's in settings -> no restart is asked for", async () => {
  writeSettings({ theme: "dark", statusLine: { type: "command", command: "my-line" } });
  const { line, changed } = await closingLine();
  expect(changed).toEqual([]);
  expect(line).toBe("  done. Nothing in Claude Code needed changing, so no restart is needed.");
  expect(line).not.toContain("Restart");
});

test("uninstall closing line: only hooks removed (status line was the user's) -> restart is for the hooks, not the status line", async () => {
  await freshInstall();
  const s = settingsNow();
  s.statusLine = { type: "command", command: "my-new-line" };
  writeSettings(s);
  const { line, changed } = await closingLine();
  expect(changed).toEqual(["Stop hook removed", "SessionStart hook removed"]);
  expect(line).toBe("  done. Restart Claude Code so the removed hooks stop running.");
  expect(line).not.toContain("status line");
}, INSTALL_TIMEOUT_MS);
