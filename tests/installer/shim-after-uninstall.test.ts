// Defect [61], measured 2026-10-02 (audit §70.4): `claude plugin uninstall`
// does NOT delete the plugin cache directory — it writes `.orphaned_at` into it
// and empties `installed_plugins.json`. settings.json keeps pointing at this
// shim, the shim still finds the card, and the pet stays in the status line
// with its bubble frozen. Once the cache directory is finally gone the status
// line goes blank and the user's own one never comes back.
//
// The shim is the only siltpoke code that still runs after an uninstall, so it
// is where the repair has to live. Every arm below runs the REAL generated
// script under `sh`.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { refreshStaleShims, renderUninstallShim, uninstallShimPath, writeShim } from "../../src/installer/shim";

let home: string;
let root: string;
let registry: string;
let healLog: string;

const REAL_CLI = resolve(import.meta.dir, "../../src/cli/plugin-cli.ts");

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "siltpoke-shim-uninstall-"));
  // The layout Claude Code really uses: <claude home>/plugins/cache/<marketplace>/<plugin>/<version>.
  root = join(home, ".claude", "plugins", "cache", "siltpoke", "siltpoke", "9.9.9");
  registry = join(home, ".claude", "plugins", "installed_plugins.json");
  healLog = join(home, "heal.log");
  mkdirSync(join(root, "dist"), { recursive: true });
  mkdirSync(join(home, ".siltpoke"), { recursive: true });
  writeFileSync(join(root, "dist", "siltpoke-card.js"), 'console.log("FACE");');
  // Stand-in CLI: records every invocation, so "was the repair attempted, and
  // how many times" is something a test can read off disk.
  writeFileSync(
    join(root, "dist", "siltpoke-cli.js"),
    `require("node:fs").appendFileSync(${JSON.stringify(healLog)}, process.argv.slice(2).join(" ") + "\\n");`,
  );
  writeFileSync(join(home, ".siltpoke", "plugin-root"), root);
});
afterEach(() => { rmSync(home, { recursive: true, force: true }); });

function setRegistry(installed: boolean): void {
  const plugins = installed
    ? { "siltpoke@siltpoke": [{ scope: "user", installPath: root, version: "9.9.9" }] }
    : {};
  writeFileSync(registry, `${JSON.stringify({ version: 2, plugins }, null, 2)}\n`);
}
function markOrphaned(stamp = "1790965933787"): void {
  writeFileSync(join(root, ".orphaned_at"), stamp);
}
function saveOriginal(command: string): void {
  writeFileSync(join(home, ".siltpoke", "inner.txt"), command);
}
function run(shim: string, stdin?: string) {
  const r = Bun.spawnSync(["sh", shim], {
    env: { PATH: process.env.PATH ?? "", HOME: home },
    ...(stdin === undefined ? {} : { stdin: Buffer.from(stdin) }),
  });
  return {
    exitCode: r.exitCode,
    out: new TextDecoder().decode(r.stdout),
    err: new TextDecoder().decode(r.stderr),
  };
}
function healCalls(): string[] {
  return existsSync(healLog) ? readFileSync(healLog, "utf8").split("\n").filter(Boolean) : [];
}

