// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
// Copyright (c) 2026 Jiaqi Duan
import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import { configure } from "../../src/cli/configure";
import { runInstall } from "../../src/cli/install";
import { realUninstallEffects, type UninstallEffects } from "../../src/cli/plugin-uninstall";
import { fsDiskProbes } from "../../src/cli/uninstall-disk";
import { runUninstallCommand } from "../../src/cli/uninstall-run";
import { writeSessionBaseline } from "../../src/hooks/session-baseline";
import type { AgentTarget } from "../../src/installer/agent-types";
import { runMenubarSetup } from "../../src/installer/menubar-setup";
import { homeDir, siltpokeRoot } from "../../src/installer/paths";
import { autostartUnitPath } from "../../src/installer/receipt-sites";
import { SWIFTBAR_APP_PATH, swiftbarPlistPath } from "../../src/installer/swiftbar-autostart";
import type { WizardIO } from "../../src/installer/wizard";

// `[61]` PR 2, plan P5.2 (spec §6, AC18–AC19): what is left on a machine after
// install → uninstall (every group yes) → purge (every group yes).
//
// Each install type runs its REAL install path in a sandbox home, then the real
// uninstall command, and the file list afterwards is compared with the one
// taken before. Whatever differs must be on the allow-list below, with a reason.
//
// What is real and what is not, stated: the install and uninstall code and the
// filesystem are real. Commands that act on the account instead of on a home
// are stand-ins here — `launchctl`, `defaults`, `brew`, `ollama`, `open` — so
// this test says nothing about them. The plugin itself is installed and
// removed by the host (`claude plugin install`), which this test does not run:
// it writes what the plugin's first session leaves, and the host's registry.

const REPO = join(import.meta.dir, "..", "..");
// The Linux rows can be run on a Mac (and the other way round): nothing here loads a
// unit or reads a real pref, so the platform only decides which paths are used.
const PLATFORM = (process.env.SILTPOKE_LEFTOVERS_PLATFORM as NodeJS.Platform | undefined) ?? process.platform;

interface Sandbox {
  /** Holds the home and one project; nothing of the test is outside it. */
  root: string;
  home: string;
  project: string;
  env: NodeJS.ProcessEnv;
  /** The macOS account settings a real `defaults` would hold. */
  prefs: Map<string, string>;
}

let sb: Sandbox;

/**
 * AC19, and the first thing every run does: nothing below may resolve a path
 * outside the sandbox. A test that reaches the real home has already happened
 * once (memory: test-omitting-env-writes-the-real-install).
 */
function assertSandboxed(env: NodeJS.ProcessEnv, root: string): void {
  // First: a sandbox that is not a fresh temp folder could hold the real home and pass the check below.
  if (!root.startsWith(realpathSync(tmpdir()) + sep)) {
    throw new Error(`leftovers test: the sandbox ${root} is not under the temp folder`);
  }
  const inside = (p: string) => p === root || p.startsWith(root + sep);
  for (const [name, path] of [["HOME", homeDir(env)], ["the Siltpoke data folder", siltpokeRoot(env)]] as const) {
    if (!inside(path)) throw new Error(`leftovers test: ${name} resolves to ${path}, outside the sandbox ${root}`);
  }
}

beforeEach(() => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "siltpoke-leftovers-")));
  const home = join(root, "home");
  const project = join(root, "project");
  sb = { root, home, project, env: { HOME: home, CI: "true" }, prefs: new Map() };
  // A machine somebody already uses: Claude Code with their own status line, and a project.
  mkdirSync(join(home, ".claude"), { recursive: true });
  writeFileSync(
    join(home, ".claude", "settings.json"),
    `${JSON.stringify({ statusLine: { type: "command", command: "starship prompt" }, theme: "dark" }, null, 2)}\n`,
  );
  // Claude Code's own plugin registry, and the folders every account on this platform has.
  setPluginRegistered(false);
  for (const dir of PLATFORM === "darwin" ? [join("Library", "Application Support")] : [".config"]) {
    mkdirSync(join(home, dir), { recursive: true });
  }
  mkdirSync(project, { recursive: true });
  writeFileSync(join(project, "main.ts"), "export const x = 1;\n");
  assertSandboxed(sb.env, sb.root);
});
afterEach(() => {
  rmSync(sb.root, { recursive: true, force: true });
});

