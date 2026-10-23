// Defect [61], part B: an uninstall a plugin user can actually reach.
//
// `runUninstall` (src/cli/uninstall.ts) is source-checkout only and copies a
// whole settings backup over settings.json. `runPluginUninstall` is the plugin
// path: it undoes what setup wrote OUTSIDE the plugin directory, one piece at a
// time, and never deletes the user's data while the plugin's hooks can still
// run and write it straight back.
//
// Every machine-touching step (launchctl, the daemon, SwiftBar) is an injected
// effect here. `runPluginUninstall` takes them as a REQUIRED argument, so a
// test cannot reach the real machine by leaving one out.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  daemonPidToStop,
  type PluginUninstallResult,
  runPluginUninstall,
  type UninstallEffects,
  type UninstallStep,
} from "../../src/cli/plugin-uninstall";
import { wireAgyStatusline } from "../../src/installer/agy-statusline";
import { parseCodexPluginList } from "../../src/installer/plugin-hosts";

// The removal plan asks for steps one group at a time (uninstall-run.ts); these
// tests are about the steps themselves, so they ask for all four.
const ALL: ReadonlySet<UninstallStep> = new Set(["status-line", "agy-status-line", "dashboard", "menubar"]);
/** Everything a call hands its caller to print. */
const said = (r: PluginUninstallResult) => [...r.done, ...r.errors, ...r.next].join("\n");

let home: string;
let env: NodeJS.ProcessEnv;
let calls: string[];
let root: string;
let registry: string;

function effects(over: Partial<UninstallEffects> = {}): UninstallEffects {
  return {
    removeAutostart: async () => { calls.push("autostart"); return "removed"; },
    stopDaemon: async () => { calls.push("daemon"); return "stopping"; },
    removeMenubar: async () => { calls.push("menubar"); return { shim: true, loginItem: true }; },
    codexListsPlugin: () => null, // no codex on this (fake) machine
    ...over,
  };
}

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "siltpoke-plugin-uninstall-"));
  env = { HOME: home };
  calls = [];
  root = join(home, ".claude", "plugins", "cache", "siltpoke", "siltpoke", "9.9.9");
  registry = join(home, ".claude", "plugins", "installed_plugins.json");
  mkdirSync(join(root, "dist"), { recursive: true });
  mkdirSync(join(home, ".siltpoke", "bin"), { recursive: true });
  writeFileSync(join(home, ".siltpoke", "plugin-root"), root);
  writeFileSync(join(home, ".siltpoke", "inner.txt"), "echo ORIGINAL");
  writeFileSync(
    join(home, ".siltpoke", "config.json"),
    JSON.stringify({ name: "Velvettwirl", daemon: { enabled: true } }),
  );
  writeFileSync(
    join(home, ".claude", "settings.json"),
    `${JSON.stringify(
      { statusLine: { type: "command", command: `sh ${home}/.siltpoke/bin/statusline.sh` }, theme: "dark" },
      null,
      2,
    )}\n`,
  );
});
afterEach(() => { rmSync(home, { recursive: true, force: true }); });

function setRegistered(installed: boolean): void {
  writeFileSync(
    registry,
    JSON.stringify({ version: 2, plugins: installed ? { "siltpoke@siltpoke": [{}] } : {} }),
  );
}
const settings = () =>
  JSON.parse(readFileSync(join(home, ".claude", "settings.json"), "utf8")) as Record<string, unknown>;
const config = () =>
  JSON.parse(readFileSync(join(home, ".siltpoke", "config.json"), "utf8")) as { daemon?: { enabled?: boolean }; name?: string };

