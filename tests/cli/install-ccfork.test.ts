// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
// Copyright (c) 2026 Jiaqi Duan
import { afterEach, beforeEach, expect, test } from "bun:test";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runInstall } from "../../src/cli/install";
import type { WizardIO } from "../../src/installer/wizard";

let tmp: string;
let claudeHome: string;
let codebuddyHome: string;
let qoderHome: string;
let env: NodeJS.ProcessEnv;
let repoRoot: string;

function fakeIO(answers: string[] = []): WizardIO {
  let i = 0;
  const out: string[] = [];
  return {
    async readLine(): Promise<string> {
      return answers[i++] ?? "";
    },
    write(s: string) {
      out.push(s);
    },
  } as WizardIO & { out: string[] };
}

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "siltpoke-ccfork-"));
  claudeHome = join(tmp, ".claude");
  codebuddyHome = join(tmp, ".codebuddy");
  qoderHome = join(tmp, ".qoder");
  mkdirSync(claudeHome, { recursive: true });
  mkdirSync(codebuddyHome, { recursive: true });
  mkdirSync(qoderHome, { recursive: true });
  writeFileSync(join(claudeHome, "settings.json"), JSON.stringify({}));
  env = {
    HOME: tmp,
    CI: "true",
  } as NodeJS.ProcessEnv;

  // Fake plugin layout so symlinkCommands has something to walk (mirrors
  // tests/cli/install.test.ts fixture setup).
  repoRoot = join(tmp, "repo");
  mkdirSync(join(repoRoot, ".claude-plugin", "commands"), { recursive: true });
  writeFileSync(
    join(repoRoot, ".claude-plugin", "commands", "siltpoke-fake.md"),
    "---\ndescription: fake\n---\nbody",
  );
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

test("install: presetAgents with codebuddy wires Stop + SessionStart hooks and symlinks commands into ~/.codebuddy", async () => {
  const io = fakeIO([]);
  const r = await runInstall({
    env,
    repoRoot,
    noninteractive: true,
    presetAgents: ["claude-code", "codebuddy"],
    io,
  });
  expect(r.status).toBe("installed");

  const settingsPath = join(codebuddyHome, "settings.json");
  expect(existsSync(settingsPath)).toBe(true);
  const written = JSON.parse(readFileSync(settingsPath, "utf8"));
  expect(written.hooks.Stop).toBeDefined();
  expect(written.hooks.SessionStart).toBeDefined();
  const stopHooks = written.hooks.Stop.flatMap((m: { hooks: unknown[] }) => m.hooks);
  expect(
    stopHooks.some((h: { command?: string }) => (h.command ?? "").includes("on-stop.ts")),
  ).toBe(true);
  const sessionHooks = written.hooks.SessionStart.flatMap(
    (m: { hooks: unknown[] }) => m.hooks,
  );
  expect(
    sessionHooks.some((h: { command?: string }) =>
      (h.command ?? "").includes("handle-session-start.ts"),
    ),
  ).toBe(true);

  // Slash commands symlinked into the codebuddy host's own commands dir.
  const linkPath = join(codebuddyHome, "commands", "siltpoke-fake.md");
  expect(existsSync(linkPath)).toBe(true);
  expect(lstatSync(linkPath).isSymbolicLink()).toBe(true);
});

test("install: presetAgents with qodercli wires Stop + SessionStart hooks and symlinks commands into ~/.qoder", async () => {
  const io = fakeIO([]);
  const r = await runInstall({
    env,
    repoRoot,
    noninteractive: true,
    presetAgents: ["claude-code", "qodercli"],
    io,
  });
  expect(r.status).toBe("installed");

  const settingsPath = join(qoderHome, "settings.json");
  expect(existsSync(settingsPath)).toBe(true);
  const written = JSON.parse(readFileSync(settingsPath, "utf8"));
  expect(written.hooks.Stop).toBeDefined();
  expect(written.hooks.SessionStart).toBeDefined();
  const stopHooks = written.hooks.Stop.flatMap((m: { hooks: unknown[] }) => m.hooks);
  expect(
    stopHooks.some((h: { command?: string }) => (h.command ?? "").includes("on-stop.ts")),
  ).toBe(true);
  const sessionHooks = written.hooks.SessionStart.flatMap(
    (m: { hooks: unknown[] }) => m.hooks,
  );
  expect(
    sessionHooks.some((h: { command?: string }) =>
      (h.command ?? "").includes("handle-session-start.ts"),
    ),
  ).toBe(true);

  // Slash commands symlinked into the qoder host's own commands dir.
  const linkPath = join(qoderHome, "commands", "siltpoke-fake.md");
  expect(existsSync(linkPath)).toBe(true);
  expect(lstatSync(linkPath).isSymbolicLink()).toBe(true);
});

