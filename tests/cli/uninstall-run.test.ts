// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
// Copyright (c) 2026 Jiaqi Duan
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type MenubarTargets, realUninstallEffects, type UninstallEffects } from "../../src/cli/plugin-uninstall";
import { fsDiskProbes } from "../../src/cli/uninstall-disk";
import { runUninstallCommand } from "../../src/cli/uninstall-run";
import { addProjectRoot, markDone, readReceipt, recordBefore } from "../../src/installer/receipt";

// `[61]` PR 2, plan P2.2 / P2.2b (spec §3): the CLI shows one removal plan and
// removes only what is in it — one group per call, several only through its
// own y/N loop. Every machine-touching step is an injected effect; the home is
// a temp folder.

let home: string;
let env: NodeJS.ProcessEnv;
let calls: string[];
let out: string;
let asked: string[];
let menubarTargets: MenubarTargets | undefined;

const SHIM = '#!/bin/bash\nexec "/x/bun" "/x/dist/siltpoke-card.js" --menubar\n';

function effects(): UninstallEffects {
  return {
    removeAutostart: async () => { calls.push("autostart"); return "removed"; },
    stopDaemon: async () => { calls.push("daemon"); return "stopping"; },
    removeMenubar: async (targets) => { calls.push("menubar"); menubarTargets = targets; return { shim: true, loginItem: true }; },
    codexListsPlugin: () => false,
  };
}

async function run(args: string[], opts: { tty?: boolean; answers?: boolean[] } = {}): Promise<number> {
  const answers = [...(opts.answers ?? [])];
  out = "";
  return runUninstallCommand(args, env, {
    effects: effects(),
    // Every recorded tool is still installed; none that the receipt does not name is.
    probes: fsDiskProbes(() => ({ status: 1, stdout: "" }), "darwin", (t) => readReceipt(env)?.entries.some((e) => e.id === t.id) ?? false),
    undo: { exec: () => ({ status: 1, stdout: "" }), platform: "darwin" },
    purge: { run: () => ({ status: 1, stdout: "" }) },
    isTTY: opts.tty ?? false,
    ask: async (q) => { asked.push(q); return answers.shift() ?? false; },
    write: (t) => { out += t; },
  });
}

/** path → size:sha256 for every file under the home, so "nothing changed" is byte-level. */
function snapshot(dir: string = home, acc: Record<string, string> = {}): Record<string, string> {
  for (const name of readdirSync(dir).sort()) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) snapshot(p, acc);
    else acc[p] = `${statSync(p).size}:${createHash("sha256").update(readFileSync(p)).digest("hex")}`;
  }
  return acc;
}

const settingsPath = () => join(home, ".claude", "settings.json");
const settings = () => JSON.parse(readFileSync(settingsPath(), "utf8")) as { statusLine?: { command?: string }; theme?: string };
const planId = async (extra: string[] = []) => {
  await run(["--plan", "--json", ...extra]);
  return (JSON.parse(out) as { planId: string }).planId;
};
const setRegistered = (installed: boolean) =>
  writeFileSync(
    join(home, ".claude", "plugins", "installed_plugins.json"),
    JSON.stringify({ version: 2, plugins: installed ? { "siltpoke@siltpoke": [{}] } : {} }),
  );

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "siltpoke-uninstall-run-"));
  env = { HOME: home };
  calls = [];
  asked = [];
  menubarTargets = undefined;
  mkdirSync(join(home, ".claude", "plugins"), { recursive: true });
  mkdirSync(join(home, ".siltpoke"), { recursive: true });
  mkdirSync(join(home, "Library", "LaunchAgents"), { recursive: true });
  mkdirSync(join(home, "Library", "Application Support", "SwiftBar", "plugins"), { recursive: true });
  writeFileSync(join(home, ".siltpoke", "inner.txt"), "echo ORIGINAL");
  writeFileSync(join(home, ".siltpoke", "config.json"), JSON.stringify({ name: "Velvettwirl", daemon: { enabled: true } }));
  writeFileSync(join(home, ".siltpoke", "siltpoked.pid"), "4242");
  writeFileSync(join(home, "Library", "LaunchAgents", "io.siltpoke.daemon.plist"), "<plist/>");
  writeFileSync(join(home, "Library", "Application Support", "SwiftBar", "plugins", "siltpoke.1m.sh"), SHIM);
  writeFileSync(
    settingsPath(),
    `${JSON.stringify({ statusLine: { type: "command", command: `sh ${home}/.siltpoke/bin/statusline.sh` }, theme: "dark" }, null, 2)}\n`,
  );
  setRegistered(false);
});
afterEach(() => { rmSync(home, { recursive: true, force: true }); });

