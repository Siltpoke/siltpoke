// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
// Copyright (c) 2026 Jiaqi Duan
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { UninstallEffects } from "../../src/cli/plugin-uninstall";
import { fsDiskProbes } from "../../src/cli/uninstall-disk";
import type { PlanItem } from "../../src/cli/uninstall-plan";
import { purgeItem, realOutsideTools } from "../../src/cli/uninstall-purge";
import { runUninstallCommand } from "../../src/cli/uninstall-run";
import { addProjectRoot, markDone, type NewReceiptEntry, readReceipt, recordBefore } from "../../src/installer/receipt";

// `[61]` PR 2, plan P4 (spec §4, §5; AC13–AC17): the purge level. Every command
// that leaves the process is a recorded fake; the home is a temp folder.

const MODEL = "qwen2.5-coder:7b-instruct-q4_K_M";
const PLC = "project-lifecycle@project-life-cycle";

let home: string;
let env: NodeJS.ProcessEnv;
let out: string;
let asked: string[];
/** Commands that would change the machine, as `cmd arg arg`. */
let ran: string[];
/** Outside tools that are on the machine, by receipt id. */
let tools: Set<string>;
/** Outside tools whose presence cannot be asked (the tool that would answer is not there). */
let unknown: Set<string>;
/** Project roots whose `.siltpoke/` git tracks; "?" = git is there and cannot answer. */
let git: Map<string, "tracked" | "?">;
let runStatus: number;
/** Codex's answer to "do you list the plugin"; null = there is no codex to ask. */
let codex: boolean | null;

function effects(): UninstallEffects {
  return {
    removeAutostart: async () => "not-installed",
    stopDaemon: async () => "not-running",
    removeMenubar: async () => ({ shim: false, loginItem: false }),
    codexListsPlugin: () => codex,
  };
}

function exec(cmd: string, args: string[]): { status: number; stdout: string } {
  if (cmd !== "git" || args[0] !== "-C") return { status: 1, stdout: "" };
  const answer = git.get(args[1] as string);
  if (answer === "?") return { status: 128, stdout: "" };
  return { status: 0, stdout: answer === "tracked" ? ".siltpoke/session-baseline.json\n" : "" };
}

async function run(args: string[], opts: { tty?: boolean; answers?: boolean[] } = {}): Promise<number> {
  const answers = [...(opts.answers ?? [])];
  out = "";
  return runUninstallCommand(args, env, {
    effects: effects(),
    probes: fsDiskProbes(exec, "darwin", (t) => (unknown.has(t.id) ? null : tools.has(t.id))),
    undo: { exec: () => ({ status: 1, stdout: "" }), platform: "darwin" },
    purge: { run: (cmd, a) => { ran.push([cmd, ...a].join(" ")); return { status: runStatus, stdout: "" }; } },
    isTTY: opts.tty ?? false,
    ask: async (q) => { asked.push(q); return answers.shift() ?? false; },
    write: (t) => { out += t; },
  });
}

const planId = async () => {
  await run(["--plan", "--json"]);
  return (JSON.parse(out) as { planId: string }).planId;
};
const remove = async (group: string, flags: string[] = ["--purge"]) =>
  run([...flags, "--plan-id", await planId(), "--remove", group]);
const record = (entry: NewReceiptEntry) => {
  recordBefore(entry, env, { version: "1.0.0" });
  markDone(entry.id, env);
};
const tool = (id: string, target: string, byUs: boolean, undo: Record<string, unknown>): NewReceiptEntry =>
  ({ id, kind: "outside-tool", target, byUs, level: "purge", undo });
const model = (byUs: boolean) => tool("tool:ollama-model", MODEL, byUs, { type: "ollama-rm", model: MODEL });
const plc = (byUs: boolean) => tool("tool:plc", PLC, byUs, { type: "claude-plugin-uninstall", plugin: PLC });
const setRegistered = (installed: boolean) =>
  writeFileSync(
    join(home, ".claude", "plugins", "installed_plugins.json"),
    JSON.stringify({ version: 2, plugins: installed ? { "siltpoke@siltpoke": [{}] } : {} }),
  );
/** A project folder with a `.siltpoke/` in it; returns the project root. */
function project(name: string, opts: { repo?: boolean } = {}): string {
  const root = join(home, "work", name);
  mkdirSync(join(root, ".siltpoke"), { recursive: true });
  writeFileSync(join(root, ".siltpoke", "session-baseline.json"), "{}");
  writeFileSync(join(root, "README.md"), name);
  if (opts.repo) mkdirSync(join(root, ".git"));
  return root;
}
const backup = (name: string) => join(home, ".claude", name);

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "siltpoke-purge-"));
  env = { HOME: home };
  asked = [];
  ran = [];
  tools = new Set();
  unknown = new Set();
  git = new Map();
  runStatus = 0;
  codex = false;
  mkdirSync(join(home, ".claude", "plugins"), { recursive: true });
  mkdirSync(join(home, ".siltpoke"), { recursive: true });
  writeFileSync(join(home, ".siltpoke", "config.json"), JSON.stringify({ name: "Velvettwirl" }));
  // Nothing points into ~/.siltpoke: the data folder's own gates are not what is under test here.
  writeFileSync(join(home, ".claude", "settings.json"), `${JSON.stringify({ theme: "dark" })}\n`);
  setRegistered(false);
});
afterEach(() => { rmSync(home, { recursive: true, force: true }); });

