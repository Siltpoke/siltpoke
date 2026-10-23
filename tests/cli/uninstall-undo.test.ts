// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
// Copyright (c) 2026 Jiaqi Duan
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { MenubarTargets, UninstallEffects } from "../../src/cli/plugin-uninstall";
import { fsDiskProbes } from "../../src/cli/uninstall-disk";
import type { PlanItem, RemovalPlan } from "../../src/cli/uninstall-plan";
import { runUninstallCommand } from "../../src/cli/uninstall-run";
import { isSiltpokeCommandLink, undoItem } from "../../src/cli/uninstall-undo";
import { installCodexIntegration } from "../../src/installer/codex-integration";
import { symlinkCommands } from "../../src/installer/command-links";
import { codebuddyAdapter, qoderAdapter, writeAgyHooksJson } from "../../src/installer/host-adapter";
import { SWIFTBAR_DEFAULTS_DOMAIN, SWIFTBAR_PLUGIN_DIR_KEY } from "../../src/installer/menubar-setup";
import { codexHooksJsonPath, commandsDirPath, resolveAgyHooksJsonPath, settingsJsonPath } from "../../src/installer/paths";
import { markDone, type NewReceiptEntry, recordBefore } from "../../src/installer/receipt";
import { menubarShimEntry, settingsHooksEntry, swiftbarPrefEntry } from "../../src/installer/receipt-sites";
import { registerSessionStartHook } from "../../src/installer/register-session-start";
import { registerStopHookPair } from "../../src/installer/settings-mutator";

// `[61]` PR 2, plan P3 (spec §4, AC10–AC13): the default level takes back all
// of siltpoke's wiring. Each test installs with the SAME function the real
// install uses, into a temp home, then removes through the CLI command and
// reads the files that are left. Only account-level commands (`defaults`) and
// PR 1's machine-touching steps are injected.

let home: string;
let env: NodeJS.ProcessEnv;
let out: string;
let execCalls: string[][];
let menubarTargets: MenubarTargets | undefined;
/** What `defaults read <domain> <key>` answers; undefined = unset. */
let pluginDirPref: string | undefined;
let platform: NodeJS.Platform;

const REPO = "/Users/u/siltpoke";
const USER_HOOK = { type: "command", command: "/usr/local/bin/notify-me" };

function effects(): UninstallEffects {
  return {
    removeAutostart: async () => "not-installed",
    stopDaemon: async () => "not-running",
    removeMenubar: async (targets) => {
      menubarTargets = targets;
      return { shim: targets.shims.length > 0, loginItem: targets.loginItem };
    },
    codexListsPlugin: () => false,
  };
}

const exec = (cmd: string, args: string[]) => {
  execCalls.push([cmd, ...args]);
  if (cmd !== "defaults") return { status: 1, stdout: "" };
  if (args[0] === "read") return pluginDirPref === undefined ? { status: 1, stdout: "" } : { status: 0, stdout: `${pluginDirPref}\n` };
  if (args[0] === "delete") pluginDirPref = undefined;
  return { status: 0, stdout: "" };
};

async function run(args: string[], opts: { answers?: boolean[] } = {}): Promise<number> {
  const answers = opts.answers;
  out = "";
  return runUninstallCommand(args, env, {
    effects: effects(),
    probes: fsDiskProbes(exec, platform, () => true),
    undo: { exec, platform },
    purge: { run: () => ({ status: 1, stdout: "" }) },
    isTTY: answers !== undefined,
    ask: async () => answers?.shift() ?? false,
    write: (t) => {
      out += t;
    },
  });
}

async function plan(): Promise<RemovalPlan> {
  await run(["--plan", "--json"]);
  return JSON.parse(out) as RemovalPlan;
}

async function remove(group: string): Promise<number> {
  const { planId } = await plan();
  return run(["--plan-id", planId, "--remove", group]);
}

const statusOf = async (id: string) => (await plan()).groups.flatMap((g) => g.items).find((i) => i.id === id)?.status;
const groupOf = async (id: string) => (await plan()).groups.find((g) => g.items.some((i) => i.id === id));
const json = (path: string) => JSON.parse(readFileSync(path, "utf8")) as unknown;
const put = (path: string, value: unknown) => {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, typeof value === "string" ? value : `${JSON.stringify(value, null, 2)}\n`);
};
const record = (entry: NewReceiptEntry) => {
  recordBefore(entry, env);
  markDone(entry.id, env);
};