describe("runPluginUninstall — what it undoes", () => {
  test("the user's status line is back and nothing else in settings.json moved", async () => {
    setRegistered(true);
    const r = await runPluginUninstall(env, { steps: ALL }, effects());
    expect(r.report.statusLine).toBe("restored");
    expect(settings()).toEqual({ statusLine: { type: "command", command: "echo ORIGINAL" }, theme: "dark" });
  });

  test("autostart is removed BEFORE the daemon is stopped (a keep-alive unit would restart it)", async () => {
    setRegistered(true);
    await runPluginUninstall(env, { steps: ALL }, effects());
    expect(calls.indexOf("autostart")).toBeGreaterThanOrEqual(0);
    expect(calls.indexOf("autostart")).toBeLessThan(calls.indexOf("daemon"));
    expect(calls).toContain("menubar");
  });

  test("daemon.enabled is switched off, so the Stop hook of a still-open session does not bring it back", async () => {
    setRegistered(true);
    await runPluginUninstall(env, { steps: ALL }, effects());
    expect(config().daemon?.enabled).toBe(false);
    expect(config().name).toBe("Velvettwirl"); // the rest of the pet's config is kept
  });

  test("one step failing does not stop the ones after it", async () => {
    setRegistered(true);
    const r = await runPluginUninstall(
      env,
      { steps: ALL },
      effects({ removeAutostart: async () => { calls.push("autostart"); throw new Error("launchctl exploded"); } }),
    );
    expect(calls).toEqual(["autostart", "daemon", "menubar"]);
    expect(r.report.autostart).toBe("failed");
    expect(r.report.statusLine).toBe("restored");
    expect(said(r)).toContain("launchctl exploded");
  });

  test("an agy status line that is ours is removed; someone else's is left alone", async () => {
    setRegistered(true);
    const agyDir = join(home, ".gemini", "antigravity-cli");
    mkdirSync(agyDir, { recursive: true });
    const agySettings = join(agyDir, "settings.json");

    // Ours: written by the real wiring, so the "is it ours" test meets the real shape.
    const agyCard = join(home, ".gemini", "config", "plugins", "siltpoke", "dist");
    mkdirSync(agyCard, { recursive: true });
    writeFileSync(join(agyCard, "siltpoke-card.js"), "");
    writeFileSync(agySettings, JSON.stringify({ model: "x" }));
    expect(wireAgyStatusline(env, "/usr/local/bin/bun")).toBe("installed");
    const ours = await runPluginUninstall(env, { steps: ALL }, effects());
    expect(ours.report.agyStatusLine).toBe("removed");
    expect(JSON.parse(readFileSync(agySettings, "utf8"))).toEqual({ model: "x" });
    expect(said(ours)).toContain("Antigravity status line");

    writeFileSync(agySettings, JSON.stringify({ statusLine: { type: "command", command: "echo AGY-USER" }, model: "x" }));
    const foreign = await runPluginUninstall(env, { steps: ALL }, effects());
    expect(foreign.report.agyStatusLine).toBe("not-ours");
    expect(JSON.parse(readFileSync(agySettings, "utf8"))).toEqual({
      statusLine: { type: "command", command: "echo AGY-USER" },
      model: "x",
    });
  });

  test("[65] a source-install agy pet on a path with a space is ours and is removed", async () => {
    setRegistered(true);
    const agyDir = join(home, ".gemini", "antigravity-cli");
    mkdirSync(agyDir, { recursive: true });
    const agySettings = join(agyDir, "settings.json");
    const spaced = "C:\\Users\\First Last\\.bun\\bin\\bun.exe C:\\Users\\First Last\\repo\\src\\face\\wrapper.ts --agent antigravity";
    writeFileSync(agySettings, JSON.stringify({ statusLine: { type: "command", command: spaced }, model: "x" }));
    const r = await runPluginUninstall(env, { steps: ALL }, effects());
    expect(r.report.agyStatusLine).toBe("removed");
    expect(JSON.parse(readFileSync(agySettings, "utf8"))).toEqual({ model: "x" });
  });
});