describe("project folders — where they are read from (AC15)", () => {
  test("a root from the receipt and a root from ~/.siltpoke/projects/*/memory.json are both listed", async () => {
    const a = project("a");
    const b = project("b");
    addProjectRoot(a, env);
    mkdirSync(join(home, ".siltpoke", "projects", "abc123"), { recursive: true });
    writeFileSync(join(home, ".siltpoke", "projects", "abc123", "memory.json"), JSON.stringify({ project_root: b }));
    await run(["--plan", "--purge"]);
    expect(out).toContain(`will be removed: Siltpoke's review data for this project: ${join(a, ".siltpoke")}`);
    expect(out).toContain(`will be removed: Siltpoke's review data for this project: ${join(b, ".siltpoke")}`);
  });

  test("a recorded project with no .siltpoke/ folder in it is not listed at all", async () => {
    const a = project("a");
    rmSync(join(a, ".siltpoke"), { recursive: true });
    addProjectRoot(a, env);
    await run(["--plan", "--purge"]);
    expect(out).not.toContain("project-data");
  });

  test("a recorded root that is no longer there is named, and is not something to remove", async () => {
    addProjectRoot(join(home, "work", "moved-away"), env);
    await run(["--plan", "--purge"]);
    expect(out).toContain("[project-data]");
    expect(out).toContain("(listed only)");
    expect(out).toContain(`not found — the project is no longer at this path: Siltpoke's review data for this project: ${join(home, "work", "moved-away", ".siltpoke")}`);
  });

  test("the home folder recorded as a project never lists ~/.siltpoke as a project folder", async () => {
    addProjectRoot(home, env);
    await run(["--plan", "--purge"]);
    expect(out).not.toContain("project-data");
    expect(out).toContain("[user-data]");
  });
});

describe("project folders — removal (AC13, AC14)", () => {
  test("default level: nothing of the purge level is asked about or touched", async () => {
    const a = project("a");
    addProjectRoot(a, env);
    writeFileSync(backup("settings.json.pre-siltpoke-2026-10-01T00-00-00-000Z.json"), "{}");
    record(model(true));
    tools.add("tool:ollama-model");
    // One default-level group, so that a yes is in fact given and acted on.
    writeFileSync(join(home, ".siltpoke", "siltpoked.pid"), "4242");
    expect(await run([], { tty: true, answers: [true, true, true, true, true] })).toBe(0);
    expect(asked).toEqual(["Remove The Siltpoke dashboard?"]);
    expect(ran).toEqual([]);
    expect(existsSync(join(a, ".siltpoke", "session-baseline.json"))).toBe(true);
    expect(existsSync(backup("settings.json.pre-siltpoke-2026-10-01T00-00-00-000Z.json"))).toBe(true);
    expect(existsSync(join(home, ".siltpoke", "config.json"))).toBe(true);
  });

  test("without --purge the group is refused and the folder stays", async () => {
    const a = project("a");
    addProjectRoot(a, env);
    expect(await remove("project-data", [])).toBe(2);
    expect(out).toContain("needs --purge");
    expect(existsSync(join(a, ".siltpoke"))).toBe(true);
  });

  test("with --purge the folder is deleted and the rest of the project is not", async () => {
    const a = project("a", { repo: true });
    addProjectRoot(a, env);
    expect(await remove("project-data")).toBe(0);
    expect(existsSync(join(a, ".siltpoke"))).toBe(false);
    expect(readFileSync(join(a, "README.md"), "utf8")).toBe("a");
    expect(existsSync(join(a, ".git"))).toBe(true);
  });

  test("a folder git tracks is kept and named, while the untracked one beside it goes", async () => {
    const tracked = project("tracked", { repo: true });
    const plain = project("plain", { repo: true });
    git.set(tracked, "tracked");
    addProjectRoot(tracked, env);
    addProjectRoot(plain, env);
    await run(["--plan", "--purge"]);
    expect(out).toContain(`kept — git tracks files in it, so it is part of that project: Siltpoke's review data for this project: ${join(tracked, ".siltpoke")}`);
    expect(await remove("project-data")).toBe(0);
    expect(existsSync(join(tracked, ".siltpoke", "session-baseline.json"))).toBe(true);
    expect(existsSync(join(plain, ".siltpoke"))).toBe(false);
  });

  test("inside a repository where git cannot answer, the folder is kept and named", async () => {
    const a = project("a", { repo: true });
    git.set(a, "?");
    addProjectRoot(a, env);
    await run(["--plan", "--purge"]);
    expect(out).toContain("(listed only)");
    expect(out).toContain(`kept — git could not say whether it tracks this folder: Siltpoke's review data for this project: ${join(a, ".siltpoke")}`);
    expect(await remove("project-data")).toBe(2);
    expect(existsSync(join(a, ".siltpoke"))).toBe(true);
  });

  test("a repository found only in a parent folder still counts: git is asked", async () => {
    const outer = join(home, "work", "mono");
    const inner = join(outer, "packages", "x");
    mkdirSync(join(inner, ".siltpoke"), { recursive: true });
    mkdirSync(join(outer, ".git"));
    git.set(inner, "tracked");
    addProjectRoot(inner, env);
    await run(["--plan", "--purge"]);
    expect(out).toContain("kept — git tracks files in it");
  });
});