/** path → size:sha256 for every file under `dir`, so "untouched" is byte-level. */
function snapshot(dir: string, acc: Record<string, string> = {}): Record<string, string> {
  for (const name of readdirSync(dir).sort()) {
    const p = join(dir, name);
    if (lstatSync(p).isSymbolicLink()) acc[p] = "link";
    else if (statSync(p).isDirectory()) snapshot(p, acc);
    else acc[p] = `${statSync(p).size}:${createHash("sha256").update(readFileSync(p)).digest("hex")}`;
  }
  return acc;
}

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "siltpoke-uninstall-undo-"));
  env = { HOME: home };
  execCalls = [];
  menubarTargets = undefined;
  pluginDirPref = undefined;
  platform = "darwin";
  mkdirSync(join(home, ".siltpoke"), { recursive: true });
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

interface HostCase {
  group: string;
  id: string;
  path: () => string;
  /** The user's file before siltpoke. */
  before: Record<string, unknown>;
  install: () => Promise<unknown>;
}

const HOSTS: HostCase[] = [
  {
    group: "codex",
    id: "hook:codex",
    path: () => codexHooksJsonPath(env),
    before: { hooks: { Stop: [{ hooks: [USER_HOOK] }], UserPromptSubmit: [{ hooks: [USER_HOOK] }] } },
    install: () => installCodexIntegration(REPO, env),
  },
  {
    group: "codebuddy",
    id: "hook:codebuddy",
    path: () => codebuddyAdapter.settingsPath(env),
    before: { model: "x", hooks: { Stop: [{ matcher: "", hooks: [USER_HOOK] }] } },
    install: () => codebuddyAdapter.writeHooks(env, { repoRoot: REPO, secret: "s3cret" }),
  },
  {
    group: "qoder",
    id: "hook:qodercli",
    path: () => qoderAdapter.settingsPath(env),
    before: { model: "x", permissions: { allow: ["Bash(ls:*)"] } },
    install: () => qoderAdapter.writeHooks(env, { repoRoot: REPO, secret: "s3cret" }),
  },
  {
    group: "antigravity",
    id: "hook:antigravity",
    path: () => resolveAgyHooksJsonPath(env),
    before: { "my-linter": { Stop: [{ type: "command", command: "lint" }] } },
    install: () => writeAgyHooksJson(resolveAgyHooksJsonPath(env), `bun ${REPO}/src/hooks/agy-stop.ts`, env),
  },
];