describe("statusline shim — plugin still installed (must-not-regress)", () => {
  test("installed, not orphaned → the pet renders and no repair is attempted", async () => {
    setRegistry(true);
    saveOriginal("echo ORIGINAL");
    const r = run(await writeShim(home));
    expect(r.out.trim()).toBe("FACE");
    expect(healCalls()).toEqual([]);
  });

  test("UPDATED, not uninstalled: the old version dir is orphaned but the plugin is still registered → the pet renders, nothing is repaired", async () => {
    // A plugin update orphans the previous version directory too, and the
    // pointer keeps naming it until the next SessionStart. Reading
    // `.orphaned_at` alone would take every update for an uninstall.
    setRegistry(true);
    markOrphaned();
    saveOriginal("echo ORIGINAL");
    const r = run(await writeShim(home));
    expect(r.out.trim()).toBe("FACE");
    expect(healCalls()).toEqual([]);
  });

  test("registry lists no siltpoke but the dir is NOT orphaned → the pet renders (one signal is not enough)", async () => {
    setRegistry(false);
    saveOriginal("echo ORIGINAL");
    const r = run(await writeShim(home));
    expect(r.out.trim()).toBe("FACE");
    expect(healCalls()).toEqual([]);
  });

  test("orphaned but there is no registry file to read → the pet renders (unknown is not uninstalled)", async () => {
    markOrphaned();
    saveOriginal("echo ORIGINAL");
    const r = run(await writeShim(home));
    expect(r.out.trim()).toBe("FACE");
    expect(healCalls()).toEqual([]);
  });

  test("orphaned + a registry that cannot be read → the pet renders (a failed lookup is not a 'no')", async () => {
    setRegistry(false);
    chmodSync(registry, 0o000);
    markOrphaned();
    saveOriginal("echo ORIGINAL");
    const r = run(await writeShim(home));
    chmodSync(registry, 0o644);
    expect(r.out.trim()).toBe("FACE");
    expect(healCalls()).toEqual([]);
  });

  test("orphaned + a registry that lists ANOTHER marketplace's siltpoke → still installed", async () => {
    writeFileSync(registry, JSON.stringify({ version: 2, plugins: { "siltpoke@some-fork": [{}] } }));
    markOrphaned();
    saveOriginal("echo ORIGINAL");
    const r = run(await writeShim(home));
    expect(r.out.trim()).toBe("FACE");
    expect(healCalls()).toEqual([]);
  });

  test("ANOTHER host's uninstall is not Claude Code's: the pointer names codebuddy's orphaned cache, Claude Code still has the plugin → the pet stays", async () => {
    // hooks/session-start.sh writes ONE ~/.siltpoke/plugin-root for Claude Code,
    // qoder and codebuddy, and codebuddy keeps the same cache/registry layout.
    // This shim is only ever run from Claude Code's settings.json, so the only
    // uninstall it may act on is Claude Code's.
    setRegistry(true); // Claude Code: installed
    // A mark on Claude Code's cache copy too (an earlier update left one). The
    // shim reads the mark there, so only the REGISTRY it asks decides this
    // test: asking codebuddy's (empty) one would read as uninstalled.
    markOrphaned();
    const cbRoot = join(home, ".codebuddy", "plugins", "cache", "siltpoke", "siltpoke", "9.9.9");
    mkdirSync(join(cbRoot, "dist"), { recursive: true });
    writeFileSync(join(cbRoot, "dist", "siltpoke-card.js"), 'console.log("FACE");');
    writeFileSync(join(cbRoot, "dist", "siltpoke-cli.js"), readFileSync(join(root, "dist", "siltpoke-cli.js")));
    writeFileSync(join(cbRoot, ".orphaned_at"), "1790965933787");
    writeFileSync(
      join(home, ".codebuddy", "plugins", "installed_plugins.json"),
      JSON.stringify({ version: 2, plugins: {} }),
    );
    writeFileSync(join(home, ".siltpoke", "plugin-root"), cbRoot);
    saveOriginal("echo ORIGINAL");

    const r = run(await writeShim(home));
    expect(r.out.trim()).toBe("FACE");
    expect(healCalls()).toEqual([]);
  });

  test("a dev checkout (--plugin-dir) on a machine with no Claude plugin registry is never judged uninstalled, even with a leftover mark in the cache", async () => {
    // What protects it is the MISSING registry: the mark on Claude Code's
    // cache copy is present, as an old install would have left it.
    const dev = join(home, "dev", "siltpoke");
    mkdirSync(join(dev, "dist"), { recursive: true });
    writeFileSync(join(dev, "dist", "siltpoke-card.js"), 'console.log("FACE");');
    writeFileSync(join(home, ".siltpoke", "plugin-root"), dev);
    markOrphaned();
    saveOriginal("echo ORIGINAL");
    const r = run(await writeShim(home));
    expect(r.out.trim()).toBe("FACE");
  });

  test("ACCEPTED (2026-10-02): installed once, uninstalled, now run with --plugin-dir → judged uninstalled; recovery is deleting the leftover cache copy + /siltpoke:siltpoke-setup", async () => {
    // The leftover mark is still on the cache copy and the registry names no
    // siltpoke, which is exactly what a real uninstall looks like. the maintainer
    // chose to accept and document this (docs/MANUAL.md "Uninstall") rather
    // than add a condition. This test pins the accepted behavior so a change
    // to it is a decision, not an accident.
    const dev = join(home, "dev", "siltpoke");
    mkdirSync(join(dev, "dist"), { recursive: true });
    writeFileSync(join(dev, "dist", "siltpoke-card.js"), 'console.log("FACE");');
    writeFileSync(join(home, ".siltpoke", "plugin-root"), dev);
    setRegistry(false);
    markOrphaned();
    saveOriginal("echo ORIGINAL");
    const shim = await writeShim(home);
    expect(run(shim).out.trim()).toBe("ORIGINAL");

    // The documented recovery's shim half: with the leftover cache copy gone
    // there is no mark, and the pet renders again. (The other half,
    // /siltpoke:siltpoke-setup pointing settings.json back at this shim, is not run here.)
    rmSync(join(home, ".claude", "plugins", "cache", "siltpoke"), { recursive: true, force: true });
    expect(run(shim).out.trim()).toBe("FACE");
  });
});