/** path → what is there, content included. Folders and links count: an empty folder left behind is a leftover. */
function snapshot(dir: string = sb.root, acc: Map<string, string> = new Map()): Map<string, string> {
  for (const name of readdirSync(dir).sort()) {
    const path = join(dir, name);
    const stat = lstatSync(path);
    const mode = (stat.mode & 0o777).toString(8);
    const rel = path.slice(sb.root.length + 1);
    if (stat.isSymbolicLink()) acc.set(rel, `link -> ${readlinkSync(path)}`);
    else if (stat.isDirectory()) {
      acc.set(rel, `dir ${mode}`);
      snapshot(path, acc);
    } else acc.set(rel, `file ${stat.size}b ${mode} ${createHash("sha256").update(readFileSync(path)).digest("hex").slice(0, 12)}`);
  }
  return acc;
}

/** One line per difference, so a failure reads as a list of leftovers. */
function diff(before: Map<string, string>, after: Map<string, string>): string[] {
  const lines: string[] = [];
  for (const [path, now] of after) {
    const was = before.get(path);
    if (was === undefined) lines.push(`left behind: ${path} (${now})`);
    else if (was !== now) lines.push(`changed: ${path} (${was} → ${now})`);
  }
  for (const path of before.keys()) if (!after.has(path)) lines.push(`removed, and it was there before: ${path}`);
  return lines;
}

/**
 * Differences that are allowed to stay, one reason each. A line here is a
 * statement about the product, not a way to make the test pass: add one only
 * with the reason a user would be given. The shells the install itself created
 * (empty folders, host files holding only `{}`) used to be listed here, found by
 * this test on its first run, 2026-10-07 — defect `[80]`. They are gone from the
 * list because the uninstall now removes them: the receipt records what the
 * install created, and the uninstall deletes it only while it is still empty.
 */
interface Allowed {
  pattern: RegExp;
  reason: string;
  /** Set when only one platform's install can leave it. */
  only?: NodeJS.Platform;
}

const ALLOWED: readonly Allowed[] = [
  {
    pattern: /^left behind: home\/\.claude\/plugins\/cache(\/| )/,
    reason: "the plugin's own files: the host put them there and clears them on its own schedule (the report says so)",
  },
];

/** Which allowances explained something in this run: one that never does is stale (checked last). */
const allowancesUsed = new Set<Allowed>();

function unexplained(lines: readonly string[]): string[] {
  return lines.filter((line) => {
    const allowance = ALLOWED.find((a) => a.pattern.test(line));
    if (allowance) allowancesUsed.add(allowance);
    return allowance === undefined;
  });
}

/** Stands in for commands that act on the account or the network. Never runs anything. */
function accountExec(cmd: string, args: string[]): { status: number; stdout: string } {
  if (cmd === "defaults") {
    const key = `${args[1]} ${args[2]}`;
    if (args[0] === "read") return sb.prefs.has(key) ? { status: 0, stdout: `${sb.prefs.get(key)}\n` } : { status: 1, stdout: "" };
    if (args[0] === "write") sb.prefs.set(key, args[3] ?? "");
    if (args[0] === "delete") sb.prefs.delete(key);
    return { status: 0, stdout: "" };
  }
  if (cmd === "mkdir" && args[0] === "-p" && args[1]) mkdirSync(args[1], { recursive: true });
  if (cmd === "chmod" && args[0] === "+x" && args[1]) chmodSync(args[1], 0o755);
  if (cmd === "which") return { status: 0, stdout: `/opt/${args[0]}\n` };
  if (cmd === "launchctl" || cmd === "killall" || cmd === "open") return { status: 0, stdout: "" };
  // brew, ollama, git, claude, codex: not on this machine.
  return { status: 1, stdout: "" };
}

/** Answers by what was asked, so a new question cannot shift the answers after it. */
function answering(rules: readonly [RegExp, string][]): WizardIO {
  let last = "";
  return {
    write: (text) => { last += text; },
    readLine: async () => {
      const asked = last;
      last = "";
      return rules.find(([pattern]) => pattern.test(asked))?.[1] ?? "";
    },
  };
}

