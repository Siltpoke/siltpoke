// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
// Copyright (c) 2026 Jiaqi Duan
/**
 * Plugin-path setup wires the pet into agy's statusline too — defect `[35]`.
 *
 * WHY — install audit §50.4 (an internal design note).
 * `dist/siltpoke-configure.js` (skills/siltpoke/SKILL.md step 4) only ever
 * wrote Claude Code's statusline. The source install writes agy's
 * (`cleanAgyOrphanSettings`), the plugin path never did, so an agy user who
 * installed the plugin and ran setup saw no pet in agy at all.
 *
 * the maintainer's rule (2026-09-29): a statusline that belongs to the user or to
 * another tool is left alone and the summary says so. Only an empty slot, our
 * own setup hint (defect `[34]`) or an older siltpoke pet is replaced.
 *
 * Every case runs the real CLI entry against a temp HOME with a fake agy
 * plugin directory.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runConfigureCli } from "../../src/cli/configure";
import { AGY_HINT_TEXT } from "../../src/hooks/agy-setup-hint";

const SHELL = existsSync("/bin/dash") ? "/bin/dash" : "sh";
const AGY_ENV_KEYS = ["ANTIGRAVITY_HOME", "GEMINI_HOME", "ANTIGRAVITY_HOOKS_HOME", "SILTPOKE_HOME"];

let home: string;
let settingsPath: string;
let pluginRoot: string;
const saved: Record<string, string | undefined> = {};

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "siltpoke-cfg35-"));
  settingsPath = join(home, ".gemini", "antigravity-cli", "settings.json");
  pluginRoot = join(home, ".gemini", "config", "plugins", "siltpoke");
  for (const k of AGY_ENV_KEYS) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
});
afterEach(() => {
  for (const k of AGY_ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  rmSync(home, { recursive: true, force: true });
});

/**
 * A stand-in card: prints its own argv so a test can see what agy would run —
 * and, like a crashing card would, writes to stderr and exits non-zero, so the
 * command's own stderr/exit-code guard is what the tests see.
 */
function installAgyPlugin(): string {
  const card = join(pluginRoot, "dist", "siltpoke-card.js");
  mkdirSync(join(pluginRoot, "dist"), { recursive: true });
  writeFileSync(
    card,
    'process.stdout.write("PET " + process.argv.slice(2).join(" ")); process.stderr.write("card noise"); process.exit(3);\n',
  );
  return card;
}

function writeSettings(value: unknown): void {
  mkdirSync(join(home, ".gemini", "antigravity-cli"), { recursive: true });
  writeFileSync(settingsPath, `${JSON.stringify(value, null, 2)}\n`);
}

function statusCommand(): string | undefined {
  const parsed = JSON.parse(readFileSync(settingsPath, "utf8")) as {
    statusLine?: { command?: string };
  };
  return parsed.statusLine?.command;
}

const noAutostart = {
  installAutostart: async () => ({ status: "skipped" as const, platform: "test" }),
};
const ARGS = ["--name", "Mossbite", "--species", "slime", "--personality", "gentle"];

async function setup(statusline = true) {
  const out: string[] = [];
  const err: string[] = [];
  const code = await runConfigureCli(statusline ? [...ARGS, "--statusline"] : ARGS, home, {
    ...noAutostart,
    out: (s: string) => out.push(s),
    warn: (s: string) => err.push(s),
  });
  return { code, out: out.join("\n"), err: err.join("\n") };
}