describe("P3.1 — a host's hooks (AC10)", () => {
  for (const host of HOSTS) {
    test(`${host.group}: siltpoke's entries are removed, the user's file is otherwise as it was`, async () => {
      put(host.path(), host.before);
      await host.install();
      // The install really changed the file — otherwise the rest proves nothing.
      expect(json(host.path())).not.toEqual(host.before);
      expect((await groupOf(host.id))?.id).toBe(host.group);
      expect(await statusOf(host.id)).toBe("remove");

      expect(await remove(host.group)).toBe(0);
      expect(json(host.path())).toEqual(host.before);
      expect(out).toContain("removed");
      expect(out).not.toContain("cannot undo it yet");
      expect(await statusOf(host.id)).toBe("already-gone");
    });

    test(`${host.group}: no receipt — what the file itself says is siltpoke's is still offered and removed`, async () => {
      put(host.path(), host.before);
      await host.install();
      unlinkSync(join(home, ".siltpoke", "receipt.json"));
      expect(await statusOf(host.id)).toBe("remove");

      expect(await remove(host.group)).toBe(0);
      expect(json(host.path())).toEqual(host.before);
      expect((await plan()).groups.some((g) => g.id === host.group)).toBe(false);
    });

    test(`${host.group}: a file that is not valid JSON is left byte-identical, and the run says so`, async () => {
      put(host.path(), host.before);
      await host.install();
      const broken = `${readFileSync(host.path(), "utf8")}}}`;
      put(host.path(), broken);
      expect(await statusOf(host.id)).toBe("remove");

      expect(await remove(host.group)).toBe(1);
      expect(readFileSync(host.path(), "utf8")).toBe(broken);
      expect(out).toContain("could not finish");
      expect(out).toContain("not valid JSON");
    });
  }

  test("Claude Code source install: the hooks are judged by the hook events, not by the status line beside them", async () => {
    const wrapper = { type: "command", command: `bun ${REPO}/src/face/wrapper.ts` };
    record(settingsHooksEntry("claude-code", settingsJsonPath(env), REPO));
    // Hooks already gone; the status line (same install root) is still there.
    put(settingsJsonPath(env), { statusLine: wrapper });
    expect(await statusOf("hook:claude-code")).toBe("already-gone");
  });

  test("Claude Code source install: Stop + SessionStart go, the user's keys and the status line stay", async () => {
    const mine = { theme: "dark", statusLine: { type: "command", command: "echo mine" }, hooks: { Stop: [{ matcher: "", hooks: [USER_HOOK] }] } };
    const withStop = registerStopHookPair(mine, { httpUrl: "http://127.0.0.1:9876/hooks/stop", command: `bun ${REPO}/src/hooks/on-stop.ts`, secret: "s" });
    put(settingsJsonPath(env), registerSessionStartHook(withStop, `bun ${REPO}/src/hooks/handle-session-start.ts`));
    record(settingsHooksEntry("claude-code", settingsJsonPath(env), REPO));

    expect(await remove("claude-code")).toBe(0);
    expect(json(settingsJsonPath(env))).toEqual(mine);
  });

  test("the file keeps its own permissions", async () => {
    const path = codebuddyAdapter.settingsPath(env);
    put(path, registerSessionStartHook({ model: "x" }, `bun ${REPO}/src/hooks/handle-session-start.ts`));
    chmodSync(path, 0o600);
    record(settingsHooksEntry("codebuddy", path, REPO));
    expect(await remove("codebuddy")).toBe(0);
    expect(json(path)).toEqual({ model: "x" });
    expect(statSync(path).mode & 0o777).toBe(0o600);
  });

  // root ignores a folder's mode, so the write would succeed and this would prove nothing.
  test.skipIf(process.getuid?.() === 0)("the file cannot be written: the run says so, exits non-zero, and the file is as it was", async () => {
    const path = codebuddyAdapter.settingsPath(env);
    put(path, registerSessionStartHook({ model: "x" }, `bun ${REPO}/src/hooks/handle-session-start.ts`));
    const before = readFileSync(path, "utf8");
    record(settingsHooksEntry("codebuddy", path, REPO));
    const { planId } = await plan();
    chmodSync(dirname(path), 0o555);
    try {
      expect(await run(["--plan-id", planId, "--remove", "codebuddy"])).toBe(1);
    } finally {
      chmodSync(dirname(path), 0o755);
    }
    expect(out).toContain("could not finish");
    expect(readFileSync(path, "utf8")).toBe(before);
  });

  test("no receipt, and a settings file with comments in it: listed, not rewritten, and the run says it could not finish", async () => {
    const path = codebuddyAdapter.settingsPath(env);
    const installed = registerStopHookPair({}, { httpUrl: "http://127.0.0.1:9876/hooks/stop", command: `bun ${REPO}/src/hooks/on-stop.ts`, secret: "s" });
    const jsonc = `// my settings\n${JSON.stringify(installed, null, 2)}\n`;
    put(path, jsonc);
    expect(await statusOf("hook:codebuddy")).toBe("remove");
    expect(await remove("codebuddy")).toBe(1);
    expect(readFileSync(path, "utf8")).toBe(jsonc);
    expect(out).toContain("not valid JSON");
  });

  test("no receipt: siltpoke's links in codebuddy's and qoder's commands folders are found too", async () => {
    const plugin = join(home, "repo", ".claude-plugin", "commands");
    put(join(plugin, "siltpoke-doctor.md"), "# doctor\n");
    for (const adapter of [codebuddyAdapter, qoderAdapter]) {
      await symlinkCommands(plugin, adapter.commandsDir(env), "darwin", env);
    }
    unlinkSync(join(home, ".siltpoke", "receipt.json"));
    // Each under its own host's heading: a yes to "Claude Code" must not reach into codebuddy's folder.
    expect((await groupOf(`file:${join(codebuddyAdapter.commandsDir(env), "siltpoke-doctor.md")}`))?.id).toBe("codebuddy");
    expect((await groupOf(`file:${join(qoderAdapter.commandsDir(env), "siltpoke-doctor.md")}`))?.id).toBe("qoder");
    expect((await plan()).groups.some((g) => g.id === "claude-code")).toBe(false);

    expect(await remove("codebuddy")).toBe(0);
    expect(readdirSync(codebuddyAdapter.commandsDir(env))).toEqual([]);
    expect(readdirSync(qoderAdapter.commandsDir(env))).toEqual(["siltpoke-doctor.md"]);
  });

  test("a settings file that is a link (a dotfile manager's) is written through, not replaced", async () => {
    const real = join(home, "dotfiles", "codebuddy-settings.json");
    put(real, { model: "x" });
    mkdirSync(dirname(codebuddyAdapter.settingsPath(env)), { recursive: true });
    symlinkSync(real, codebuddyAdapter.settingsPath(env));
    put(real, registerSessionStartHook({ model: "x" }, `bun ${REPO}/src/hooks/handle-session-start.ts`));
    record(settingsHooksEntry("codebuddy", codebuddyAdapter.settingsPath(env), REPO));

    expect(await remove("codebuddy")).toBe(0);
    expect(lstatSync(codebuddyAdapter.settingsPath(env)).isSymbolicLink()).toBe(true);
    expect(json(real)).toEqual({ model: "x" });
  });
});

