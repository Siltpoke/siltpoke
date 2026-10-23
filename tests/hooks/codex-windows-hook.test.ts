// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
// Copyright (c) 2026 Jiaqi Duan
//
// codex never started a Siltpoke review on Windows (Run 4, 2026-10-14): a real
// commit in codex left `brain-calls.jsonl` and `markers/` untouched, while
// doctor printed "All 24 checks passed". Read in codex's source (rust-v0.162.1):
//   - a plugin's hooks come from its manifest's `hooks` key, else from
//     `hooks/hooks.json` — Claude Code's file. Our codex `hooks.json` at the
//     plugin root was never read;
//   - commands run through `cmd.exe /C` on Windows and `$SHELL -lc` elsewhere,
//     with the SESSION's cwd, so a `./hooks/…` path does not resolve;
//   - `${PLUGIN_ROOT}` is substituted as text, and `commandWindows` replaces
//     `command` on Windows.
// So the manifest now names the codex file, the commands carry `${PLUGIN_ROOT}`,
// and Windows gets a PowerShell command that hands the payload to the guard in a
// `codex-` mode. What this suite cannot show: that codex on Windows really runs
// it. That is a run on the Windows machine.
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const REPO = join(import.meta.dir, "..", "..");
const guardPath = join(REPO, "src", "hooks", "hook-guard.ts");

// A siltpoke-spawned session would make the guard exit early for every case.
delete process.env.SILTPOKE_INTERNAL;

const made: string[] = [];
function temp(): string {
  const d = mkdtempSync(join(tmpdir(), "siltpoke-codex-win-"));
  made.push(d);
  return d;
}
afterEach(() => {
  for (const d of made.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** A plugin root whose bundles write which one ran, and the SILTPOKE_HOST it saw. */
function pluginRootWithWitness(): { root: string; witness: string } {
  const root = temp();
  mkdirSync(join(root, "dist"), { recursive: true });
  const witness = join(root, "ran.txt");
  for (const bundle of ["siltpoke-stop.js", "handle-session-start.js", "codex-stop.js"]) {
    writeFileSync(
      join(root, "dist", bundle),
      `require("node:fs").writeFileSync(${JSON.stringify(witness)}, ${JSON.stringify(bundle)} + " " + (process.env.SILTPOKE_HOST ?? "<unset>"));\n`,
    );
  }
  return { root, witness };
}

async function guard(mode: string, env: Record<string, string>) {
  const proc = Bun.spawn([process.execPath, guardPath, mode], {
    // codex exports CLAUDE_PLUGIN_ROOT (and PLUGIN_ROOT) to every plugin hook.
    env: { ...process.env, ...env },
    stdin: new TextEncoder().encode('{"session_id":"s"}'),
    stdout: "pipe",
    stderr: "pipe",
  });
  const [out, err] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
  return { out, err, code: await proc.exited };
}

describe("the guard's codex modes", () => {
  test("codex-stop runs codex's bundle as codex, although codex exports CLAUDE_PLUGIN_ROOT", async () => {
    const home = temp();
    writeFileSync(join(home, "config.json"), "{}");
    const { root, witness } = pluginRootWithWitness();
    const r = await guard("codex-stop", { SILTPOKE_HOME: home, CLAUDE_PLUGIN_ROOT: root, PLUGIN_ROOT: root });
    expect([r.code, r.out, r.err]).toEqual([0, "", ""]);
    expect(readFileSync(witness, "utf8")).toBe("codex-stop.js codex");
    expect(readFileSync(join(home, "last-host"), "utf8").split("\n")[0]).toBe("codex");
  });

  test("codex-session-start runs the session-start bundle as codex and writes no plugin-root pointer", async () => {
    const home = temp();
    writeFileSync(join(home, "config.json"), "{}");
    const { root, witness } = pluginRootWithWitness();
    await guard("codex-session-start", { SILTPOKE_HOME: home, CLAUDE_PLUGIN_ROOT: root });
    expect(readFileSync(witness, "utf8")).toBe("handle-session-start.js codex");
    // hooks/codex-session-start.sh writes none; the Windows twin must not either.
    expect(existsSync(join(home, "plugin-root"))).toBe(false);
  });

  test("codex-stop before setup: silent, and the Claude Code nudge marker is not burned", async () => {
    const home = temp();
    const { root } = pluginRootWithWitness();
    const r = await guard("codex-stop", { SILTPOKE_HOME: home, CLAUDE_PLUGIN_ROOT: root });
    expect([r.code, r.out, r.err]).toEqual([0, "", ""]);
    expect(existsSync(join(home, ".setup-nudged"))).toBe(false);
  });

  test("control: plain `stop` with the same environment is still Claude Code's bundle, as claude", async () => {
    const home = temp();
    writeFileSync(join(home, "config.json"), "{}");
    const { root, witness } = pluginRootWithWitness();
    await guard("stop", { SILTPOKE_HOME: home, CLAUDE_PLUGIN_ROOT: root });
    expect(readFileSync(witness, "utf8")).toBe("siltpoke-stop.js claude");
  });
});

type Handler = { type: string; command: string; commandWindows?: string };
const codexHooks = JSON.parse(readFileSync(join(REPO, "hooks.json"), "utf8")) as {
  hooks: Record<string, Array<{ hooks: Handler[] }>>;
};

describe("codex's hooks file", () => {
  test("the codex manifest names it — otherwise codex reads Claude Code's hooks/hooks.json", () => {
    const manifest = JSON.parse(readFileSync(join(REPO, ".codex-plugin", "plugin.json"), "utf8"));
    expect(manifest.hooks).toBe("./hooks.json");
  });

  for (const [event, script, mode] of [
    ["Stop", "codex-stop.sh", "codex-stop"],
    ["SessionStart", "codex-session-start.sh", "codex-session-start"],
  ] as const) {
    const handlers = codexHooks.hooks[event]?.flatMap((g) => g.hooks) ?? [];

    test(`${event}: exactly one handler, so one turn is one review`, () => {
      expect(handlers).toHaveLength(1);
    });

    test(`${event}: the Unix command names the script through \${PLUGIN_ROOT}, not the session cwd`, () => {
      expect(handlers[0]?.command).toBe(`sh "\${PLUGIN_ROOT}/hooks/${script}"`);
    });

    test(`${event}: Windows gets the PowerShell launcher in the ${mode} mode`, () => {
      const win = handlers[0]?.commandWindows ?? "";
      expect(win).toContain(`-File "\${PLUGIN_ROOT}/hooks/siltpoke-hook.ps1"`);
      expect(win.trimEnd()).toEndWith(` ${mode}`);
      expect(win).toContain("-NoProfile");
      expect(win).toContain("-ExecutionPolicy Bypass");
      // cmd.exe does not treat `;` as a separator: `; exit 0` would reach
      // PowerShell as extra arguments and stop the script before its first line.
      expect(win).not.toContain(";");
    });
  }
});

describe("the launcher's codex modes", () => {
  const ps1 = readFileSync(join(REPO, "hooks", "siltpoke-hook.ps1"), "utf8");

  test("it forwards both codex modes to the guard", () => {
    expect(ps1).toContain("@('session-start', 'codex-stop', 'codex-session-start') -contains $Mode");
  });

  test("it does not stand down for codex when `sh` is on PATH — codex runs only commandWindows there", () => {
    const line = ps1.split("\n").find((l) => l.includes("Get-Command sh -ErrorAction SilentlyContinue"));
    expect(line).toContain("($Mode -notlike 'codex-*')");
  });
});