describe("statusline shim — plugin uninstalled, cache still on disk (stage one)", () => {
  test("the user's own status line is shown instead of the pet, and the repair is asked for", async () => {
    setRegistry(false);
    markOrphaned();
    saveOriginal("echo ORIGINAL");
    const r = run(await writeShim(home));
    expect(r.exitCode).toBe(0);
    expect(r.out.trim()).toBe("ORIGINAL");
    expect(r.out).not.toContain("FACE");
    expect(healCalls()).toEqual(["restore-statusline"]);
  });

  test("a DIRECTORY-source install: the pointer names the source folder, the orphan mark is on the cache copy → still repaired", async () => {
    // Measured 2026-10-02 on a real Claude Code 2.1.287, where the first
    // version of this fix did NOT fire: with a directory marketplace the plugin
    // RUNS from the source folder (that is what the pointer names) while Claude
    // Code also keeps a cache copy, and `.orphaned_at` is written into the
    // cache copy. Looking for the mark only at the pointer's root misses it.
    const source = join(home, "dev", "siltpoke-pack");
    mkdirSync(join(source, "dist"), { recursive: true });
    writeFileSync(join(source, "dist", "siltpoke-card.js"), 'console.log("FACE");');
    writeFileSync(join(source, "dist", "siltpoke-cli.js"), readFileSync(join(root, "dist", "siltpoke-cli.js")));
    writeFileSync(join(home, ".siltpoke", "plugin-root"), source);
    setRegistry(false);
    markOrphaned(); // on the cache copy, as Claude Code does
    saveOriginal("echo ORIGINAL");

    const r = run(await writeShim(home));
    expect(r.out.trim()).toBe("ORIGINAL");
    expect(healCalls()).toEqual(["restore-statusline"]);
  });

  test("the repair is attempted once per uninstall, not on every render", async () => {
    setRegistry(false);
    markOrphaned();
    saveOriginal("echo ORIGINAL");
    const shim = await writeShim(home);
    run(shim);
    run(shim);
    const third = run(shim);
    expect(third.out.trim()).toBe("ORIGINAL");
    expect(healCalls()).toEqual(["restore-statusline"]);
  });

  test("a render that could not even try (bun unreachable) does not use up the one attempt", async () => {
    setRegistry(false);
    markOrphaned();
    saveOriginal("echo ORIGINAL");
    const shim = await writeShim(home);
    // No bun on this PATH, and the fake HOME has no ~/.bun or bun-path.
    const blind = Bun.spawnSync(["/bin/sh", shim], { env: { PATH: "/usr/bin:/bin", HOME: home } });
    expect(new TextDecoder().decode(blind.stdout).trim()).toBe("ORIGINAL");
    expect(healCalls()).toEqual([]);

    run(shim); // bun is back
    expect(healCalls()).toEqual(["restore-statusline"]);
  });

  test("a SECOND uninstall (new orphan stamp) gets its own attempt", async () => {
    setRegistry(false);
    markOrphaned("1000");
    saveOriginal("echo ORIGINAL");
    const shim = await writeShim(home);
    run(shim);
    markOrphaned("2000");
    run(shim);
    expect(healCalls()).toEqual(["restore-statusline", "restore-statusline"]);
  });

  test("no saved original → nothing is printed, and the pet is NOT printed either", async () => {
    setRegistry(false);
    markOrphaned();
    const r = run(await writeShim(home));
    expect(r.exitCode).toBe(0);
    expect(r.out).toBe("");
    expect(healCalls()).toEqual(["restore-statusline"]);
  });

  test("the user's command receives the status-line JSON on stdin (the repair step must not swallow it)", async () => {
    // A repair step that READS stdin — the real CLI may, and a greedy one would
    // leave the user's command with nothing.
    writeFileSync(
      join(root, "dist", "siltpoke-cli.js"),
      `const fs = require("node:fs"); fs.readFileSync(0); fs.appendFileSync(${JSON.stringify(healLog)}, "ran\\n");`,
    );
    setRegistry(false);
    markOrphaned();
    saveOriginal("cat");
    const r = run(await writeShim(home), '{"model":"x"}');
    expect(r.out).toBe('{"model":"x"}');
  });

  test("the real chain: shim → bun → siltpoke-cli → settings.json has the user's command back", async () => {
    // Everything above uses a stand-in CLI. This arm runs the real one, because
    // "the shim asked for a repair" is not "settings.json was repaired".
    writeFileSync(
      join(root, "dist", "siltpoke-cli.js"),
      `import { runPluginCli } from ${JSON.stringify(REAL_CLI)};\nprocess.exit(await runPluginCli(process.argv.slice(2)));\n`,
    );
    const settingsPath = join(home, ".claude", "settings.json");
    const shim = await writeShim(home);
    writeFileSync(
      settingsPath,
      `${JSON.stringify({ statusLine: { type: "command", command: `sh ${shim}` }, theme: "dark" }, null, 2)}\n`,
    );
    setRegistry(false);
    markOrphaned();
    saveOriginal("echo ORIGINAL");

    const r = run(shim);
    expect(r.out.trim()).toBe("ORIGINAL");
    expect(JSON.parse(readFileSync(settingsPath, "utf8"))).toEqual({
      statusLine: { type: "command", command: "echo ORIGINAL" },
      theme: "dark",
    });
  });
});