describe("the executor checks again at the moment of removal", () => {
  const probes = () => fsDiskProbes(exec, "darwin", () => false);
  const purge = { run: () => ({ status: 0, stdout: "" }) };
  const item = (target: string, root: string): PlanItem =>
    ({ id: `data:project:${root}`, kind: "user-data", target, byUs: null, source: "disk", status: "remove", undo: null });

  test("a folder that became tracked after the plan was made is not deleted", () => {
    const a = project("a", { repo: true });
    git.set(a, "tracked");
    const r = purgeItem(item(join(a, ".siltpoke"), a), env, probes(), purge);
    expect(r?.outcome).toBe("not-done");
    expect(existsSync(join(a, ".siltpoke"))).toBe(true);
  });

  test("a link named .siltpoke is not followed and not deleted", () => {
    const real = join(home, "precious");
    mkdirSync(real);
    writeFileSync(join(real, "keep.txt"), "keep");
    const root = join(home, "work", "linked");
    mkdirSync(root, { recursive: true });
    symlinkSync(real, join(root, ".siltpoke"));
    const r = purgeItem(item(join(root, ".siltpoke"), root), env, probes(), purge);
    expect(r?.outcome).toBe("not-done");
    expect(readFileSync(join(real, "keep.txt"), "utf8")).toBe("keep");
  });

  test("a target that is not a .siltpoke folder is not deleted, whatever the id says", () => {
    const a = project("a");
    const r = purgeItem(item(a, a), env, probes(), purge);
    expect(r?.outcome).toBe("not-done");
    expect(existsSync(join(a, "README.md"))).toBe(true);
  });

  test("the data folder itself is never deleted as a project folder", () => {
    const r = purgeItem(item(join(home, ".siltpoke"), home), env, probes(), purge);
    expect(r?.outcome).toBe("not-done");
    expect(existsSync(join(home, ".siltpoke", "config.json"))).toBe(true);
  });

  // Review round 1, I1: the home folder under another spelling. A link stands in
  // for "another case on a case-insensitive disk" — both are one folder, two strings.
  test("the data folder reached through another spelling of the home folder is not deleted, and not listed", async () => {
    const alias = join(home, "alias-of-home");
    symlinkSync(home, alias);
    const r = purgeItem(item(join(alias, ".siltpoke"), alias), env, probes(), purge);
    expect(r?.outcome).toBe("not-done");
    expect(existsSync(join(home, ".siltpoke", "config.json"))).toBe(true);
    addProjectRoot(alias, env);
    await run(["--plan", "--purge"]);
    expect(out).not.toContain("project-data");
  });

  test("a .siltpoke folder inside the data folder is not a project folder", () => {
    // `..weird` is a folder name, not a step up (review round 2, M-a).
    for (const name of ["app", "..weird"]) {
      const inner = join(home, ".siltpoke", name);
      mkdirSync(join(inner, ".siltpoke"), { recursive: true });
      const r = purgeItem(item(join(inner, ".siltpoke"), inner), env, probes(), purge);
      expect(r?.outcome).toBe("not-done");
      expect(existsSync(join(inner, ".siltpoke"))).toBe(true);
    }
  });

  test("a project beside the data folder whose name only starts the same way IS a project folder", () => {
    const beside = join(home, ".siltpoke-old", "proj");
    mkdirSync(join(beside, ".siltpoke"), { recursive: true });
    const r = purgeItem(item(join(beside, ".siltpoke"), beside), env, probes(), purge);
    expect(r?.outcome).toBe("done");
    expect(existsSync(join(beside, ".siltpoke"))).toBe(false);
  });

  test("with SILTPOKE_HOME elsewhere, the account's own ~/.siltpoke is still not a project folder", () => {
    const elsewhere = { HOME: home, SILTPOKE_HOME: join(home, "sandbox-data") };
    mkdirSync(join(home, "sandbox-data"));
    const r = purgeItem(item(join(home, ".siltpoke"), home), elsewhere, probes(), purge);
    expect(r?.outcome).toBe("not-done");
    expect(existsSync(join(home, ".siltpoke", "config.json"))).toBe(true);
  });

  // Review round 1, I2: the repository is above the folder the link points at.
  test("a root that is a link into a repository's subfolder: git is still asked, and a tracked folder is kept", async () => {
    const repo = join(home, "work", "repo");
    const sub = join(repo, "sub");
    mkdirSync(join(sub, ".siltpoke"), { recursive: true });
    writeFileSync(join(sub, ".siltpoke", "tracked.json"), "{}");
    mkdirSync(join(repo, ".git"));
    const link = join(home, "link-to-sub");
    symlinkSync(sub, link);
    git.set(link, "tracked");
    const r = purgeItem(item(join(link, ".siltpoke"), link), env, probes(), purge);
    expect(r?.outcome).toBe("not-done");
    expect(existsSync(join(sub, ".siltpoke", "tracked.json"))).toBe(true);
    addProjectRoot(link, env);
    await run(["--plan", "--purge"]);
    expect(out).toContain("kept — git tracks files in it");
  });

  test("a backup item pointing outside Claude's settings folder is not deleted", () => {
    const stray = join(home, "settings.json.pre-siltpoke-x.json");
    writeFileSync(stray, "{}");
    const r = purgeItem({ id: `backup:${stray}`, kind: "user-data", target: stray, byUs: null, source: "disk", status: "remove", undo: null }, env, probes(), purge);
    expect(r?.outcome).toBe("not-done");
    expect(existsSync(stray)).toBe(true);
  });
});