describe("runPluginUninstall — the user's data", () => {
  test("without --purge, ~/.siltpoke is kept whether or not the plugin is still installed", async () => {
    for (const installed of [true, false]) {
      setRegistered(installed);
      const r = await runPluginUninstall(env, { steps: ALL }, effects());
      expect(r.report.purged).toBe(false);
      expect(existsSync(join(home, ".siltpoke", "config.json"))).toBe(true);
      // How to delete it is the final report's line (uninstall-report.ts), not this call's.
      expect(r.next).toEqual([]);
      expect(r.exitCode).toBe(0);
    }
  });

  test("without --purge no host is asked whether it has the plugin — asking codex starts a process", async () => {
    setRegistered(true);
    let askedCodex = 0;
    const r = await runPluginUninstall(env, { steps: ALL }, effects({ codexListsPlugin: () => { askedCodex++; return true; } }));
    expect(askedCodex).toBe(0);
    expect(r.report.hosts).toEqual([]);
    expect(r.report.hostsKnown).toBe(false);
  });

  test("--purge while the plugin is STILL INSTALLED deletes nothing — its hooks would recreate the folder", async () => {
    setRegistered(true);
    const r = await runPluginUninstall(env, { steps: ALL, purge: true }, effects());
    expect(r.report.purged).toBe(false);
    expect(existsSync(join(home, ".siltpoke", "config.json"))).toBe(true);
    expect(said(r)).toContain("claude plugin uninstall siltpoke");
    expect(said(r)).toContain("uninstall.sh --purge");
    expect(r.exitCode).toBe(1); // asked to purge, did not
  });

  test("installed for one project (defect [82]): the command goes to that project and names the scope", async () => {
    const proj = join(home, "work", "proj");
    writeFileSync(registry, JSON.stringify({ version: 2, plugins: { "siltpoke@siltpoke": [{ scope: "local", projectPath: proj }] } }));
    const r = await runPluginUninstall(env, { steps: ALL, purge: true }, effects());
    expect(r.report.purgeRefused).toBe("plugin-installed");
    expect(r.next[0]).toBe(
      `Remove the plugin from Claude Code (only the host can do this):\n      (cd "${proj}" && claude plugin uninstall siltpoke --scope local)`,
    );
  });

  test("a project install in Claude Code and the plugin in another host too: each host keeps its own step", async () => {
    const proj = join(home, "work", "proj");
    writeFileSync(registry, JSON.stringify({ version: 2, plugins: { "siltpoke@siltpoke": [{ scope: "local", projectPath: proj }] } }));
    mkdirSync(join(home, ".codebuddy", "plugins"), { recursive: true });
    writeFileSync(join(home, ".codebuddy", "plugins", "installed_plugins.json"), JSON.stringify({ plugins: { "siltpoke@siltpoke": [{}] } }));
    const r = await runPluginUninstall(env, { steps: ALL, purge: true }, effects());
    expect(r.report.hosts).toEqual(["Claude Code", "CodeBuddy"]);
    expect(r.next[0]).toContain(`(cd "${proj}" && claude plugin uninstall siltpoke --scope local)`);
    expect(r.next[1]).toContain("still installed in CodeBuddy");
    expect(r.next[1]).not.toContain("claude plugin uninstall");
  });

  test("installed for the user and for a project: both commands, one per line", async () => {
    const proj = join(home, "work", "proj");
    writeFileSync(
      registry,
      JSON.stringify({ version: 2, plugins: { "siltpoke@siltpoke": [{ scope: "user" }, { scope: "project", projectPath: proj }] } }),
    );
    const r = await runPluginUninstall(env, { steps: ALL, purge: true }, effects());
    expect(r.next[0]).toBe(
      `Remove the plugin from Claude Code (only the host can do this):\n      claude plugin uninstall siltpoke\n      (cd "${proj}" && claude plugin uninstall siltpoke --scope project)`,
    );
  });

  test("--purge after the plugin is uninstalled deletes ~/.siltpoke", async () => {
    setRegistered(false);
    const r = await runPluginUninstall(env, { steps: ALL, purge: true }, effects());
    expect(r.report.purged).toBe(true);
    expect(existsSync(join(home, ".siltpoke"))).toBe(false);
    // The settings repair happened BEFORE the folder it reads from was deleted.
    expect(settings().statusLine).toEqual({ type: "command", command: "echo ORIGINAL" });
  });

  test("--purge with no registry to read is treated as still installed (unknown is not 'gone')", async () => {
    const r = await runPluginUninstall(env, { steps: ALL, purge: true }, effects());
    expect(r.report.purged).toBe(false);
    expect(r.report.purgeRefused).toBe("unknown-install-state");
    expect(existsSync(join(home, ".siltpoke", "config.json"))).toBe(true);
    // Found in the final-pass review: this case used to print the very command
    // that had just refused, and exit 0. Nothing on the machine can answer, so
    // the user gets the direct way instead.
    expect(said(r)).toContain("rm -rf ~/.siltpoke");
    expect(said(r)).not.toContain("uninstall.sh --purge");
    expect(r.exitCode).toBe(1);
  });

  test("a user who only ever had the plugin in CodeBuddy can purge once it is gone there — no Claude registry needed", async () => {
    mkdirSync(join(home, ".codebuddy", "plugins"), { recursive: true });
    writeFileSync(join(home, ".codebuddy", "plugins", "installed_plugins.json"), '{"version":2,"plugins":{}}');
    const r = await runPluginUninstall(env, { steps: ALL, purge: true }, effects());
    expect(r.report.hostsKnown).toBe(true);
    expect(r.report.purged).toBe(true);
    expect(existsSync(join(home, ".siltpoke"))).toBe(false);
    expect(r.exitCode).toBe(0);
  });

  test("--purge is refused while CODEX still lists the plugin (it has no registry file; it is asked)", async () => {
    setRegistered(false);
    const r = await runPluginUninstall(env, { steps: ALL, purge: true }, effects({ codexListsPlugin: () => true }));
    expect(r.report.hosts).toEqual(["Codex"]);
    expect(r.report.purged).toBe(false);
    expect(existsSync(join(home, ".siltpoke", "config.json"))).toBe(true);
    expect(r.exitCode).toBe(1);
  });

  test("codex answering 'not installed' is an answer: it makes the state known", async () => {
    const r = await runPluginUninstall(env, { steps: ALL, purge: true }, effects({ codexListsPlugin: () => false }));
    expect(r.report.hostsKnown).toBe(true);
    expect(r.report.purged).toBe(true);
  });

  test("--purge is refused when the status line could NOT be restored — inner.txt is the only copy of the user's own line", async () => {
    // Found in review: the purge only asked "is the plugin gone", so an
    // unparseable settings.json still pointing at our shim lost its repair kit.
    setRegistered(false);
    const broken = `{ "statusLine": { "command": "sh ${home}/.siltpoke/bin/statusline.sh" }, `;
    writeFileSync(join(home, ".claude", "settings.json"), broken);

    const r = await runPluginUninstall(env, { steps: ALL, purge: true }, effects());
    expect(r.report.statusLine).toBe("unreadable");
    expect(r.report.purged).toBe(false);
    expect(r.report.purgeRefused).toBe("status-line-not-restored");
    expect(existsSync(join(home, ".siltpoke", "inner.txt"))).toBe(true);
    expect(readFileSync(join(home, ".claude", "settings.json"), "utf8")).toBe(broken);
    expect(r.exitCode).toBe(1);
    expect(r.errors.join("\n")).toContain("settings.json is not valid JSON");
    expect(said(r)).not.toContain("your own status line is back");
  });

  test("--purge is refused while ANOTHER host still has the plugin — the data folder is shared", async () => {
    setRegistered(false); // gone from Claude Code
    mkdirSync(join(home, ".codebuddy", "plugins"), { recursive: true });
    writeFileSync(
      join(home, ".codebuddy", "plugins", "installed_plugins.json"),
      JSON.stringify({ version: 2, plugins: { "siltpoke@siltpoke": [{}] } }),
    );

    const r = await runPluginUninstall(env, { steps: ALL, purge: true }, effects());
    expect(r.report.hosts).toEqual(["CodeBuddy"]);
    expect(r.report.purged).toBe(false);
    expect(r.report.purgeRefused).toBe("plugin-installed");
    expect(existsSync(join(home, ".siltpoke", "config.json"))).toBe(true);
    expect(said(r)).toContain("still installed in CodeBuddy");
    expect(said(r)).not.toContain("claude plugin uninstall siltpoke");
  });

  test("qoder's registry (either file name) and an Antigravity plugin folder each count as installed", async () => {
    setRegistered(false);
    mkdirSync(join(home, ".qoder", "plugins"), { recursive: true });
    writeFileSync(join(home, ".qoder", "plugins", "installed_plugins_v2.json"), '{"plugins":{"siltpoke@siltpoke":[]}}');
    mkdirSync(join(home, ".gemini", "config", "plugins", "siltpoke"), { recursive: true });

    const r = await runPluginUninstall(env, { steps: ALL, purge: true }, effects());
    expect(r.report.hosts).toEqual(["Qoder", "Antigravity"]);
    expect(r.report.purged).toBe(false);
  });
});