describe("statusline shim — plugin cache gone (stage two)", () => {
  test("the user's own status line is shown, not a blank line", async () => {
    rmSync(root, { recursive: true, force: true });
    saveOriginal("echo ORIGINAL");
    const r = run(await writeShim(home));
    expect(r.exitCode).toBe(0);
    expect(r.out.trim()).toBe("ORIGINAL");
    expect(r.err).toBe("");
  });

  test("the pointer file itself is gone → still the user's own status line", async () => {
    rmSync(join(home, ".siltpoke", "plugin-root"));
    saveOriginal("echo ORIGINAL");
    const r = run(await writeShim(home));
    expect(r.exitCode).toBe(0);
    expect(r.out.trim()).toBe("ORIGINAL");
  });

  test("no saved original → silent, exit 0", async () => {
    rmSync(root, { recursive: true, force: true });
    const r = run(await writeShim(home));
    expect(r.exitCode).toBe(0);
    expect(r.out).toBe("");
    expect(r.err).toBe("");
  });

  test("a saved original that points back at this shim is not run (it would loop forever)", async () => {
    rmSync(root, { recursive: true, force: true });
    const shim = await writeShim(home);
    saveOriginal(`sh ${shim}`);
    const r = run(shim);
    expect(r.exitCode).toBe(0);
    expect(r.out).toBe("");
  });
});