describe("plugin setup wires agy's statusline (defect [35]) — wiring", () => {
  test("empty slot: the pet is wired, and the summary says agy", async () => {
    const card = installAgyPlugin();
    writeSettings({ colorScheme: "tokyo night" });
    const r = await setup();
    expect(r.code).toBe(0);
    const cmd = statusCommand();
    expect(cmd).toContain(card);
    expect(cmd).toContain("--agent antigravity");
    expect(r.out).toMatch(/agy/i);
    expect(r.out).not.toMatch(/agy.*(left|not|failed)/i);
  });

  test("no settings.json yet: created with the pet", async () => {
    installAgyPlugin();
    await setup();
    expect(statusCommand()).toContain("--agent antigravity");
  });

  test("the written command really runs the card under sh, with the agy flag", async () => {
    installAgyPlugin();
    await setup();
    const proc = Bun.spawnSync([SHELL, "-c", statusCommand() ?? ""], {
      stdin: new TextEncoder().encode("{}"),
    });
    expect(proc.exitCode).toBe(0);
    expect(proc.stdout.toString()).toBe("PET --agent antigravity");
    expect(proc.stderr.toString()).toBe("");
  });

  // The next two derive from the command setup really writes (not a frozen
  // literal), so they keep testing the card-path check when the shape changes.
  test("a command shaped like ours but running some other file is left alone", async () => {
    const card = installAgyPlugin();
    await setup();
    const lookalike = (statusCommand() ?? "").replace(card, "/opt/other/status.js");
    expect(lookalike).toContain("/opt/other/status.js");
    writeSettings({ statusLine: { type: "command", command: lookalike } });
    const before = readFileSync(settingsPath);
    await setup();
    expect(readFileSync(settingsPath).equals(before)).toBe(true);
  });

  test("our pet written with Windows separators is still ours", async () => {
    const card = installAgyPlugin();
    await setup();
    const windowsCard = "C:\\Users\\u\\.gemini\\config\\plugins\\siltpoke\\dist\\siltpoke-card.js";
    const written = (statusCommand() ?? "").replace(card, windowsCard);
    expect(written).toContain(windowsCard);
    writeSettings({ statusLine: { type: "command", command: written } });
    await setup();
    expect(statusCommand()).toContain(card);
  });

});

describe("plugin setup wires agy's statusline (defect [35]) — after setup, bun moves or vanishes", () => {
  test("bun moved after setup: the pet still renders via the recorded bun-path", async () => {
    installAgyPlugin();
    await setup();
    expect(existsSync(join(home, ".siltpoke", "bun-path"))).toBe(true);
    const cmd = (statusCommand() ?? "").replace(process.execPath, join(home, "no-such-bun"));
    const proc = Bun.spawnSync([SHELL, "-c", cmd], {
      stdin: new TextEncoder().encode("{}"),
      env: { HOME: home, PATH: "/usr/bin:/bin" },
    });
    expect(proc.stdout.toString()).toBe("PET --agent antigravity");
  });

  test("bun moved after setup: the pet still renders via PATH", async () => {
    installAgyPlugin();
    await setup();
    const cmd = (statusCommand() ?? "").replace(process.execPath, join(home, "no-such-bun"));
    expect(cmd).toContain("no-such-bun");
    // Without this the bun-path record answers first and PATH is never tested.
    rmSync(join(home, ".siltpoke", "bun-path"), { force: true });
    const bunDir = process.execPath.slice(0, process.execPath.lastIndexOf("/"));
    const proc = Bun.spawnSync([SHELL, "-c", cmd], {
      stdin: new TextEncoder().encode("{}"),
      env: { HOME: home, PATH: `${bunDir}:/usr/bin:/bin` },
    });
    expect(proc.exitCode).toBe(0);
    expect(proc.stdout.toString()).toBe("PET --agent antigravity");
  });

});