describe("settings backups", () => {
  test("the timestamped copies and the pointer are listed, and deleted on a yes; settings.json stays", async () => {
    const first = backup("settings.json.pre-siltpoke-2026-10-01T00-00-00-000Z.json");
    const second = backup("settings.json.pre-siltpoke-2026-10-02T00-00-00-000Z.json");
    writeFileSync(first, "{}");
    writeFileSync(second, "{}");
    symlinkSync(second, backup("settings.json.pre-siltpoke"));
    writeFileSync(backup("settings.json.bak"), "mine");
    await run(["--plan", "--purge"]);
    expect(out).toContain(`will be removed: the settings copy ${first}`);
    expect(await remove("settings-backups")).toBe(0);
    expect(readdirSync(join(home, ".claude")).sort()).toEqual(["plugins", "settings.json", "settings.json.bak"]);
  });

  test("more than five are counted on one line, and all of them still go on a yes", async () => {
    for (let day = 1; day <= 6; day++) writeFileSync(backup(`settings.json.pre-siltpoke-2026-10-0${day}T00-00-00-000Z.json`), "{}");
    await run(["--plan", "--purge"]);
    expect(out).toContain(`will be removed: 6 files in ${join(home, ".claude")} — every one whose name starts with settings.json.pre-siltpoke`);
    expect(out).not.toContain("the settings copy");
    expect(await remove("settings-backups")).toBe(0);
    expect(readdirSync(join(home, ".claude")).sort()).toEqual(["plugins", "settings.json"]);
  });
});

describe("while the plugin is still installed, nothing of the purge level is removed", () => {
  test("project folders, backups and an outside tool are each refused, with the host named", async () => {
    const a = project("a");
    addProjectRoot(a, env);
    writeFileSync(backup("settings.json.pre-siltpoke-2026-10-01T00-00-00-000Z.json"), "{}");
    record(model(true));
    tools.add("tool:ollama-model");
    setRegistered(true);
    for (const group of ["project-data", "settings-backups", "tool:ollama-model"]) {
      expect(await remove(group)).toBe(1);
      expect(out).toContain("not removed — the Siltpoke plugin is still installed in Claude Code");
    }
    expect(ran).toEqual([]);
    expect(existsSync(join(a, ".siltpoke"))).toBe(true);
    expect(existsSync(backup("settings.json.pre-siltpoke-2026-10-01T00-00-00-000Z.json"))).toBe(true);
  });

  test("when no host can say whether the plugin is installed, it is refused too", async () => {
    rmSync(join(home, ".claude", "plugins"), { recursive: true });
    codex = null;
    const a = project("a");
    addProjectRoot(a, env);
    expect(await remove("project-data")).toBe(1);
    expect(out).toContain("could not tell whether its plugin is still installed");
    expect(existsSync(join(a, ".siltpoke"))).toBe(true);
  });
});

describe("a data folder that was refused says so on its first line, like the other purge groups", () => {
  const NO_OP = "nothing needed changing";
  /** The lines under the group's header, up to the numbered steps. */
  const firstLines = () => out.split("  Still to do:")[0] as string;

  test("plugin still installed: 'not removed', with the host named — and the steps still follow", async () => {
    setRegistered(true);
    expect(await remove("user-data")).toBe(1);
    expect(firstLines()).toContain("  ! not removed — the Siltpoke plugin is still installed in Claude Code.\n");
    expect(out).not.toContain(NO_OP);
    expect(out).toContain("Still to do:");
    expect(existsSync(join(home, ".siltpoke", "config.json"))).toBe(true);
  });

  test("no host can say whether the plugin is installed: 'not removed'", async () => {
    rmSync(join(home, ".claude", "plugins"), { recursive: true });
    codex = null;
    expect(await remove("user-data")).toBe(1);
    expect(firstLines()).toContain("  ! not removed — Siltpoke could not tell whether its plugin is still installed.\n");
    expect(out).not.toContain(NO_OP);
  });

  test("settings still point into the folder: 'not removed'", async () => {
    const command = `sh ${join(home, ".siltpoke", "bin", "statusline.sh")}`;
    writeFileSync(join(home, ".claude", "settings.json"), JSON.stringify({ statusLine: { type: "command", command } }));
    expect(await remove("user-data")).toBe(1);
    expect(firstLines()).toContain("  ! not removed — Claude Code's settings still point into this folder.\n");
    expect(out).not.toContain(NO_OP);
  });

  test("a settings.json that cannot be read: 'not removed', and it does not claim to have seen where the settings point", async () => {
    writeFileSync(join(home, ".claude", "settings.json"), "{ not json");
    expect(await remove("user-data")).toBe(1);
    expect(firstLines()).toContain("  ! not removed — Claude Code's settings.json cannot be read, so Siltpoke cannot tell whether it still needs this folder.\n");
    expect(firstLines()).not.toContain("still point into");
    expect(out).not.toContain(NO_OP);
  });

  test("two hosts still have the plugin: both are named", async () => {
    setRegistered(true);
    codex = true;
    expect(await remove("user-data")).toBe(1);
    expect(firstLines()).toMatch(/ {2}! not removed — the Siltpoke plugin is still installed in Claude Code, [^\n]*[Cc]odex[^\n]*\.\n/);
  });

  // root can empty a folder whatever its mode, so there is no failure to report.
  test.skipIf(process.getuid?.() === 0)("a delete that failed is 'could not finish', never 'nothing needed changing'", async () => {
    // A folder that cannot be listed cannot be emptied.
    const locked = join(home, ".siltpoke", "locked");
    mkdirSync(locked);
    writeFileSync(join(locked, "file"), "x");
    chmodSync(locked, 0o000);
    try {
      expect(await remove("user-data")).toBe(1);
    } finally {
      chmodSync(locked, 0o700);
    }
    expect(out).toContain("  ! could not finish — delete ~/.siltpoke");
    expect(out).not.toContain(NO_OP);
  });

  test("a folder that was deleted says that, and not 'nothing needed changing' as well", async () => {
    expect(await remove("user-data")).toBe(0);
    expect(out).toContain("  - your Siltpoke data (~/.siltpoke): deleted\n");
    expect(out).not.toContain(NO_OP);
    expect(out).not.toContain("not removed —");
  });

  test("control: a group that really had nothing to change still says so", async () => {
    // A pidfile makes the dashboard group; no server answers and no start-at-login is there.
    writeFileSync(join(home, ".siltpoke", "siltpoked.pid"), "4242");
    await remove("dashboard", []);
    expect(out).toContain(`  - ${NO_OP}\n`);
    expect(out).not.toContain("not removed —");
  });
});