/** The dashboard's start-at-login file, written where the real installer writes it; nothing is loaded. */
async function writeAutostartUnit(): Promise<{ status: "installed"; platform: string }> {
  const unit = autostartUnitPath(PLATFORM, sb.env);
  if (unit === null) throw new Error("no autostart unit on this platform");
  mkdirSync(join(unit, ".."), { recursive: true });
  writeFileSync(unit, "unit\n");
  return { status: "installed", platform: PLATFORM };
}

/** The host's own folder, with something of the host's in it: nobody wires an agent they do not have. */
const HOST_HOME: Partial<Record<AgentTarget, string>> = {
  codex: ".codex",
  codebuddy: ".codebuddy",
  qodercli: ".qoder",
  antigravity: ".gemini",
};

function seedHost(agent: AgentTarget): void {
  const dir = HOST_HOME[agent];
  if (dir === undefined) return;
  mkdirSync(join(sb.home, dir), { recursive: true });
  writeFileSync(join(sb.home, dir, "the-hosts-own-file"), "not Siltpoke's\n");
}

async function sourceInstall(agents: AgentTarget[], opts: { dashboard?: boolean } = {}): Promise<void> {
  const result = await runInstall({
    env: sb.env,
    repoRoot: REPO,
    platform: PLATFORM,
    noninteractive: opts.dashboard !== true,
    io: answering([[/menu.?bar/i, "n"], [/log ?in|autostart|start .*dashboard|dashboard/i, "y"]]),
    presetAgents: agents,
    exec: accountExec,
    setupOllamaFn: async () => ({ enabled: false }),
    installAutostartFn: writeAutostartUnit,
    runMenubarSetupFn: async () => ({ installed: false, wroteShim: false, reason: "declined" }),
  });
  expect(result.status).toBe("installed");
}

/** What a plugin install leaves once its first session has run and `/siltpoke:siltpoke-setup` has finished. */
async function pluginInstall(): Promise<void> {
  const pluginRoot = join(sb.home, ".claude", "plugins", "cache", "siltpoke", "siltpoke", "9.9.9");
  mkdirSync(join(pluginRoot, "dist"), { recursive: true });
  setPluginRegistered(true);
  mkdirSync(siltpokeRoot(sb.env), { recursive: true });
  writeFileSync(join(siltpokeRoot(sb.env), "plugin-root"), pluginRoot);
  const result = await configure(
    { name: "Mochi", species: "slime", lang: "en", personality: "gentle", statusline: true, daemon: true },
    sb.home,
    // The sandbox's env and platform: a runner's own XDG_CONFIG_HOME must not move the recorded unit path.
    { installAutostart: writeAutostartUnit, env: sb.env, platform: PLATFORM, warn: () => {}, out: () => {} },
  );
  expect(result.statusline).toBe("installed");
}

/** The host's own registry: its file, written by `claude plugin install` / `uninstall`. */
function setPluginRegistered(installed: boolean): void {
  mkdirSync(join(sb.home, ".claude", "plugins"), { recursive: true });
  writeFileSync(
    join(sb.home, ".claude", "plugins", "installed_plugins.json"),
    JSON.stringify({ version: 2, plugins: installed ? { "siltpoke@siltpoke": [{}] } : {} }),
  );
}

async function menubarInstall(): Promise<void> {
  const result = await runMenubarSetup({
    io: answering([]),
    platform: "darwin",
    home: sb.home,
    env: sb.env,
    exec: accountExec,
    nonInteractive: true,
    rendererPath: join(REPO, "dist", "siltpoke-card.js"),
    existsSync: (p) => p === SWIFTBAR_APP_PATH || existsSync(p),
  });
  expect(result.reason).toBe("ok");
}

/** A session in the project: the first write of its `.siltpoke/` folder. */
async function openProject(): Promise<void> {
  await writeSessionBaseline(sb.project, { session_id: "s-leftovers", head_sha: "0".repeat(40), captured_at: "2026-10-07T00:00:00Z" } as never, sb.env);
}

function effects(): UninstallEffects {
  const real = realUninstallEffects(sb.env, (home) => {
    // The real one also unloads the item from the account's launchd.
    const plist = swiftbarPlistPath(home);
    const there = existsSync(plist);
    rmSync(plist, { force: true });
    return there;
  });
  return {
    ...real,
    removeAutostart: async () => {
      const unit = autostartUnitPath(PLATFORM, sb.env);
      if (unit === null || !existsSync(unit)) return "not-installed";
      rmSync(unit);
      return "removed";
    },
    stopDaemon: async () => "not-running",
    codexListsPlugin: () => false,
  };
}