describe("plugin setup wires agy's statusline (defect [35]) — bun edge cases and Windows paths", () => {
  test("a bun-path record that names a directory: says no bun, not a blank line", async () => {
    installAgyPlugin();
    await setup();
    const cmd = (statusCommand() ?? "").replace(process.execPath, join(home, "no-such-bun"));
    writeFileSync(join(home, ".siltpoke", "bun-path"), `${home}\n`);
    const proc = Bun.spawnSync([SHELL, "-c", cmd], {
      stdin: new TextEncoder().encode("{}"),
      env: { HOME: home, PATH: "/usr/bin:/bin" },
    });
    expect(proc.exitCode).toBe(0);
    expect(proc.stdout.toString()).toBe("siltpoke: can't find bun (not on PATH)");
  });

  test("an older siltpoke pet written with Windows separators is still ours", async () => {
    const card = installAgyPlugin();
    writeSettings({
      statusLine: { type: "command", command: "C:\\bun\\bun.exe C:\\repo\\src\\face\\wrapper.ts --agent antigravity" },
    });
    await setup();
    expect(statusCommand()).toContain(card);
  });

  test("no bun anywhere: says so on the statusline, exits 0, no stderr", async () => {
    installAgyPlugin();
    await setup();
    const cmd = (statusCommand() ?? "").replace(process.execPath, join(home, "no-such-bun"));
    // Setup recorded bun's location here; that record is a fallback too.
    rmSync(join(home, ".siltpoke", "bun-path"), { force: true });
    const proc = Bun.spawnSync([SHELL, "-c", cmd], {
      stdin: new TextEncoder().encode("{}"),
      env: { HOME: home, PATH: "/usr/bin:/bin" },
    });
    expect(proc.exitCode).toBe(0);
    expect(proc.stdout.toString()).toBe("siltpoke: can't find bun (not on PATH)");
    expect(proc.stderr.toString()).toBe("");
  });

});

describe("plugin setup wires agy's statusline (defect [35]) — what counts as ours", () => {
  test("other settings keys survive", async () => {
    installAgyPlugin();
    writeSettings({ colorScheme: "tokyo night", trustedWorkspaces: ["/a", "/b"] });
    await setup();
    const parsed = JSON.parse(readFileSync(settingsPath, "utf8"));
    expect(parsed.colorScheme).toBe("tokyo night");
    expect(parsed.trustedWorkspaces).toEqual(["/a", "/b"]);
  });

  test("our own setup hint ([34]) is replaced by the pet", async () => {
    installAgyPlugin();
    // Frozen literal of the [34] command's shape, with DIFFERENT wording: a hint
    // written by an older release must still be recognised after the text changes.
    writeSettings({
      statusLine: {
        type: "command",
        command: "cat >/dev/null; [ -d '/p/siltpoke' ] && [ ! -f '/h/.siltpoke/config.json' ] && printf '%s' 'an older wording of the hint'; true",
      },
    });
    await setup();
    expect(statusCommand()).toContain("--agent antigravity");
    expect(statusCommand()).not.toContain("older wording");
  });

  test("the hint the [34] hook really writes is recognised too", async () => {
    installAgyPlugin();
    const real = `cat >/dev/null; [ -d '${pluginRoot}' ] && [ ! -f '${join(home, ".siltpoke", "config.json")}' ] && printf '%s' '${AGY_HINT_TEXT}'; true`;
    writeSettings({ statusLine: { type: "command", command: real } });
    await setup();
    expect(statusCommand()).toContain("--agent antigravity");
  });

  test("an older siltpoke pet (source install) is replaced", async () => {
    const card = installAgyPlugin();
    writeSettings({
      statusLine: { type: "command", command: "/old/bun /old/repo/src/face/wrapper.ts --agent antigravity" },
    });
    await setup();
    expect(statusCommand()).toContain(card);
  });

});