describe("outside tools Siltpoke installed (AC16)", () => {
  test("the model is its own group: the tag and the warning are on its line, and a yes runs `ollama rm` on that tag", async () => {
    record(model(true));
    tools.add("tool:ollama-model");
    await run(["--plan", "--purge"]);
    expect(out).toContain(`will be removed: the Ollama model ${MODEL} — you may be using this elsewhere`);
    expect(await remove("tool:ollama-model")).toBe(0);
    expect(ran).toEqual([`ollama rm ${MODEL}`]);
  });

  test("in the terminal loop each tool is asked on its own, and a No runs nothing", async () => {
    record(model(true));
    record(tool("tool:swiftbar", join(home, "SwiftBar.app"), true, { type: "brew-uninstall-cask", cask: "swiftbar" }));
    tools.add("tool:ollama-model").add("tool:swiftbar");
    await run(["--purge"], { tty: true, answers: [false, true, false] });
    expect(asked).toEqual([
      "Remove The local model Siltpoke pulled into Ollama?",
      "Remove The SwiftBar app?",
      expect.stringContaining("Remove Your Siltpoke data"),
    ]);
    expect(ran).toEqual(["brew uninstall --cask swiftbar"]);
  });

  test("a tool the receipt says was already there is listed and cannot be removed", async () => {
    record(model(false));
    tools.add("tool:ollama-model");
    expect(await remove("tool:ollama-model")).toBe(2);
    expect(out).toContain("listed only");
    expect(ran).toEqual([]);
  });

  test("a command that fails is reported with the command, and the call exits 1", async () => {
    record(model(true));
    tools.add("tool:ollama-model");
    runStatus = 1;
    expect(await remove("tool:ollama-model")).toBe(1);
    expect(out).toContain(`could not finish — \`ollama rm ${MODEL}\` failed`);
  });

  test("a recorded value that would be read as an option is never passed to a command", async () => {
    record(tool("tool:ollama-model", "--all", true, { type: "ollama-rm", model: "--all" }));
    tools.add("tool:ollama-model");
    expect(await remove("tool:ollama-model")).toBe(1);
    expect(ran).toEqual([]);
  });

  test("the plugin: offered when no settings file enables it, with what cannot be checked said on its line", async () => {
    record(plc(true));
    tools.add("tool:plc");
    await run(["--plan", "--purge"]);
    expect(out).toContain(`will be removed: the Claude Code plugin ${PLC} — you may be using this elsewhere; projects Siltpoke never opened cannot be checked`);
    expect(await remove("tool:plc")).toBe(0);
    expect(ran).toEqual([`claude plugin uninstall ${PLC}`]);
  });

  test("the plugin: not offered while the user's own settings enable it, and the file is named", async () => {
    record(plc(true));
    tools.add("tool:plc");
    writeFileSync(join(home, ".claude", "settings.json"), JSON.stringify({ enabledPlugins: { [PLC]: true } }));
    expect(await remove("tool:plc")).toBe(2);
    expect(out).toContain("listed only");
    await run(["--plan", "--purge"]);
    expect(out).toContain(`kept — a settings file still enables it: the Claude Code plugin ${PLC} (enabled in ${join(home, ".claude", "settings.json")})`);
    expect(ran).toEqual([]);
  });

  test("the plugin: not offered while a known project enables it", async () => {
    record(plc(true));
    tools.add("tool:plc");
    const a = project("a");
    addProjectRoot(a, env);
    mkdirSync(join(a, ".claude"));
    writeFileSync(join(a, ".claude", "settings.local.json"), JSON.stringify({ enabledPlugins: { [PLC]: true } }));
    await run(["--plan", "--purge"]);
    expect(out).toContain(`(enabled in ${join(a, ".claude", "settings.local.json")})`);
    expect(out).not.toContain(`will be removed: the Claude Code plugin`);
  });

  test("the plugin: a settings file that cannot be parsed but names it counts as enabling it", async () => {
    record(plc(true));
    tools.add("tool:plc");
    writeFileSync(join(home, ".claude", "settings.local.json"), `{ // my notes\n "enabledPlugins": { "${PLC}": true } }`);
    await run(["--plan", "--purge"]);
    expect(out).toContain(`(enabled in ${join(home, ".claude", "settings.local.json")})`);
  });

  test("the command is built from the name the plan shows, never from the receipt's undo", async () => {
    record(tool("tool:ollama-model", MODEL, true, { type: "ollama-rm", model: "some-other-model:latest" }));
    tools.add("tool:ollama-model");
    expect(await remove("tool:ollama-model")).toBe(0);
    expect(ran).toEqual([`ollama rm ${MODEL}`]);
  });

  test("the plugin: a settings file that switches it off does not count as enabling it", async () => {
    record(plc(true));
    tools.add("tool:plc");
    writeFileSync(join(home, ".claude", "settings.json"), JSON.stringify({ enabledPlugins: { [PLC]: false } }));
    await run(["--plan", "--purge"]);
    expect(out).toContain("will be removed: the Claude Code plugin");
  });
});