describe("~/.siltpoke/bin/uninstall.sh — the way out that survives the plugin", () => {
  // System tools only by default: the no-bundle branch asks `codex plugin list`
  // when codex is on PATH, and a test must not depend on whether the machine
  // running it has codex installed.
  function runUninstall(args: string[], path = "/usr/bin:/bin") {
    const r = Bun.spawnSync(["/bin/sh", uninstallShimPath(home), ...args], {
      env: { PATH: path, HOME: home },
    });
    return { exitCode: r.exitCode, out: new TextDecoder().decode(r.stdout) };
  }
  const settingsPath = () => join(home, ".claude", "settings.json");
  /**
   * A stand-in `codex` that prints `json` for exactly `plugin list --json` and
   * fails on anything else, so dropping `--json` from the script is caught.
   * `json` is written byte for byte (printf %s), so tabs and CRLF survive.
   * Returns its dir, for PATH.
   */
  function fakeCodex(json: string): string {
    const bin = join(home, "fakebin");
    mkdirSync(bin, { recursive: true });
    writeFileSync(join(bin, "codex.out"), json);
    writeFileSync(
      join(bin, "codex"),
      `#!/bin/sh\n[ "$*" = "plugin list --json" ] || exit 2\ncat "${join(bin, "codex.out")}"\n`,
      { mode: 0o755 },
    );
    return bin;
  }
  /** Bundle gone, settings clean, no other host lists the plugin: only codex decides. */
  async function onlyCodexDecides(): Promise<void> {
    await writeShim(home);
    writeFileSync(settingsPath(), JSON.stringify({ theme: "dark" }));
    setRegistry(false);
    rmSync(root, { recursive: true, force: true });
  }

  test("setup writes it next to the statusline shim", async () => {
    await writeShim(home);
    expect(existsSync(uninstallShimPath(home))).toBe(true);
  });

  test("bundle still on disk → it hands over to the real uninstall, arguments and all", async () => {
    await writeShim(home);
    const r = runUninstall(["--purge"], process.env.PATH ?? ""); // needs bun
    expect(r.exitCode).toBe(0);
    expect(healCalls()).toEqual(["uninstall --purge"]);
  });

  test("bundle gone and settings.json still points at the shim → --purge is REFUSED and the data stays", async () => {
    // Deleting ~/.siltpoke here would take inner.txt — the only copy of the
    // user's original status line — and leave a blank line nothing can repair.
    await writeShim(home);
    saveOriginal("echo ORIGINAL");
    writeFileSync(settingsPath(), JSON.stringify({ statusLine: { command: `sh ${home}/.siltpoke/bin/statusline.sh` } }));
    rmSync(root, { recursive: true, force: true });

    const r = runUninstall(["--purge"]);
    expect(r.exitCode).toBe(1);
    expect(existsSync(join(home, ".siltpoke", "inner.txt"))).toBe(true);
    expect(r.out).toContain("inner.txt");
    expect(r.out).toContain("statusLine");
  });

  test("bundle gone and settings.json is clean → --purge deletes ~/.siltpoke", async () => {
    await writeShim(home);
    writeFileSync(settingsPath(), JSON.stringify({ statusLine: { command: "echo ORIGINAL" } }));
    rmSync(root, { recursive: true, force: true });

    const r = runUninstall(["--purge"]);
    expect(r.exitCode).toBe(0);
    expect(existsSync(join(home, ".siltpoke"))).toBe(false);
  });

  // `[61]` PR 2, plan P2.4 (AC9): without the bundle no plan can be computed, so
  // the script cannot ask item by item — it says where the record is instead.
  test("bundle gone and a receipt exists → it names the receipt, before anything is deleted", async () => {
    await writeShim(home);
    writeFileSync(settingsPath(), JSON.stringify({ theme: "dark" }));
    writeFileSync(join(home, ".siltpoke", "receipt.json"), '{"version":1,"entries":[],"projects":[]}');
    rmSync(root, { recursive: true, force: true });

    const kept = runUninstall([]);
    expect(kept.out).toContain(join(home, ".siltpoke", "receipt.json"));
    expect(kept.out).toContain("cannot ask");
    expect(existsSync(join(home, ".siltpoke", "receipt.json"))).toBe(true);

    const purged = runUninstall(["--purge"]);
    expect(purged.out).toContain(join(home, ".siltpoke", "receipt.json"));
    expect(existsSync(join(home, ".siltpoke"))).toBe(false);
  });

  test("bundle gone and no receipt → no receipt is mentioned", async () => {
    await writeShim(home);
    writeFileSync(settingsPath(), JSON.stringify({ theme: "dark" }));
    rmSync(root, { recursive: true, force: true });
    expect(runUninstall([]).out).not.toContain("receipt.json");
  });

  test("bundle still on disk → the script itself says nothing about the receipt; the real uninstall shows its plan", async () => {
    await writeShim(home);
    writeFileSync(join(home, ".siltpoke", "receipt.json"), '{"version":1,"entries":[],"projects":[]}');
    expect(runUninstall([], process.env.PATH ?? "").out).not.toContain("receipt.json");
  });

  test("bundle PRESENT but bun unreachable → it says so and deletes nothing, even with --purge and clean settings", async () => {
    // Found in review: this used to fall into the "bundle gone" branch, claim
    // the files were gone, and purge the data of a plugin still installed.
    await writeShim(home);
    writeFileSync(settingsPath(), JSON.stringify({ theme: "dark" }));
    const r = Bun.spawnSync(["/bin/sh", uninstallShimPath(home), "--purge"], {
      env: { PATH: "/usr/bin:/bin", HOME: home },
    });
    const out = new TextDecoder().decode(r.stdout);
    expect(r.exitCode).toBe(1);
    expect(out).toContain("cannot find it");
    expect(out).not.toContain("files are gone");
    expect(existsSync(join(home, ".siltpoke", "plugin-root"))).toBe(true);
    expect(healCalls()).toEqual([]);
  });

  test("bundle gone, settings clean, but Claude Code still lists the plugin → --purge is refused", async () => {
    await writeShim(home);
    writeFileSync(settingsPath(), JSON.stringify({ theme: "dark" }));
    setRegistry(true);
    rmSync(root, { recursive: true, force: true });

    const r = runUninstall(["--purge"]);
    expect(r.exitCode).toBe(1);
    expect(existsSync(join(home, ".siltpoke", "plugin-root"))).toBe(true);
    expect(r.out).toContain("claude plugin uninstall siltpoke");
    // Defect [82]: the shell cannot read the record, so it says what a one-project install needs.
    expect(r.out).toContain("run that command in the project's folder");
    expect(r.out).toContain("--scope local   or   --scope project");
    expect(r.out).not.toContain("rm -rf");
  });

  test("bundle gone, gone from Claude Code, but CodeBuddy still lists the plugin → --purge is refused (the folder is shared)", async () => {
    await writeShim(home);
    writeFileSync(settingsPath(), JSON.stringify({ theme: "dark" }));
    setRegistry(false);
    mkdirSync(join(home, ".codebuddy", "plugins"), { recursive: true });
    writeFileSync(
      join(home, ".codebuddy", "plugins", "installed_plugins.json"),
      JSON.stringify({ plugins: { "siltpoke@siltpoke": [{}] } }),
    );
    rmSync(root, { recursive: true, force: true });

    const r = runUninstall(["--purge"]);
    expect(r.exitCode).toBe(1);
    expect(existsSync(join(home, ".siltpoke", "plugin-root"))).toBe(true);
    expect(r.out).toContain(".codebuddy");
    expect(r.out).not.toContain("rm -rf");
  });

  test("bundle gone, and `codex plugin list` still names siltpoke → --purge is refused", async () => {
    await writeShim(home);
    writeFileSync(settingsPath(), JSON.stringify({ theme: "dark" }));
    setRegistry(false);
    rmSync(root, { recursive: true, force: true });
    const r = runUninstall(["--purge"], `${fakeCodex('{ "installed": [ { "name": "siltpoke", "source": { "path": "/x" } } ], "available": [] }')}:/usr/bin:/bin`);
    expect(r.exitCode).toBe(1);
    expect(existsSync(join(home, ".siltpoke", "plugin-root"))).toBe(true);
    expect(r.out).toContain("codex plugin list");
  });

  test("…but the word 'siltpoke' only inside a path or a marketplace name does NOT block the purge", async () => {
    // Found in review: a substring match on the text table refused forever on a
    // machine whose paths contain the product name, and nothing could clear it.
    await onlyCodexDecides();
    const list =
      '{ "installed": [ { "name": "other", "marketplace": "siltpoke", "source": { "path": "/Users/a/projects/siltpoke/other" } } ], "available": [] }';
    const r = runUninstall(["--purge"], `${fakeCodex(list)}:/usr/bin:/bin`);
    expect(r.exitCode).toBe(0);
    expect(existsSync(join(home, ".siltpoke"))).toBe(false);
  });

  test("codex lists 'available' BEFORE 'installed' → still refused (key order is not ours to assume)", async () => {
    await onlyCodexDecides();
    const list = '{ "available": [ { "name": "x" } ], "installed": [ { "name": "siltpoke" } ] }';
    const r = runUninstall(["--purge"], `${fakeCodex(list)}:/usr/bin:/bin`);
    expect(r.exitCode).toBe(1);
    expect(existsSync(join(home, ".siltpoke", "plugin-root"))).toBe(true);
    expect(r.out).toContain("codex plugin list");
  });

  test("codex output with tabs and CRLF → still refused", async () => {
    await onlyCodexDecides();
    const list = '{\r\n\t"installed": [\r\n\t\t{ "name"\t:\t"siltpoke" }\r\n\t],\r\n\t"available": []\r\n}\r\n';
    const r = runUninstall(["--purge"], `${fakeCodex(list)}:/usr/bin:/bin`);
    expect(r.exitCode).toBe(1);
    expect(existsSync(join(home, ".siltpoke", "plugin-root"))).toBe(true);
  });

  test("siltpoke listed only as AVAILABLE in codex → refused (block too often rather than miss), and the manual way out is printed", async () => {
    // Telling "available" from "installed" needs a JSON parser the script does
    // not have. A wrong "not installed" lets rm -rf through while codex hooks
    // still write the folder, so the script refuses and says how to finish.
    await onlyCodexDecides();
    const list = '{ "installed": [], "available": [ { "name": "siltpoke" } ] }';
    const r = runUninstall(["--purge"], `${fakeCodex(list)}:/usr/bin:/bin`);
    expect(r.exitCode).toBe(1);
    expect(existsSync(join(home, ".siltpoke", "plugin-root"))).toBe(true);
    expect(r.out).toContain(`rm -rf ${home}/.siltpoke`);
  });

  test.each([
    ["fails", "#!/bin/sh\necho 'not logged in' >&2\nexit 1\n"],
    ["exits 0 but prints nothing", "#!/bin/sh\nexit 0\n"],
  ])("codex is on PATH but its list %s → refused as unknown, not read as 'not installed'", async (_case, script) => {
    // Found in review (round 6): a failing codex printed nothing, grep found
    // nothing, and rm -rf ran. The TS uninstall already treats this as unknown.
    await onlyCodexDecides();
    const bin = join(home, "fakebin");
    mkdirSync(bin, { recursive: true });
    writeFileSync(join(bin, "codex"), script, { mode: 0o755 });
    const r = runUninstall(["--purge"], `${bin}:/usr/bin:/bin`);
    expect(r.exitCode).toBe(1);
    expect(existsSync(join(home, ".siltpoke", "plugin-root"))).toBe(true);
    expect(r.out).toContain("could not be read");
    expect(r.out).toContain(`rm -rf ${home}/.siltpoke`);
  });

  test("bundle gone, settings clean, but the plugin folder is still in Gemini (agy) → --purge is refused", async () => {
    await onlyCodexDecides();
    mkdirSync(join(home, ".gemini", "config", "plugins", "siltpoke"), { recursive: true });
    const r = runUninstall(["--purge"]);
    expect(r.exitCode).toBe(1);
    expect(existsSync(join(home, ".siltpoke", "plugin-root"))).toBe(true);
    expect(r.out).toContain(".gemini");
    expect(r.out).not.toContain("rm -rf");
  });

  test.each(["installed_plugins.json", "installed_plugins_v2.json"])(
    "bundle gone, settings clean, but qoder's %s still lists the plugin → --purge is refused",
    async (file) => {
      await onlyCodexDecides();
      mkdirSync(join(home, ".qoder", "plugins"), { recursive: true });
      writeFileSync(join(home, ".qoder", "plugins", file), JSON.stringify({ plugins: { "siltpoke@siltpoke": [{}] } }));
      const r = runUninstall(["--purge"]);
      expect(r.exitCode).toBe(1);
      expect(existsSync(join(home, ".siltpoke", "plugin-root"))).toBe(true);
      expect(r.out).toContain(join(".qoder", "plugins", file));
    },
  );

  test("Claude Code AND codex both list it → both are named, and the manual delete is NOT offered", async () => {
    // Found in review: STILL kept only the last match, so codex hid Claude Code
    // and the "delete it yourself" line pointed at a folder another host's
    // hooks would write straight back.
    await onlyCodexDecides();
    setRegistry(true);
    const list = '{ "installed": [ { "name": "siltpoke" } ], "available": [] }';
    const r = runUninstall(["--purge"], `${fakeCodex(list)}:/usr/bin:/bin`);
    expect(r.exitCode).toBe(1);
    expect(existsSync(join(home, ".siltpoke", "plugin-root"))).toBe(true);
    expect(r.out).toContain("installed_plugins.json");
    expect(r.out).toContain("codex plugin list");
    expect(r.out).not.toContain("rm -rf");
  });

  test("bundle gone and settings.json holds the WINDOWS form of the shim path → --purge is still refused", async () => {
    await writeShim(home);
    saveOriginal("echo ORIGINAL");
    // JSON.stringify doubles the backslashes, exactly as settings.json stores them.
    writeFileSync(
      settingsPath(),
      JSON.stringify({ statusLine: { command: '"C:\\Git\\bin\\bash.exe" C:\\Users\\a\\.siltpoke\\bin\\statusline.sh' } }),
    );
    rmSync(root, { recursive: true, force: true });

    const r = runUninstall(["--purge"]);
    expect(r.exitCode).toBe(1);
    expect(existsSync(join(home, ".siltpoke", "inner.txt"))).toBe(true);
  });

  test("bundle gone, settings clean, no --purge → nothing is deleted and it says how to", async () => {
    await writeShim(home);
    writeFileSync(settingsPath(), JSON.stringify({ theme: "dark" }));
    rmSync(root, { recursive: true, force: true });

    const r = runUninstall([]);
    expect(r.exitCode).toBe(0);
    expect(existsSync(join(home, ".siltpoke", "plugin-root"))).toBe(true);
    expect(r.out).toContain("--purge");
  });

  test("a session start gives it to someone who set up before it existed — and to nobody who never set up", async () => {
    expect(await refreshStaleShims(home)).toEqual([]);
    expect(existsSync(uninstallShimPath(home))).toBe(false);

    await writeShim(home);
    rmSync(uninstallShimPath(home));
    expect(await refreshStaleShims(home)).toEqual([uninstallShimPath(home)]);
    expect(readFileSync(uninstallShimPath(home), "utf8")).toBe(renderUninstallShim());
  });
});