describe("plugin setup wires agy's statusline (defect [35]) — what is left alone", () => {
  test("someone else's statusline is left byte-for-byte, and the summary says so", async () => {
    installAgyPlugin();
    writeSettings({ statusLine: { type: "command", command: "my-own-status --git" } });
    const before = readFileSync(settingsPath);
    const r = await setup();
    expect(r.code).toBe(0);
    expect(readFileSync(settingsPath).equals(before)).toBe(true);
    expect(r.out).toMatch(/agy/i);
    expect(r.out).toMatch(/left (it )?alone/i);
  });

  for (const foreign of [
    "/opt/interface/wrapper.sh --git",
    "my-status.sh | bun /x/dist/siltpoke-card.js --agent antigravity",
    "bun /x/src/face/wrapper.ts --agent antigravity; my-extra-status",
    "echo 'siltpoke-card.js'",
  ]) {
    test(`a foreign command that only mentions our files is left alone: ${foreign}`, async () => {
      installAgyPlugin();
      writeSettings({ statusLine: { type: "command", command: foreign } });
      const before = readFileSync(settingsPath);
      const r = await setup();
      expect(readFileSync(settingsPath).equals(before)).toBe(true);
      expect(r.out).toMatch(/left (it )?alone/i);
    });
  }

  for (const odd of [null, "a bare string", [], {}]) {
    test(`a statusLine of ${JSON.stringify(odd)} is left alone`, async () => {
      installAgyPlugin();
      writeSettings({ statusLine: odd });
      const before = readFileSync(settingsPath);
      await setup();
      expect(readFileSync(settingsPath).equals(before)).toBe(true);
    });
  }

});

describe("plugin setup wires agy's statusline (defect [35]) — failures never take the pet down", () => {
  test("a write that throws does not take the pet down", async () => {
    installAgyPlugin();
    mkdirSync(join(home, ".gemini"), { recursive: true });
    writeFileSync(join(home, ".gemini", "antigravity-cli"), "a file where a directory should be");
    const r = await setup();
    expect(r.code).toBe(0);
    expect(existsSync(join(home, ".siltpoke", "config.json"))).toBe(true);
    expect(r.out).toMatch(/agy statusline NOT installed/);
  });

  test("no agy plugin installed: agy's settings are not touched or created", async () => {
    const r = await setup();
    expect(existsSync(settingsPath)).toBe(false);
    expect(r.out).not.toMatch(/agy/i);
  });

  test("statusline turned off: agy is not touched either", async () => {
    installAgyPlugin();
    writeSettings({ colorScheme: "x" });
    const before = readFileSync(settingsPath);
    await setup(false);
    expect(readFileSync(settingsPath).equals(before)).toBe(true);
  });

  test("unreadable settings.json is left as-is, the pet still installs", async () => {
    installAgyPlugin();
    mkdirSync(join(home, ".gemini", "antigravity-cli"), { recursive: true });
    writeFileSync(settingsPath, "{ not json");
    const r = await setup();
    expect(r.code).toBe(0);
    expect(readFileSync(settingsPath, "utf8")).toBe("{ not json");
    expect(existsSync(join(home, ".siltpoke", "config.json"))).toBe(true);
    expect(r.out).toMatch(/agy.*not/i);
  });

});

describe("plugin setup wires agy's statusline (defect [35]) — file protections and re-runs", () => {
  test("a symlinked settings.json (dotfiles) is not replaced with a plain file", async () => {
    installAgyPlugin();
    const real = join(home, "dotfiles-agy.json");
    writeFileSync(real, "{}\n");
    mkdirSync(join(home, ".gemini", "antigravity-cli"), { recursive: true });
    symlinkSync(real, settingsPath);
    await setup();
    expect(lstatSync(settingsPath).isSymbolicLink()).toBe(true);
    expect(readFileSync(real, "utf8")).toBe("{}\n");
  });

  test("file permissions are kept", async () => {
    installAgyPlugin();
    writeSettings({});
    chmodSync(settingsPath, 0o600);
    await setup();
    expect(statSync(settingsPath).mode & 0o777).toBe(0o600);
  });

  test("a second setup run keeps the pet (it is ours) and stays quiet about 'left alone'", async () => {
    installAgyPlugin();
    await setup();
    const first = statusCommand();
    const r = await setup();
    expect(statusCommand()).toBe(first);
    expect(r.out).not.toMatch(/left (it )?alone/i);
  });
});