describe("what is never offered (AC17)", () => {
  test("a general tool is one line with no command, even when the receipt says Siltpoke installed it", async () => {
    record(tool("tool:bun", "bun", true, { type: "none" }));
    tools.add("tool:bun");
    await run(["--purge"], { tty: true, answers: [true, true, true] });
    expect(asked.some((q) => q.includes("General tools"))).toBe(false);
    expect(out).toContain("- bun: other things may need it\n");
    expect(ran).toEqual([]);
  });

  test("a tool found with no receipt is listed once, with its command and that its owner is unknown", async () => {
    tools.add("tool:ollama-model").add("tool:plc");
    await run(["--plan", "--purge"]);
    expect(out).toContain(`kept — Siltpoke cannot tell who installed this: the Ollama model ${MODEL} (to remove it yourself: ollama rm ${MODEL})`);
    expect(out).toContain(`(to remove it yourself: claude plugin uninstall ${PLC})`);
    expect(out.split(`the Ollama model ${MODEL}`).length - 1).toBe(1);
    expect(await remove("tool:ollama-model")).toBe(2);
    expect(ran).toEqual([]);
  });

  test("a tool that is neither recorded nor on the machine is not listed", async () => {
    await run(["--plan", "--purge"]);
    expect(out).not.toContain("Ollama");
    expect(out).not.toContain("project-lifecycle");
  });
});

describe("the executor removes a tool only on the receipt's word", () => {
  const probes = () => fsDiskProbes(exec, "darwin", () => true);
  const purge = { run: (cmd: string, a: string[]) => { ran.push([cmd, ...a].join(" ")); return { status: 0, stdout: "" }; } };
  const item = (byUs: boolean | null): PlanItem =>
    ({ id: "tool:ollama-model", kind: "outside-tool", target: MODEL, byUs, source: "receipt", status: "remove", undo: { type: "ollama-rm", model: MODEL } });

  test("recorded as already there, or not recorded at all: no command is run", () => {
    expect(purgeItem(item(false), env, probes(), purge)?.outcome).toBe("nothing");
    expect(purgeItem(item(null), env, probes(), purge)?.outcome).toBe("nothing");
    expect(ran).toEqual([]);
  });

  test("a general tool has no removal command, even marked as ours and removable", () => {
    const bun: PlanItem = { id: "tool:bun", kind: "outside-tool", target: "bun", byUs: true, source: "receipt", status: "remove", undo: { type: "none" } };
    expect(purgeItem(bun, env, probes(), purge)).toBeNull();
    expect(ran).toEqual([]);
  });
});

describe("the real answers about outside tools", () => {
  let probed: string[];
  let listing: { status: number; stdout: string };
  const real = () =>
    realOutsideTools(
      (cmd, a) => { probed.push([cmd, ...a].join(" ")); return listing; },
      (cmd, a) => { ran.push([cmd, ...a].join(" ")); return { status: 0, stdout: "" }; },
    );
  beforeEach(() => { probed = []; listing = { status: 0, stdout: "" }; });

  test("the model: listed ⇒ yes, not listed ⇒ no, `ollama list` failing ⇒ could not ask", () => {
    listing = { status: 0, stdout: `NAME\n${MODEL}  abc  4.7 GB\n` };
    expect(real().toolPresent({ id: "tool:ollama-model", target: MODEL })).toBe(true);
    listing = { status: 0, stdout: "NAME\nllama3:latest  abc  4.7 GB\n" };
    expect(real().toolPresent({ id: "tool:ollama-model", target: MODEL })).toBe(false);
    // A longer tag that only starts with ours is a different model.
    listing = { status: 0, stdout: `NAME\n${MODEL}-mine  abc  4.7 GB\n` };
    expect(real().toolPresent({ id: "tool:ollama-model", target: MODEL })).toBe(false);
    listing = { status: 1, stdout: "" };
    expect(real().toolPresent({ id: "tool:ollama-model", target: MODEL })).toBeNull();
  });

  test("the plugin is looked up by its name in `claude plugin list`", () => {
    listing = { status: 0, stdout: "  ❯ project-lifecycle@project-life-cycle\n    Version: 3.6.0\n" };
    const tools = real();
    expect(tools.toolPresent({ id: "tool:plc", target: PLC })).toBe(true);
    expect(probed).toEqual(["claude plugin list"]);
  });

  test("the same question is asked once, and again after a removal command has run", () => {
    const tools = real();
    tools.toolPresent({ id: "tool:ollama-model", target: MODEL });
    tools.toolPresent({ id: "tool:ollama-model", target: MODEL });
    expect(probed).toEqual(["ollama list"]);
    tools.effects.run("ollama", ["rm", MODEL]);
    tools.toolPresent({ id: "tool:ollama-model", target: MODEL });
    expect(probed).toEqual(["ollama list", "ollama list"]);
    expect(ran).toEqual([`ollama rm ${MODEL}`]);
  });
});

