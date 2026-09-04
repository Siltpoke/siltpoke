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

test("uninstall: happy path restores settings.json from backup", async () => {
  await freshInstall();
  const installed = readFileSync(join(claudeHome, "settings.json"), "utf8");
  expect(installed).toContain("wrapper.ts");

  const r = await runUninstall({
    env,
    repoRoot,
    noninteractive: false,
    io: fakeIO(["n"]), // decline purge
    uninstallAutostartFn: stubAutostartCleanup,
  });
  expect(r.status).toBe("uninstalled");
  expect(r.backup_restored).toBeTruthy();
  expect(r.siltpoke_home_purged).toBe(false);

  const after = JSON.parse(readFileSync(join(claudeHome, "settings.json"), "utf8"));
  expect(after.statusLine.command).toBe("old-cmd");
  expect(after.hooks?.Stop).toBeUndefined();
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

test("uninstall: no backup found falls back to inner.txt", async () => {
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
  expect(r.inner_fallback_used).toBe(true);
  const after = JSON.parse(readFileSync(join(claudeHome, "settings.json"), "utf8"));
  expect(after.statusLine.command).toBe("old-cmd");
}, INSTALL_TIMEOUT_MS);

test("uninstall: broken backup symlink falls through to inner.txt instead of crashing", async () => {
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
  expect(r.inner_fallback_used).toBe(true);
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