describe("uninstall --plan — shows, changes nothing", () => {
  test("lists each group with its id and the plan id, and leaves every file in the home byte-identical", async () => {
    const before = snapshot();
    expect(await run(["--plan"])).toBe(0);
    expect(snapshot()).toEqual(before);
    expect(calls).toEqual([]);
    for (const id of ["claude-code", "dashboard", "menubar", "user-data"]) expect(out).toContain(`[${id}]`);
    expect(out).toMatch(/plan [0-9a-f]{12}/);
    // A file siltpoke only edits is never shown as a file that goes.
    expect(out).toContain(`Siltpoke's status line in ${settingsPath()} (the rest of the file stays)`);
    expect(out).not.toContain(`will be removed: ${settingsPath()}`);
    expect(out).toContain("the running dashboard server (it is stopped)");
    expect(out).not.toContain("siltpoked.pid");
    // Purge-level groups say what they need.
    expect(out).toMatch(/\[user-data\][^\n]*--purge/);
  });

  test("--json is the same plan as data", async () => {
    expect(await run(["--plan", "--json"])).toBe(0);
    const plan = JSON.parse(out) as { planId: string; groups: { id: string; offer: string }[] };
    expect(plan.groups.map((g) => g.id)).toEqual(["claude-code", "dashboard", "menubar", "user-data"]);
    await run(["--plan"]);
    expect(out).toContain(plan.planId);
  });

  test("a bootstrap note is NOT folded into the receipt by --plan", async () => {
    writeFileSync(join(home, ".siltpoke", "receipt-bootstrap.json"), '{"id":"tool:bun","byUs":true,"state":"done"}');
    await run(["--plan"]);
    expect(existsSync(join(home, ".siltpoke", "receipt-bootstrap.json"))).toBe(true);
    expect(readReceipt(env)).toBeNull();
  });
});

describe("uninstall with no --remove", () => {
  test("no terminal: prints the plan, removes nothing, exits 3", async () => {
    const before = snapshot();
    expect(await run([])).toBe(3);
    expect(snapshot()).toEqual(before);
    expect(calls).toEqual([]);
    expect(asked).toEqual([]);
    expect(out).toContain("[claude-code]");
    expect(out).toContain("Nothing was removed");
  });

  test("with a terminal: asks once per offered group, in plan order, and removes only the ones answered yes", async () => {
    expect(await run([], { tty: true, answers: [true, false, true] })).toBe(0);
    expect(asked.length).toBe(3);
    expect(asked[0]).toContain("Claude Code");
    expect(asked[1]).toContain("dashboard");
    expect(asked[2]).toContain("menu-bar");
    // Real run, 2026-10-05: the group line was printed again after the answer.
    // (The report after the loop names a group once more; this is about the loop itself.)
    const loop = out.split("Siltpoke uninstall — report")[0] ?? "";
    for (const id of ["claude-code", "dashboard", "menubar"]) expect(loop.split(`[${id}]`).length - 1).toBe(1);
    // A title names the place only: this group holds a status line and nothing else.
    expect(asked[0]).not.toMatch(/hooks|slash/);
    expect(asked[2]).not.toMatch(/login item|setting/);
    expect(out).toContain("the pet's SwiftBar plugin script");
    expect(settings().statusLine?.command).toBe("echo ORIGINAL");
    expect(calls).toEqual(["menubar"]); // the dashboard was answered no
    expect(existsSync(join(home, ".siltpoke"))).toBe(true); // purge level was never asked
  });

  test("with a terminal: a group that is only listed is never asked, and the report says why it was left", async () => {
    // Only the pref is in the menu-bar group, and the receipt says it was the user's.
    recordBefore({ id: "pref:com.ameba.SwiftBar.PluginDirectory", kind: "macos-pref", target: "com.ameba.SwiftBar", byUs: false, level: "uninstall", undo: { type: "from-a-newer-version" } }, env);
    rmSync(join(home, "Library", "Application Support", "SwiftBar", "plugins", "siltpoke.1m.sh"));
    await run([], { tty: true });
    expect(asked.length).toBe(2); // Claude Code, the dashboard
    expect(asked.join("\n")).not.toContain("menu-bar");
    expect(out).toMatch(/Left in place[^\n]*:\n[\s\S]*the macOS setting com\.ameba\.SwiftBar\.PluginDirectory: it was there before Siltpoke/);
    expect(calls).toEqual([]);
  });

  test("with a terminal and every answer no: nothing changes, a bootstrap note included", async () => {
    writeFileSync(join(home, ".siltpoke", "receipt-bootstrap.json"), '{"id":"tool:bun","byUs":true,"state":"done"}');
    const before = snapshot();
    expect(await run([], { tty: true })).toBe(0);
    expect(snapshot()).toEqual(before);
    expect(calls).toEqual([]);
  });

  test("with a terminal and --purge: the data folder is asked for too, last", async () => {
    await run(["--purge"], { tty: true });
    expect(asked.length).toBe(4);
    expect(asked[3]).toContain("~/.siltpoke");
    expect(existsSync(join(home, ".siltpoke"))).toBe(true); // answered no
  });

  // Real run, 2026-10-05: "only Siltpoke's plugin inside it was removed" was printed after a No to the menu bar.
  test("the closing list never claims a SwiftBar removal: the call that prints it does not touch the menu bar", async () => {
    await run(["--plan-id", await planId(), "--remove", "claude-code"]);
    expect(await run(["--purge"], { tty: true, answers: [false, false, true] })).toBe(0);
    expect(out).toContain("Left in place — not Siltpoke's to remove:");
    expect(out).not.toContain("inside it was removed");
  });
});