describe("refusals never hand the user a command that destroys what they protect", () => {
  test("nothing can be asked AND the status line is not restored → no `rm -rf` is suggested", async () => {
    // Found in the last review: the 'unknown' refusal was checked first and
    // printed `rm -rf ~/.siltpoke`, which deletes inner.txt — the only copy of
    // the user's own status line, i.e. exactly what the other guard protects.
    const broken = `{ "statusLine": { "command": "sh ${home}/.siltpoke/bin/statusline.sh" }, `;
    writeFileSync(join(home, ".claude", "settings.json"), broken);

    const r = await runPluginUninstall(env, { steps: ALL, purge: true }, effects()); // no registry, codex → null
    expect(r.report.hostsKnown).toBe(false);
    expect(r.report.purgeRefused).toBe("status-line-not-restored");
    expect(said(r)).not.toContain("rm -rf ~/.siltpoke");
    expect(existsSync(join(home, ".siltpoke", "inner.txt"))).toBe(true);
  });
});

describe("parseCodexPluginList — a shape it does not recognise is 'cannot tell', never 'not installed'", () => {
  test("installed, by exact name", () => {
    expect(parseCodexPluginList('{"installed":[{"name":"other"},{"name":"siltpoke"}],"available":[]}')).toBe(true);
  });
  test("not installed", () => {
    expect(parseCodexPluginList('{"installed":[{"name":"other"}],"available":[{"name":"siltpoke"}]}')).toBe(false);
    expect(parseCodexPluginList('{"installed":[]}')).toBe(false);
  });
  test("a longer name that merely contains it is not it", () => {
    expect(parseCodexPluginList('{"installed":[{"name":"siltpoke-extras"}]}')).toBe(false);
  });
  test("valid JSON in another shape → null (a wrong 'false' would let a purge through)", () => {
    expect(parseCodexPluginList("[]")).toBeNull();
    expect(parseCodexPluginList('{"plugins":[{"name":"siltpoke"}]}')).toBeNull();
    expect(parseCodexPluginList('{"installed":"siltpoke"}')).toBeNull();
    expect(parseCodexPluginList("null")).toBeNull();
  });
  test("not JSON → null", () => {
    expect(parseCodexPluginList("")).toBeNull();
    expect(parseCodexPluginList("NAME  STATUS\nsiltpoke  installed")).toBeNull();
  });
});