describe("P3.2 / P3.3 — the SwiftBar plugin-folder setting (AC11, AC12)", () => {
  const PREF = `pref:${SWIFTBAR_DEFAULTS_DOMAIN}.${SWIFTBAR_PLUGIN_DIR_KEY}`;
  const deletes = () => execCalls.filter((c) => c[0] === "defaults" && c[1] === "delete");

  test("siltpoke set it: removing the menu-bar group deletes it", async () => {
    pluginDirPref = join(home, "plugins");
    record(swiftbarPrefEntry(SWIFTBAR_DEFAULTS_DOMAIN, SWIFTBAR_PLUGIN_DIR_KEY, true));
    expect((await groupOf(PREF))?.id).toBe("menubar");

    expect(await remove("menubar")).toBe(0);
    expect(deletes()).toEqual([["defaults", "delete", SWIFTBAR_DEFAULTS_DOMAIN, SWIFTBAR_PLUGIN_DIR_KEY]]);
    expect(out).not.toContain("cannot undo it yet");
    expect(await statusOf(PREF)).toBe("already-gone");
  });

  test("it was set before siltpoke: listed as kept, never deleted", async () => {
    pluginDirPref = "/Users/u/my-swiftbar";
    record(swiftbarPrefEntry(SWIFTBAR_DEFAULTS_DOMAIN, SWIFTBAR_PLUGIN_DIR_KEY, false));
    expect(await statusOf(PREF)).toBe("kept-not-ours");
    await run([], { answers: [true, true, true, true] });
    expect(deletes()).toEqual([]);
    expect(pluginDirPref).toBe("/Users/u/my-swiftbar");
  });

  test("no receipt: siltpoke cannot tell who set it, so it is never deleted", async () => {
    pluginDirPref = "/Users/u/somewhere";
    expect(await statusOf(PREF)).toBe("unknown-owner");
    await run([], { answers: [true, true, true, true] });
    expect(deletes()).toEqual([]);
  });

  test("`defaults delete` fails: the run says so and exits non-zero", async () => {
    pluginDirPref = join(home, "plugins");
    record(swiftbarPrefEntry(SWIFTBAR_DEFAULTS_DOMAIN, SWIFTBAR_PLUGIN_DIR_KEY, true));
    const { planId } = await plan();
    out = "";
    const code = await runUninstallCommand(["--plan-id", planId, "--remove", "menubar"], env, {
      effects: effects(),
      probes: fsDiskProbes(exec, platform, () => true),
      undo: { exec: (cmd, args) => (args[0] === "delete" ? { status: 1, stdout: "" } : exec(cmd, args)), platform },
      purge: { run: () => ({ status: 1, stdout: "" }) },
      isTTY: false,
      ask: async () => false,
      write: (t) => {
        out += t;
      },
    });
    expect(code).toBe(1);
    expect(out).toContain("could not finish");
  });

  test("the shim: removed only while its bytes are the ones siltpoke wrote (receipt hash)", async () => {
    const shim = join(home, "Library", "Application Support", "SwiftBar", "plugins", "siltpoke.1m.sh");
    const written = '#!/bin/bash\nexec "/x/bun" "/x/dist/siltpoke-card.js" --menubar\n';
    put(shim, written);
    record(menubarShimEntry(shim, "absent", written));

    // Same shape, other bytes: something rewrote it after the receipt was written.
    put(shim, '#!/bin/bash\nexec "/other/bun" "/other/dist/siltpoke-card.js" --menubar\n');
    expect(await remove("menubar")).toBe(1);
    expect(menubarTargets?.shims ?? []).toEqual([]);
    expect(out).toContain("no longer the file Siltpoke wrote");

    put(shim, written);
    expect(await remove("menubar")).toBe(0);
    expect(menubarTargets?.shims).toEqual([shim]);
  });
});