test("install: CC-fork-only preset on a fresh machine (no ~/.claude/settings.json, no Codex) still wires codebuddy — must not hit the no_settings early-return", async () => {
  // Simulate a machine that has never run Claude Code and has no Codex
  // config, but does have codebuddy present + selected. Before the
  // wantsAnyCcFork fix, runInstall's `!hasClaudeSettings && !wantsCodex`
  // guard returned "no_settings" here before ever reaching wireCcForkHosts.
  rmSync(join(claudeHome, "settings.json"), { force: true });
  const io = fakeIO([]);
  const r = await runInstall({
    env,
    repoRoot,
    noninteractive: true,
    presetAgents: ["codebuddy"],
    io,
  });
  expect(r.status).toBe("installed");
  const settingsPath = join(codebuddyHome, "settings.json");
  expect(existsSync(settingsPath)).toBe(true);
  const written = JSON.parse(readFileSync(settingsPath, "utf8"));
  expect(written.hooks.Stop).toBeDefined();
  expect(written.hooks.SessionStart).toBeDefined();
});

test("install: already-installed machine (claude wired, no Codex) adding codebuddy still wires it — must not hit the already_installed early-return", async () => {
  // First run installs claude → the machine becomes "already installed"
  // (wrapper statusLine + Stop hook pair + secret all written).
  const first = await runInstall({
    env,
    repoRoot,
    noninteractive: true,
    presetAgents: ["claude-code"],
    io: fakeIO([]),
  });
  expect(first.status).toBe("installed");

  // Second run on the now-already-installed machine, adding codebuddy but NOT
  // Codex. Before the wantsAnyCcFork guard on the `already_installed` early-return
  // (install.ts `if (alreadyInstalled && !wantsCodex)`), runInstall returned
  // "already_installed" here BEFORE ever reaching wireCcForkHosts → codebuddy
  // was never wired. Unit fixtures with a fresh claude (alreadyInstalled=false)
  // could not catch this; a real existing-user machine hits it.
  await runInstall({
    env,
    repoRoot,
    noninteractive: true,
    presetAgents: ["claude-code", "codebuddy"],
    io: fakeIO([]),
  });

  const settingsPath = join(codebuddyHome, "settings.json");
  expect(existsSync(settingsPath)).toBe(true);
  const written = JSON.parse(readFileSync(settingsPath, "utf8"));
  expect(written.hooks.Stop).toBeDefined();
  expect(written.hooks.SessionStart).toBeDefined();
});

test("install: codebuddy not in presetAgents → no ~/.codebuddy/settings.json written", async () => {
  const io = fakeIO([]);
  const r = await runInstall({
    env,
    repoRoot,
    noninteractive: true,
    presetAgents: ["claude-code"],
    io,
  });
  expect(r.status).toBe("installed");
  expect(existsSync(join(codebuddyHome, "settings.json"))).toBe(false);
});

test("install: already-installed machine adding Codex only still wires it (unified dispatch)", async () => {
  const first = await runInstall({
    env,
    repoRoot,
    noninteractive: true,
    presetAgents: ["claude-code"],
    io: fakeIO([]),
  });
  expect(first.status).toBe("installed");
  await runInstall({
    env,
    repoRoot,
    noninteractive: true,
    presetAgents: ["claude-code", "codex"],
    io: fakeIO([]),
  });
  expect(existsSync(join(tmp, ".codex", "hooks.json"))).toBe(true);
});