describe("uninstall --plan-id <p> --remove <group> — exactly one group", () => {
  test("removes that group and nothing else, then names the new plan id", async () => {
    const id = await planId();
    expect(await run(["--plan-id", id, "--remove", "claude-code"])).toBe(0);
    expect(settings()).toEqual({ statusLine: { type: "command", command: "echo ORIGINAL" }, theme: "dark" } as never);
    expect(calls).toEqual([]);
    expect(out).toContain("your own status line is back");
    expect(out.split("[claude-code]").length - 1).toBe(1); // a single call names its group, once
    const next = await planId();
    expect(next).not.toBe(id);
    await run(["--plan-id", next, "--remove", "menubar"]);
    expect(out).toMatch(/plan is now [0-9a-f]{12}/);
  });

  test("the dashboard group removes start-at-login, switches the daemon off in config, and stops the server", async () => {
    expect(await run(["--plan-id", await planId(), "--remove", "dashboard"])).toBe(0);
    expect(calls).toEqual(["autostart", "daemon"]);
    expect(JSON.parse(readFileSync(join(home, ".siltpoke", "config.json"), "utf8")).daemon.enabled).toBe(false);
    expect(settings().statusLine?.command).toContain("statusline.sh"); // another group's
  });

  test("the menu-bar group goes through the menu-bar effect only", async () => {
    expect(await run(["--plan-id", await planId(), "--remove", "menubar"])).toBe(0);
    expect(calls).toEqual(["menubar"]);
  });

  for (const [name, args] of [
    ["a plan id that is not the current plan's", (_id: string) => ["--plan-id", "000000000000", "--remove", "claude-code"]],
    ["no plan id at all", (_id: string) => ["--remove", "claude-code"]],
    ["a group that is not in the plan", (id: string) => ["--plan-id", id, "--remove", "codex"]],
    ["an invented group", (id: string) => ["--plan-id", id, "--remove", "everything"]],
    ["a purge-level group without --purge", (id: string) => ["--plan-id", id, "--remove", "user-data"]],
    ["two --remove on one command line", (id: string) => ["--plan-id", id, "--remove", "claude-code", "--remove", "menubar"]],
    ["a flag it does not know", (id: string) => ["--plan-id", id, "--remove", "claude-code", "--all"]],
    ["--remove with no group after it", (id: string) => ["--plan-id", id, "--remove"]],
  ] as const) {
    for (const tty of [false, true]) {
      test(`refused, exit 2, nothing changed: ${name} (${tty ? "terminal" : "no terminal"})`, async () => {
        const id = await planId();
        const before = snapshot();
        expect(await run(args(id), { tty, answers: [true, true, true, true] })).toBe(2);
        expect(snapshot()).toEqual(before);
        expect(calls).toEqual([]);
        expect(asked).toEqual([]);
      });
    }
  }

  test("a group that is only listed is refused", async () => {
    // The user's own status line is there now: nothing in the group is ours to remove.
    recordBefore({ id: "pref:com.ameba.SwiftBar.PluginDirectory", kind: "macos-pref", target: "com.ameba.SwiftBar", byUs: false, level: "uninstall", undo: { type: "from-a-newer-version" } }, env);
    rmSync(join(home, "Library", "Application Support", "SwiftBar", "plugins", "siltpoke.1m.sh"));
    const id = await planId();
    expect(out).toContain('"offer":"list-only"');
    expect(await run(["--plan-id", id, "--remove", "menubar"])).toBe(2);
    expect(calls).toEqual([]);
  });

  test("a group with one item of ours and one of the user's removes ours and does not touch or complain about theirs", async () => {
    recordBefore({ id: "pref:com.ameba.SwiftBar.PluginDirectory", kind: "macos-pref", target: "com.ameba.SwiftBar", byUs: false, level: "uninstall", undo: { type: "from-a-newer-version" } }, env);
    expect(await run(["--plan-id", await planId(), "--remove", "menubar"])).toBe(0);
    expect(calls).toEqual(["menubar"]);
    expect(out).not.toContain("cannot undo");
  });

  test("a bootstrap note is folded into the receipt when a removal starts, and the id from before still works", async () => {
    writeFileSync(join(home, ".siltpoke", "receipt-bootstrap.json"), '{"id":"tool:bun","byUs":true,"state":"done"}');
    const id = await planId();
    expect(await run(["--plan-id", id, "--remove", "menubar"])).toBe(0);
    expect(readReceipt(env)?.entries.map((e) => `${e.id}:${e.state}`)).toEqual(["tool:bun:done"]);
    expect(existsSync(join(home, ".siltpoke", "receipt-bootstrap.json"))).toBe(false);
  });

  // Review round 2 of the report wording: the note is folded in after the run has started.
  test.each([
    ["no receipt before the run", false],
    ["a receipt that lists only a project before the run", true],
  ])("a bootstrap note folded in during the run is the receipt's first entry, and the report dates it (%s)", async (_name, withProject) => {
    if (withProject) addProjectRoot(join(home, "work", "a"), env);
    writeFileSync(join(home, ".siltpoke", "receipt-bootstrap.json"), '{"id":"tool:bun","byUs":true,"state":"done"}');
    expect(await run([], { tty: true, answers: [true] })).toBe(0);
    expect(readReceipt(env)?.entries.map((e) => e.id)).toEqual(["tool:bun"]);
    expect(out).toContain(`Siltpoke started recording what it installs on ${readReceipt(env)?.entries[0]?.at.slice(0, 10)}.`);
    expect(out).not.toContain("install receipt on this machine");
  });

  test("an undo this version does not know is said so, left untouched, and the call exits 1", async () => {
    // A receipt written by a newer siltpoke: a known id with an undo type this code has no executor for.
    const file = join(home, ".claude", "commands", "siltpoke-future.md");
    mkdirSync(join(home, ".claude", "commands"), { recursive: true });
    writeFileSync(file, "x\n");
    const id = `file:${file}`;
    recordBefore({ id, kind: "file", target: file, byUs: true, level: "uninstall", undo: { type: "from-a-newer-version" } }, env);
    markDone(id, env);

    expect(await run(["--plan-id", await planId(), "--remove", "claude-code"])).toBe(1);
    expect(readFileSync(file, "utf8")).toBe("x\n");
    expect(out).toContain(id);
    expect(out).toContain("cannot undo");
  });
});