let said = "";

async function uninstall(args: string[], ask: (question: string) => Promise<boolean> = async () => true): Promise<number> {
  assertSandboxed(sb.env, sb.root);
  return runUninstallCommand(args, sb.env, {
    effects: effects(),
    probes: fsDiskProbes(accountExec, PLATFORM, () => false),
    undo: { exec: accountExec, platform: PLATFORM },
    purge: { run: accountExec },
    isTTY: true,
    ask,
    write: (t) => { said += t; },
  });
}

interface InstallType {
  name: string;
  /** Hosts that are on the machine before the install. */
  hosts?: AgentTarget[];
  install: () => Promise<void>;
  /** What the user does between the two uninstall steps (spec §3: the host removes the plugin). */
  between?: () => void;
  only?: NodeJS.Platform;
}

const TYPES: readonly InstallType[] = [
  { name: "plugin install, status line and dashboard on", install: pluginInstall, between: () => setPluginRegistered(false) },
  { name: "source install into Claude Code", install: () => sourceInstall(["claude-code"]) },
  { name: "source install with the dashboard started at login", install: () => sourceInstall(["claude-code"], { dashboard: true }) },
  { name: "source install with codex wired", hosts: ["codex"], install: () => sourceInstall(["claude-code", "codex"]) },
  { name: "source install with codebuddy wired", hosts: ["codebuddy"], install: () => sourceInstall(["claude-code", "codebuddy"]) },
  { name: "source install with qoder wired", hosts: ["qodercli"], install: () => sourceInstall(["claude-code", "qodercli"]) },
  { name: "source install with Antigravity wired", hosts: ["antigravity"], install: () => sourceInstall(["claude-code", "antigravity"]) },
  { name: "source install with the menu-bar pet", install: async () => { await sourceInstall(["claude-code"]); await menubarInstall(); }, only: "darwin" },
];

describe("AC19 — the test refuses to run against anything but its sandbox", () => {
  test("the guard passes for the sandbox it built", () => {
    expect(() => assertSandboxed(sb.env, sb.root)).not.toThrow();
  });

  test.each([
    ["HOME is the real home", () => ({ HOME: process.env.HOME ?? "/" })],
    ["HOME is outside the sandbox", () => ({ HOME: tmpdir() })],
    ["SILTPOKE_HOME points outside while HOME is inside", () => ({ HOME: sb.home, SILTPOKE_HOME: join(tmpdir(), "elsewhere") })],
    // The other way round: only the HOME check can see this one.
    ["HOME is outside while SILTPOKE_HOME points inside", () => ({ HOME: tmpdir(), SILTPOKE_HOME: join(sb.home, ".siltpoke") })],
  ] as [string, () => NodeJS.ProcessEnv][])("it throws when %s", (_name, env) => {
    expect(() => assertSandboxed(env(), sb.root)).toThrow(/leftovers test/);
  });

  test("it throws when HOME is not set (the path resolver refuses first)", () => {
    expect(() => assertSandboxed({}, sb.root)).toThrow();
  });

  test("it throws when the sandbox is a folder that could hold the real home", () => {
    for (const root of ["/", process.env.HOME ?? "/Users/x"]) {
      expect(() => assertSandboxed({ HOME: join(root, "home") }, root)).toThrow(/not under the temp folder/);
    }
  });
});

describe("AC18 — install → uninstall → purge, every question answered yes", () => {
  for (const type of TYPES) {
    test.skipIf(type.only !== undefined && type.only !== PLATFORM)(type.name, async () => {
      for (const host of type.hosts ?? []) seedHost(host);
      const before = snapshot();
      said = "";

      await type.install();
      await openProject();
      const installed = diff(before, snapshot());
      // The install really did something — or the comparison below proves nothing.
      expect(installed.length).toBeGreaterThan(3);
      expect(existsSync(join(sb.project, ".siltpoke"))).toBe(true);

      expect(await uninstall([])).toBe(0);
      type.between?.();
      const code = await uninstall(["--purge"]);

      const left = unexplained(diff(before, snapshot()));
      if (process.env.SILTPOKE_LEFTOVERS_DEBUG) console.error(`--- ${type.name}\n${said}--- exit ${code}`);
      expect(left).toEqual([]);
      expect(code).toBe(0);
      // And the report agrees with the disk: nothing it was asked for is still there.
      expect(said).not.toContain("Not removed —");
    });
  }
});