describe("P3.4 — slash-command files (inventory row 16)", () => {
  const pluginCommands = () => join(home, "repo", ".claude-plugin", "commands");
  const NAMES = ["siltpoke-doctor.md", "siltpoke-last.md"];

  beforeEach(() => {
    for (const n of NAMES) put(join(pluginCommands(), n), `# ${n}\n`);
  });

  test("links siltpoke made are deleted; the user's own command file is not", async () => {
    put(join(commandsDirPath(env), "my-command.md"), "mine\n");
    await symlinkCommands(pluginCommands(), commandsDirPath(env), "darwin", env);
    expect(readdirSync(commandsDirPath(env)).sort()).toEqual(["my-command.md", ...NAMES]);

    expect(await remove("claude-code")).toBe(0);
    expect(readdirSync(commandsDirPath(env))).toEqual(["my-command.md"]);
    expect(out).not.toContain("cannot undo it yet");
    // The link's target is siltpoke's own file and is not what gets deleted.
    expect(existsSync(join(pluginCommands(), NAMES[0] as string))).toBe(true);
  });

  test("a file the install overwrote (it was the user's): kept, and listed as not siltpoke's", async () => {
    const dest = join(commandsDirPath(env), NAMES[0] as string);
    put(dest, "the user's own command of the same name\n");
    await symlinkCommands(pluginCommands(), commandsDirPath(env), "darwin", env);
    expect(await statusOf(`file:${dest}`)).toBe("kept-not-ours");
    expect(await remove("claude-code")).toBe(0);
    expect(existsSync(dest)).toBe(true);
  });

  test("a link the user has since pointed somewhere else is kept, and the run says so", async () => {
    await symlinkCommands(pluginCommands(), commandsDirPath(env), "darwin", env);
    const dest = join(commandsDirPath(env), NAMES[0] as string);
    unlinkSync(dest);
    put(join(home, "elsewhere", "x.md"), "x\n");
    symlinkSync(join(home, "elsewhere", "x.md"), dest);

    expect(await remove("claude-code")).toBe(1);
    expect(lstatSync(dest).isSymbolicLink()).toBe(true);
    expect(existsSync(join(commandsDirPath(env), NAMES[1] as string))).toBe(false);
    expect(out).toContain("left as it is");
  });

  test("win32 (copies): deleted on a hash match, an edited copy is kept", async () => {
    platform = "win32";
    await symlinkCommands(pluginCommands(), commandsDirPath(env), "win32", env);
    const edited = join(commandsDirPath(env), NAMES[0] as string);
    const untouched = join(commandsDirPath(env), NAMES[1] as string);
    expect(lstatSync(edited).isSymbolicLink()).toBe(false);
    writeFileSync(edited, "edited by the user\n");

    expect(await remove("claude-code")).toBe(1);
    expect(readFileSync(edited, "utf8")).toBe("edited by the user\n");
    expect(existsSync(untouched)).toBe(false);
    expect(out).toContain("left as it is");
  });

  test("no receipt: a siltpoke-named link into a plugin commands folder is found and removed", async () => {
    await symlinkCommands(pluginCommands(), commandsDirPath(env), "darwin", env);
    unlinkSync(join(home, ".siltpoke", "receipt.json"));
    put(join(commandsDirPath(env), "siltpoke-notes.md"), "a real file the user named like ours\n");

    expect(await remove("claude-code")).toBe(0);
    expect(readdirSync(commandsDirPath(env))).toEqual(["siltpoke-notes.md"]);
  });
});