// Review round 1, I2: the menu-bar step removes what the plan listed as removable, and only that.
describe("the menu-bar group removes exactly the plan's removable items", () => {
  const shimPath = () => join(home, "Library", "Application Support", "SwiftBar", "plugins", "siltpoke.1m.sh");
  const loginItem = () => join(home, "Library", "LaunchAgents", "io.siltpoke.swiftbar.plist");

  test("the effect is handed the shim the plan listed, and no login item when the plan has none", async () => {
    await run(["--plan-id", await planId(), "--remove", "menubar"]);
    expect(menubarTargets).toEqual({ shims: [shimPath()], loginItem: false });
  });

  test("a shim the receipt says was the user's is not handed over, while the login item beside it is", async () => {
    recordBefore({ id: `file:${shimPath()}`, kind: "file", target: shimPath(), byUs: false, level: "uninstall", undo: { type: "remove-if-hash", sha256: "x" } }, env);
    markDone(`file:${shimPath()}`, env);
    writeFileSync(loginItem(), "<plist/>");
    await run(["--plan"]);
    expect(out).toContain("kept — it was there before Siltpoke");
    await run(["--plan-id", await planId(), "--remove", "menubar"]);
    expect(menubarTargets).toEqual({ shims: [], loginItem: true });
  });

  test("a file at the shim's name that is not a siltpoke shim is not in the plan and is not handed over", async () => {
    writeFileSync(shimPath(), "#!/bin/bash\necho mine\n");
    writeFileSync(loginItem(), "<plist/>");
    await run(["--plan"]);
    expect(out).toContain("[menubar]");
    expect(out).not.toContain(shimPath());
    await run(["--plan-id", await planId(), "--remove", "menubar"]);
    expect(menubarTargets).toEqual({ shims: [], loginItem: true });
  });

  // The real effect, on real files in the temp home. The login-item remover is a spy: the real one calls launchctl.
  test.skipIf(process.platform !== "darwin")("the real effect deletes a listed siltpoke shim, keeps a listed file that is no longer one, and never touches an unlisted file", async () => {
    const dir = join(home, "elsewhere");
    mkdirSync(dir);
    const [ours, edited, unlisted] = ["a.sh", "b.sh", "siltpoke.1m.sh"].map((n) => join(dir, n));
    writeFileSync(ours as string, SHIM);
    writeFileSync(edited as string, "#!/bin/bash\necho mine\n");
    writeFileSync(unlisted as string, SHIM);
    const before = readFileSync(shimPath(), "utf8");

    const loginItemCalls: string[] = [];
    const real = realUninstallEffects(env, (h) => { loginItemCalls.push(h); return true; });
    // A link whose target is gone is still a file at that path: kept and named, not skipped in silence.
    const dangling = join(dir, "dangling.sh");
    symlinkSync(join(dir, "nowhere"), dangling);
    expect((await real.removeMenubar({ shims: [dangling], loginItem: false })).kept).toEqual([dangling]);
    const r = await real.removeMenubar({ shims: [ours as string, edited as string, join(dir, "gone.sh")], loginItem: false });
    expect(loginItemCalls).toEqual([]); // not asked for, not touched
    expect(await real.removeMenubar({ shims: [], loginItem: true })).toEqual({ shim: false, loginItem: true, kept: [] });
    expect(loginItemCalls).toEqual([home]);

    expect(r).toEqual({ shim: true, loginItem: false, kept: [edited as string] });
    expect(existsSync(ours as string)).toBe(false);
    expect(existsSync(edited as string)).toBe(true);
    expect(existsSync(unlisted as string)).toBe(true);
    expect(readFileSync(shimPath(), "utf8")).toBe(before); // the default-folder shim was not asked for
  });

  test("a listed file the effect kept is reported, and the call exits 1", async () => {
    out = "";
    const code = await runUninstallCommand(["--plan-id", await planId(), "--remove", "menubar"], env, {
      effects: { ...effects(), removeMenubar: async (t) => ({ shim: false, loginItem: false, kept: t.shims }) },
      probes: fsDiskProbes(() => ({ status: 1, stdout: "" }), "darwin", () => false),
    undo: { exec: () => ({ status: 1, stdout: "" }), platform: "darwin" },
    purge: { run: () => ({ status: 1, stdout: "" }) },
      isTTY: false,
      ask: async () => false,
      write: (t) => { out += t; },
    });
    expect(code).toBe(1);
    expect(out).toContain(shimPath());
    expect(out).toContain("left as it is");
  });
});