describe("a tool whose presence cannot be asked", () => {
  test("recorded as ours: still offered — hiding a 4.7 GB model would be worse than one failed command", async () => {
    record(model(true));
    unknown.add("tool:ollama-model");
    await run(["--plan", "--purge"]);
    expect(out).toContain("will be removed: the Ollama model");
  });

  test("not recorded: not listed — most machines simply have no Ollama", async () => {
    unknown.add("tool:ollama-model");
    await run(["--plan", "--purge"]);
    expect(out).not.toContain("Ollama");
  });
});

describe("~/.siltpoke goes last, and the receipt outlives it only while it still has something to say", () => {
  test("in the terminal loop the data folder is asked after every other purge group", async () => {
    const a = project("a");
    addProjectRoot(a, env);
    writeFileSync(backup("settings.json.pre-siltpoke-2026-10-01T00-00-00-000Z.json"), "{}");
    record(model(true));
    tools.add("tool:ollama-model");
    await run(["--purge"], { tty: true });
    expect(asked.map((q) => q.slice(0, 28))).toEqual([
      "Remove Siltpoke's review dat",
      "Remove Copies of Claude Code",
      "Remove The local model Siltp",
      "Remove Your Siltpoke data (~",
    ]);
  });

  test("project roots are read before the folder that records them is deleted", async () => {
    const b = project("b");
    mkdirSync(join(home, ".siltpoke", "projects", "abc123"), { recursive: true });
    writeFileSync(join(home, ".siltpoke", "projects", "abc123", "memory.json"), JSON.stringify({ project_root: b }));
    await run(["--purge"], { tty: true, answers: [true, true] });
    expect(existsSync(join(b, ".siltpoke"))).toBe(false);
    expect(existsSync(join(home, ".siltpoke"))).toBe(false);
  });

  test("everything removed or gone: the whole folder is deleted, receipt included", async () => {
    record(model(true));
    expect(await remove("user-data")).toBe(0);
    expect(existsSync(join(home, ".siltpoke"))).toBe(false);
  });

  test("a tool the user kept: the folder is emptied except a receipt holding only that entry, and the output says so", async () => {
    record(model(true));
    record(tool("tool:bun", "bun", false, { type: "none" }));
    tools.add("tool:ollama-model").add("tool:bun");
    mkdirSync(join(home, ".siltpoke", "traces"));
    writeFileSync(join(home, ".siltpoke", "traces", "t.json"), "{}");
    expect(await remove("user-data")).toBe(0);
    expect(readdirSync(join(home, ".siltpoke"))).toEqual(["receipt.json"]);
    expect(readReceipt(env)?.entries.map((e) => e.id)).toEqual(["tool:ollama-model"]);
    expect(out).toContain("except receipt.json: it still records 1 thing Siltpoke installed that is still on this machine");
  });

  test("a plugin kept because it is still enabled stays in the receipt; projects whose folder is gone leave it", async () => {
    record(plc(true));
    tools.add("tool:plc");
    writeFileSync(join(home, ".claude", "settings.json"), JSON.stringify({ enabledPlugins: { [PLC]: true } }));
    const kept = project("kept", { repo: true });
    git.set(kept, "tracked");
    addProjectRoot(kept, env);
    addProjectRoot(join(home, "work", "moved-away"), env);
    expect(await remove("user-data")).toBe(0);
    const receipt = readReceipt(env);
    expect(receipt?.entries.map((e) => e.id)).toEqual(["tool:plc"]);
    expect(receipt?.projects).toEqual([kept]);
  });
});

// Defect [79]: a project folder the user said No to was forgotten the moment
// ~/.siltpoke went, because the list of projects went with it.
describe("a project folder the user kept is still offered after ~/.siltpoke is deleted ([79])", () => {
  test("No to the project, Yes to the data: the receipt stays with that root, and the next --purge plan lists it", async () => {
    const a = project("a");
    addProjectRoot(a, env);
    expect(await run(["--purge"], { tty: true, answers: [false, true] })).toBe(0);
    expect(existsSync(join(a, ".siltpoke"))).toBe(true);
    expect(readdirSync(join(home, ".siltpoke"))).toEqual(["receipt.json"]);
    expect(readReceipt(env)).toEqual({ version: 1, entries: [], projects: [a] });
    expect(out).toContain("except receipt.json: it still records 1 project folder still on this machine");
    await run(["--plan", "--purge"]);
    expect(out).toContain(`will be removed: Siltpoke's review data for this project: ${join(a, ".siltpoke")}`);
  });

  // The run above printed "except receipt.json" and, a few lines down, "There is no install receipt".
  test("the report does not say there is no receipt while one is on disk: during that run, and afterwards", async () => {
    addProjectRoot(project("a"), env);
    await run(["--purge"], { tty: true, answers: [false, true] });
    const sentence = "The install receipt on this machine lists 1 project folder Siltpoke wrote into, and nothing it installed.";
    expect(out).toContain("except receipt.json");
    expect(out).toContain(sentence);
    expect(out).not.toContain("There is no install receipt");
    await run(["--report", "--purge"]);
    expect(out).toContain(sentence);
    expect(out).not.toContain("There is no install receipt");
  });

  test("a run that writes the first receipt reports it, and a run that deletes the last one reports none", async () => {
    const b = project("b");
    mkdirSync(join(home, ".siltpoke", "projects", "abc123"), { recursive: true });
    writeFileSync(join(home, ".siltpoke", "projects", "abc123", "memory.json"), JSON.stringify({ project_root: b }));
    expect(readReceipt(env)).toBeNull();
    await run(["--purge"], { tty: true, answers: [false, true] });
    expect(readReceipt(env)?.projects).toEqual([b]);
    expect(out).toContain("The install receipt on this machine lists 1 project folder Siltpoke wrote into, and nothing it installed.");
    expect(out).not.toContain("There is no install receipt");
    await run(["--purge"], { tty: true, answers: [true, true] });
    expect(existsSync(join(home, ".siltpoke"))).toBe(false);
    expect(out).toContain("There is no install receipt on this machine");
    expect(out).not.toContain("The install receipt on this machine lists");
  });

  test("a project known only from ~/.siltpoke/projects, on a machine with no receipt: a receipt is written for it", async () => {
    const b = project("b");
    mkdirSync(join(home, ".siltpoke", "projects", "abc123"), { recursive: true });
    writeFileSync(join(home, ".siltpoke", "projects", "abc123", "memory.json"), JSON.stringify({ project_root: b }));
    expect(await remove("user-data")).toBe(0);
    expect(readdirSync(join(home, ".siltpoke"))).toEqual(["receipt.json"]);
    expect(readReceipt(env)?.projects).toEqual([b]);
    await run(["--plan", "--purge"]);
    expect(out).toContain(`will be removed: Siltpoke's review data for this project: ${join(b, ".siltpoke")}`);
  });

  test("a kept tool and two kept projects: the output counts both", async () => {
    record(model(true));
    tools.add("tool:ollama-model");
    addProjectRoot(project("a"), env);
    addProjectRoot(project("b"), env);
    expect(await remove("user-data")).toBe(0);
    expect(out).toContain(
      "except receipt.json: it still records 1 thing Siltpoke installed that is still on this machine and 2 project folders still on this machine",
    );
  });

});