describe("the executors check again at the moment of removal, whatever the plan said", () => {
  const prefItem = (byUs: boolean | null): PlanItem => ({
    id: `pref:${SWIFTBAR_DEFAULTS_DOMAIN}.${SWIFTBAR_PLUGIN_DIR_KEY}`,
    kind: "macos-pref",
    target: SWIFTBAR_DEFAULTS_DOMAIN,
    byUs,
    source: "receipt",
    // A plan that (wrongly) says "remove": the executor must not take its word for ownership.
    status: "remove",
    undo: swiftbarPrefEntry(SWIFTBAR_DEFAULTS_DOMAIN, SWIFTBAR_PLUGIN_DIR_KEY, true).undo,
  });

  for (const byUs of [false, null]) {
    test(`the setting is not deleted when the receipt does not say siltpoke set it (byUs ${byUs})`, () => {
      expect(undoItem(prefItem(byUs), { exec, platform: "darwin" })).toEqual({ outcome: "nothing" });
      expect(execCalls).toEqual([]);
    });
  }

  test("the setting is not deleted off macOS", () => {
    expect(undoItem(prefItem(true), { exec, platform: "linux" })).toEqual({ outcome: "nothing" });
    expect(execCalls).toEqual([]);
  });

  test("the setting IS deleted on the receipt's word (the control for the three above)", () => {
    expect(undoItem(prefItem(true), { exec, platform: "darwin" })?.outcome).toBe("done");
    expect(execCalls).toEqual([["defaults", "delete", SWIFTBAR_DEFAULTS_DOMAIN, SWIFTBAR_PLUGIN_DIR_KEY]]);
  });

  test("with no receipt, a command file is siltpoke's only as a link, by name, into a plugin commands folder", () => {
    const commands = "/h/.claude/commands";
    const plugin = "/repo/.claude-plugin/commands";
    expect(isSiltpokeCommandLink(`${commands}/siltpoke-doctor.md`, `${plugin}/siltpoke-doctor.md`)).toBe(true);
    // A real file (not a link), whatever its name.
    expect(isSiltpokeCommandLink(`${commands}/siltpoke-doctor.md`, null)).toBe(false);
    // A siltpoke-named link that points somewhere else.
    expect(isSiltpokeCommandLink(`${commands}/siltpoke-doctor.md`, "/elsewhere/siltpoke-doctor.md")).toBe(false);
    expect(isSiltpokeCommandLink(`${commands}/siltpoke-doctor.md`, `${plugin}/other.md`)).toBe(false);
    // Another plugin's command linked the same way.
    expect(isSiltpokeCommandLink(`${commands}/deploy.md`, `${plugin}/deploy.md`)).toBe(false);
  });

  test("with no receipt, a siltpoke-named real file in the commands folder is not deleted", () => {
    const file = join(commandsDirPath(env), "siltpoke-notes.md");
    put(file, "mine\n");
    const item: PlanItem = { id: `file:${file}`, kind: "file", target: file, byUs: null, source: "disk", status: "remove", undo: null };
    expect(undoItem(item, { exec, platform: "darwin" })?.outcome).toBe("not-done");
    expect(readFileSync(file, "utf8")).toBe("mine\n");
  });
});

describe("P3.5 — the default level deletes no data (AC13)", () => {
  test("yes to everything without --purge: ~/.siltpoke, a project's .siltpoke/ and the settings backups are byte-identical", async () => {
    const project = join(home, "work", "app");
    put(join(home, ".siltpoke", "config.json"), { name: "Velvettwirl" });
    put(join(home, ".siltpoke", "memory.json"), { rules: [1, 2, 3] });
    put(join(project, ".siltpoke", "reviews.jsonl"), '{"id":"c-1"}\n');
    put(join(home, ".claude", "settings.json.pre-siltpoke-20261001"), { theme: "light" });
    for (const host of HOSTS) {
      put(host.path(), host.before);
      await host.install();
    }
    const receipt = readFileSync(join(home, ".siltpoke", "receipt.json"), "utf8");
    const kept = () => ({
      ...snapshot(join(home, ".siltpoke")),
      ...snapshot(join(project, ".siltpoke")),
      backup: readFileSync(join(home, ".claude", "settings.json.pre-siltpoke-20261001"), "utf8"),
    });
    const before = kept();
    expect(Object.keys(before).length).toBeGreaterThan(4);

    expect(await run([], { answers: Array.from({ length: 20 }, () => true) })).toBe(0);
    // The wiring really went — so "nothing was deleted" is not "nothing ran".
    for (const host of HOSTS) expect(json(host.path())).toEqual(host.before);
    expect(kept()).toEqual(before);
    expect(readFileSync(join(home, ".siltpoke", "receipt.json"), "utf8")).toBe(receipt);
  });
});