describe("daemonPidToStop — nothing is killed on one source's word", () => {
  const ping = (pid: unknown) => ({ service: "siltpoked", ok: true, pid });

  test("the port and the pidfile name the same process → that pid", () => {
    expect(daemonPidToStop(ping(4242), "4242\n")).toBe(4242);
  });

  test("a listener on the port names some OTHER pid → nothing (it does not get to choose the target)", () => {
    expect(daemonPidToStop(ping(1), "4242")).toBeNull();
  });

  test("no pidfile → nothing, however convincing the answer on the port", () => {
    expect(daemonPidToStop(ping(4242), null)).toBeNull();
  });

  test("a pidfile but the port is not answered by siltpoked → nothing (the pid may have been recycled)", () => {
    expect(daemonPidToStop({ ok: true }, "4242")).toBeNull();
    expect(daemonPidToStop(null, "4242")).toBeNull();
  });

  test("garbage in either source → nothing", () => {
    expect(daemonPidToStop(ping("4242"), "4242")).toBeNull();
    expect(daemonPidToStop(ping(4242), "not-a-pid")).toBeNull();
    expect(daemonPidToStop(ping(0), "0")).toBeNull();
    expect(daemonPidToStop(ping(-1), "-1")).toBeNull();
  });
});

describe("runPluginUninstall — what it tells the user", () => {
  test("a status line that was never ours is reported as such, not as restored", async () => {
    setRegistered(true);
    writeFileSync(
      join(home, ".claude", "settings.json"),
      JSON.stringify({ statusLine: { type: "command", command: "echo THEIRS" } }),
    );
    const r = await runPluginUninstall(env, { steps: ALL }, effects());
    expect(r.report.statusLine).toBe("not-ours");
    expect(said(r)).not.toContain("your own status line is back");
  });
});