describe("which folders are a reason to keep the receipt, which are not, and when it finally goes ([79])", () => {
  test("the home folder recorded as a project is never a project folder, so nothing is kept for it", async () => {
    addProjectRoot(home, env);
    expect(await remove("user-data")).toBe(0);
    expect(existsSync(join(home, ".siltpoke"))).toBe(false);
  });

  test("a recorded project that is no longer at its path keeps nothing", async () => {
    addProjectRoot(join(home, "work", "moved-away"), env);
    expect(await remove("user-data")).toBe(0);
    expect(existsSync(join(home, ".siltpoke"))).toBe(false);
  });

  test("a folder git tracks is not a reason to keep the receipt: Siltpoke will never remove it (review round 1)", async () => {
    const tracked = project("tracked", { repo: true });
    git.set(tracked, "tracked");
    addProjectRoot(tracked, env);
    expect(await remove("user-data")).toBe(0);
    expect(existsSync(join(home, ".siltpoke"))).toBe(false);
    expect(existsSync(join(tracked, ".siltpoke"))).toBe(true);
    expect(out).not.toContain("except receipt.json");
  });

  test("a folder git could not answer for IS a reason: a later run may get an answer and offer it", async () => {
    const unsure = project("unsure", { repo: true });
    git.set(unsure, "?");
    addProjectRoot(unsure, env);
    expect(await remove("user-data")).toBe(0);
    expect(readReceipt(env)).toEqual({ version: 1, entries: [], projects: [unsure] });
    git.delete(unsure);
    await run(["--plan", "--purge"]);
    expect(out).toContain(`will be removed: Siltpoke's review data for this project: ${join(unsure, ".siltpoke")}`);
  });

  test("a receipt kept for a removable folder also lists the git-tracked one beside it", async () => {
    const a = project("a");
    const tracked = project("tracked", { repo: true });
    git.set(tracked, "tracked");
    addProjectRoot(a, env);
    addProjectRoot(tracked, env);
    expect(await remove("user-data")).toBe(0);
    expect(readReceipt(env)?.projects).toEqual([a, tracked]);
    expect(out).toContain("it still records 2 project folders still on this machine");
  });

  test("in the terminal loop, Yes to the projects and Yes to the data leaves no receipt", async () => {
    const a = project("a");
    addProjectRoot(a, env);
    expect(await run(["--purge"], { tty: true, answers: [true, true] })).toBe(0);
    expect(existsSync(join(a, ".siltpoke"))).toBe(false);
    expect(existsSync(join(home, ".siltpoke"))).toBe(false);
  });

  test("a purge refused because the plugin is still installed leaves the receipt as it was and claims nothing", async () => {
    const a = project("a");
    addProjectRoot(a, env);
    const before = readFileSync(join(home, ".siltpoke", "receipt.json"), "utf8");
    setRegistered(true);
    expect(await remove("user-data")).not.toBe(0);
    expect(readFileSync(join(home, ".siltpoke", "receipt.json"), "utf8")).toBe(before);
    expect(existsSync(join(home, ".siltpoke", "config.json"))).toBe(true);
    expect(out).toContain("NOT deleted: while the plugin is installed");
    expect(out).not.toContain("except receipt.json");
  });

  test("once the kept project folder is removed too, the next data removal takes the receipt with it", async () => {
    const a = project("a");
    addProjectRoot(a, env);
    expect(await remove("user-data")).toBe(0);
    expect(await remove("project-data")).toBe(0);
    expect(existsSync(join(a, ".siltpoke"))).toBe(false);
    expect(await remove("user-data")).toBe(0);
    expect(existsSync(join(home, ".siltpoke"))).toBe(false);
  });
});