// `[80]`: what the install did NOT create must survive, however empty it looks.
describe("[80] — only what the install created is taken back, and only while it is empty", () => {
  test("a folder and a host file that were already there (and empty) are still there", async () => {
    seedHost("codex");
    mkdirSync(join(sb.home, ".claude", "commands"), { recursive: true });
    writeFileSync(join(sb.home, ".codex", "hooks.json"), "{}\n");
    const before = snapshot();

    await sourceInstall(["claude-code", "codex"]);
    expect(await uninstall([])).toBe(0);
    expect(await uninstall(["--purge"])).toBe(0);

    expect(unexplained(diff(before, snapshot()))).toEqual([]);
    expect(readdirSync(join(sb.home, ".claude", "commands"))).toEqual([]);
    expect(readFileSync(join(sb.home, ".codex", "hooks.json"), "utf8")).toBe("{}\n");
  });

  test("a folder the install made keeps staying once the user has put a file in it, and so does a host file the user added to", async () => {
    seedHost("qodercli");
    await sourceInstall(["claude-code", "qodercli"]);
    const mine = join(sb.home, ".qoder", "commands", "my-own-command.md");
    writeFileSync(mine, "mine\n");
    const settings = join(sb.home, ".qoder", "settings.json");
    const parsed = JSON.parse(readFileSync(settings, "utf8")) as Record<string, unknown>;
    writeFileSync(settings, `${JSON.stringify({ ...parsed, myOwnKey: 1 }, null, 2)}\n`);

    expect(await uninstall([])).toBe(0);
    expect(await uninstall(["--purge"])).toBe(0);

    expect(readFileSync(mine, "utf8")).toBe("mine\n");
    expect(JSON.parse(readFileSync(settings, "utf8"))).toEqual({ myOwnKey: 1 });
  });
});

describe("[80] — the purge step does not drop what the install created", () => {
  test("data folder removed first (receipt kept), the other groups after: no shells left", async () => {
    seedHost("codex");
    const before = snapshot();
    await sourceInstall(["claude-code", "codex"]);
    await openProject();

    // Only Claude Code and the data folder are said yes to (the data step refuses while the status line points into it): the receipt is cut down, not deleted.
    expect(await uninstall(["--purge"], async (q) => q.includes("Claude Code") || q.includes("Your Siltpoke data"))).toBe(0);
    expect(existsSync(join(siltpokeRoot(sb.env), "receipt.json"))).toBe(true);
    expect(await uninstall(["--purge"])).toBe(0);

    expect(unexplained(diff(before, snapshot()))).toEqual([]);
  });
});

describe("the allow-list", () => {
  // Runs after every install type above. An allowance that explained nothing is a
  // statement about the product that is no longer true: delete the line.
  afterAll(() => allowancesUsed.clear());

  test("every allowance for this platform explained at least one leftover", () => {
    const stale = ALLOWED.filter((a) => (a.only === undefined || a.only === PLATFORM) && !allowancesUsed.has(a)).map((a) => a.reason);
    expect(stale).toEqual([]);
  });

  test("a leftover that no line allows is reported — being allowed is not the default", () => {
    const lines = [
      "left behind: home/.siltpoke (dir 755)",
      "left behind: home/.claude/settings.json.pre-siltpoke (file 90b 644)",
      "left behind: home/.codex/hooks.json (file 412b 644)", // not the 3-byte {} the list allows
      "changed: home/.claude/settings.json (file 90b 644 → file 120b 644)",
      "removed, and it was there before: project/main.ts",
    ];
    expect(unexplained(lines)).toEqual(lines);
  });

  test("a file whose bytes changed and whose size did not is reported as changed", () => {
    const file = join(sb.home, ".claude", "settings.json");
    const before = snapshot();
    const text = readFileSync(file, "utf8");
    writeFileSync(file, text.replace("starship", "STARSHIP"));
    expect(diff(before, snapshot()).map((l) => l.split(" (")[0])).toEqual(["changed: home/.claude/settings.json"]);
  });

  test("every allowance says why, in a sentence", () => {
    for (const a of ALLOWED) expect(a.reason.length).toBeGreaterThan(40);
  });
});