// Review round 1, M2: the receipt says a siltpoke install wrote the status line, so the source wrapper is ours.
test("a recorded source-install status line is restored, not called someone else's", async () => {
  writeFileSync(settingsPath(), JSON.stringify({ statusLine: { type: "command", command: "bun /repo/src/face/wrapper.ts" }, theme: "dark" }));
  recordBefore({ id: "statusline:claude-code", kind: "statusline", target: settingsPath(), byUs: true, level: "uninstall", undo: { type: "restore-statusline", inner: join(home, ".siltpoke", "inner.txt") } }, env);
  markDone("statusline:claude-code", env);
  expect(await run(["--plan-id", await planId(), "--remove", "claude-code"])).toBe(0);
  expect(settings().statusLine?.command).toBe("echo ORIGINAL");
  expect(out).not.toContain("not Siltpoke's");
});

test("without a receipt the same command is not in the plan at all", async () => {
  writeFileSync(settingsPath(), JSON.stringify({ statusLine: { type: "command", command: "bun /repo/src/face/wrapper.ts" } }));
  await run(["--plan"]);
  expect(out).not.toContain("[claude-code]");
});

describe("uninstall --purge --remove user-data — the gates from PR 1 still hold", () => {
  test("refused while settings.json still points into the folder, even though this call never ran the status-line step", async () => {
    expect(await run(["--purge", "--plan-id", await planId(), "--remove", "user-data"])).toBe(1);
    expect(existsSync(join(home, ".siltpoke", "inner.txt"))).toBe(true);
    expect(out).toContain("NOT deleted");
    // Review round 1, I1: a refused purge has no side effects.
    expect(calls).toEqual([]);
    expect(JSON.parse(readFileSync(join(home, ".siltpoke", "config.json"), "utf8")).daemon.enabled).toBe(true);
    // Review round 1, M1: it names the group to remove first, not a section that is not printed.
    expect(out).toContain("[claude-code]");
    expect(out).not.toContain("Could not finish");
  });

  test("terminal, --purge: no to the dashboard and yes to the data, purge refused → the dashboard is left running", async () => {
    setRegistered(true);
    expect(await run(["--purge"], { tty: true, answers: [false, false, false, true] })).toBe(1);
    expect(calls).toEqual([]);
    expect(existsSync(join(home, ".siltpoke"))).toBe(true);
  });

  test("the data group's own line says the dashboard is stopped with it", async () => {
    await run(["--plan", "--purge"]);
    expect(out).toMatch(/\[user-data\][^\n]*dashboard/);
  });

  test("refused when settings.json cannot be read — unknown is not 'restored', and the advice is to fix the file", async () => {
    writeFileSync(settingsPath(), "{ not json");
    expect(await run(["--purge", "--plan-id", await planId(), "--remove", "user-data"])).toBe(1);
    expect(existsSync(join(home, ".siltpoke", "inner.txt"))).toBe(true);
    expect(out).not.toContain("[claude-code]"); // that group is not in this plan
    expect(out).toContain("cannot be read");
    expect(calls).toEqual([]);
  });

  // Review round 2, I-1: the source wrapper reads inner.txt too. The gate must
  // count it as "still points into the folder", recorded or not.
  for (const recorded of [true, false]) {
    test(`refused while settings.json still runs the source wrapper (${recorded ? "recorded" : "not recorded"}) — inner.txt is its only copy too`, async () => {
      writeFileSync(settingsPath(), JSON.stringify({ statusLine: { type: "command", command: "bun /repo/src/face/wrapper.ts" } }));
      if (recorded) {
        recordBefore({ id: "statusline:claude-code", kind: "statusline", target: settingsPath(), byUs: true, level: "uninstall", undo: { type: "restore-statusline", inner: join(home, ".siltpoke", "inner.txt") } }, env);
        markDone("statusline:claude-code", env);
      }
      expect(await run(["--purge", "--plan-id", await planId(), "--remove", "user-data"])).toBe(1);
      expect(readFileSync(join(home, ".siltpoke", "inner.txt"), "utf8")).toBe("echo ORIGINAL");
      expect(calls).toEqual([]);
    });
  }

  test("with no settings.json at all there is nothing pointing into the folder, so it is deleted", async () => {
    rmSync(settingsPath());
    expect(await run(["--purge", "--plan-id", await planId(), "--remove", "user-data"])).toBe(0);
    expect(existsSync(join(home, ".siltpoke"))).toBe(false);
  });

  test("refused while a host still has the plugin", async () => {
    await run(["--plan-id", await planId(), "--remove", "claude-code"]);
    setRegistered(true);
    expect(await run(["--purge", "--plan-id", await planId(), "--remove", "user-data"])).toBe(1);
    expect(existsSync(join(home, ".siltpoke"))).toBe(true);
    expect(out).toContain("claude plugin uninstall siltpoke");
    expect(calls).toEqual([]); // this refusal leaves the dashboard alone too
  });

  test("deleted once the status line is back and no host has the plugin; the server is stopped first", async () => {
    await run(["--plan-id", await planId(), "--remove", "claude-code"]);
    expect(await run(["--purge", "--plan-id", await planId(), "--remove", "user-data"])).toBe(0);
    expect(existsSync(join(home, ".siltpoke"))).toBe(false);
    expect(calls).toEqual(["autostart", "daemon"]);
    expect(settings().statusLine?.command).toBe("echo ORIGINAL");
  });
});
