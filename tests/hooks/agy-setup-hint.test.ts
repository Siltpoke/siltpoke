// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
// Copyright (c) 2026 Jiaqi Duan
//
// agy's setup hint lives on the statusline, not in the Stop hook's output.
//
// Measured 2026-09-29 in a real interactive agy session (install audit §50):
// agy shows NOTHING a Stop hook prints — stderr, `{"systemMessage": …}` and
// `{"decision":"stop","reason": …}` all ran (marker files prove it) and all
// reached the screen 0 times. agy's own Stop-hook response schema has only
// `decision` and `reason`. The one surface agy does render is the statusline
// command, which setup normally wires to the pet — so before setup the hook
// wires it to a one-line hint instead. These tests run the real
// hooks/agy-stop.sh against a temp HOME.
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
import { AGY_HINT_TEXT } from "../../src/hooks/agy-setup-hint";

const REPO = process.cwd();
const SHELL = existsSync("/bin/dash") ? "/bin/dash" : "sh";

let home: string;
let settingsPath: string;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "siltpoke-agy-hint-"));
  settingsPath = join(home, ".gemini", "antigravity-cli", "settings.json");
});
afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

function runHook() {
  const env: Record<string, string | undefined> = {
    ...process.env,
    HOME: home,
    ANTIGRAVITY_PLUGIN_ROOT: REPO,
  };
  delete env.SILTPOKE_HOME;
  delete env.ANTIGRAVITY_HOME;
  delete env.GEMINI_HOME;
  return Bun.spawnSync([SHELL, join(REPO, "hooks", "agy-stop.sh")], {
    env,
    stdin: new TextEncoder().encode('{"session_id":"agy-t"}'),
  });
}

function readSettings(): Record<string, unknown> {
  return JSON.parse(readFileSync(settingsPath, "utf8")) as Record<string, unknown>;
}

function writeSettings(obj: unknown): void {
  mkdirSync(join(home, ".gemini", "antigravity-cli"), { recursive: true });
  writeFileSync(settingsPath, `${JSON.stringify(obj, null, 2)}\n`);
}

/** Run the statusline command agy would run, exactly as written. */
function renderStatusline(): string {
  const cmd = (readSettings().statusLine as { command: string }).command;
  const r = Bun.spawnSync(["sh", "-c", cmd], { stdin: new TextEncoder().encode("{}") });
  return new TextDecoder().decode(r.stdout);
}

describe("agy setup hint on the statusline", () => {
  test("no setup, no settings.json: the statusline is wired to the hint, and the hook prints nothing", () => {
    const r = runHook();
    expect(r.exitCode).toBe(0);
    expect(new TextDecoder().decode(r.stdout)).toBe("");
    expect(new TextDecoder().decode(r.stderr)).toBe("");
    expect(readSettings().statusLine).toMatchObject({ type: "command" });
    expect(renderStatusline()).toBe(AGY_HINT_TEXT);
  });

  test("the user's other agy settings survive", () => {
    writeSettings({ colorScheme: "tokyo night", trustedWorkspaces: ["/a"] });
    runHook();
    const s = readSettings();
    expect(s.colorScheme).toBe("tokyo night");
    expect(s.trustedWorkspaces).toEqual(["/a"]);
    expect(renderStatusline()).toBe(AGY_HINT_TEXT);
  });

  test("an existing statusline — anyone's — is never touched", () => {
    writeSettings({ statusLine: { type: "command", command: "echo someone-else" } });
    const before = readFileSync(settingsPath);
    runHook();
    runHook();
    expect(readFileSync(settingsPath).equals(before)).toBe(true);
  });

  test("offered once: a hint the user removed is not put back", () => {
    runHook();
    const s = readSettings();
    delete s.statusLine;
    writeSettings(s);
    runHook();
    expect(readSettings().statusLine).toBeUndefined();
  });

});

describe("agy setup hint — when it is and is not offered", () => {
  test("an unreadable settings.json is left alone and retried later, not marked done", () => {
    mkdirSync(join(home, ".gemini", "antigravity-cli"), { recursive: true });
    writeFileSync(settingsPath, "{ not json");
    runHook();
    expect(readFileSync(settingsPath, "utf8")).toBe("{ not json");
    // Fixed by the user later ⇒ the hint still arrives, because nothing was marked.
    writeSettings({ colorScheme: "x" });
    runHook();
    expect(renderStatusline()).toBe(AGY_HINT_TEXT);
  });

  test("after setup (config.json exists) a statusLine of the user's own is untouched (pet wiring: tests/hooks/agy-wire-pet.test.ts)", () => {
    mkdirSync(join(home, ".siltpoke"), { recursive: true });
    writeFileSync(join(home, ".siltpoke", "config.json"), "{}");
    writeSettings({ statusLine: { type: "command", command: "echo mine" } });
    const before = readFileSync(settingsPath);
    runHook();
    expect(readFileSync(settingsPath).equals(before)).toBe(true);
  });

  test("after setup an empty slot gets the pet, never the hint", () => {
    mkdirSync(join(home, ".siltpoke"), { recursive: true });
    writeFileSync(join(home, ".siltpoke", "config.json"), "{}");
    writeSettings({ colorScheme: "x" });
    runHook();
    const cmd = (readSettings().statusLine as { command: string }).command;
    expect(cmd).not.toContain(AGY_HINT_TEXT);
    expect(cmd).toContain("siltpoke-card.js");
  });

  test("the hint goes blank once setup has run — plugin-path setup never rewrites agy's statusline", () => {
    runHook();
    expect(renderStatusline()).toBe(AGY_HINT_TEXT);
    mkdirSync(join(home, ".siltpoke"), { recursive: true });
    writeFileSync(join(home, ".siltpoke", "config.json"), "{}");
    expect(renderStatusline()).toBe("");
  });

});

describe("agy setup hint — when it goes blank", () => {
  test("the hint goes blank once the plugin directory is gone (uninstalled)", () => {
    const fakeRoot = mkdtempSync(join(tmpdir(), "siltpoke-agy-root-"));
    try {
      const env: Record<string, string | undefined> = { ...process.env, HOME: home };
      delete env.SILTPOKE_HOME;
      Bun.spawnSync(["bun", join(REPO, "dist", "agy-stop.js"), "--setup-hint", fakeRoot], {
        env,
        stdin: "ignore",
      });
      expect(renderStatusline()).toBe(AGY_HINT_TEXT);
    } finally {
      rmSync(fakeRoot, { recursive: true, force: true });
    }
    expect(renderStatusline()).toBe("");
  });

  test("stdin is drained on the no-setup path (a large write raises no EPIPE)", async () => {
    // Moved here with agy-stop.sh's nudge. A hook that exits without reading
    // stdin makes the host's pipe write fail; see host-aware-nudge.test.ts for
    // why the async EPIPE form is the discriminator and a timeout is not.
    const env: Record<string, string | undefined> = { ...process.env, HOME: home, ANTIGRAVITY_PLUGIN_ROOT: REPO };
    delete env.SILTPOKE_HOME;
    const proc = Bun.spawn([SHELL, join(REPO, "hooks", "agy-stop.sh")], {
      env,
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    });
    let writeErr: unknown = null;
    try {
      proc.stdin.write(new Uint8Array(4 * 1024 * 1024).fill(120));
      await proc.stdin.end();
    } catch (e) {
      writeErr = e;
    }
    expect(await proc.exited).toBe(0);
    expect(writeErr).toBeNull();
  });

});

describe("agy setup hint — never damages the user's settings file", () => {
  test("a symlinked settings.json (dotfiles) stays a symlink and is never written", () => {
    const real = join(home, "dotfiles-agy-settings.json");
    writeFileSync(real, `${JSON.stringify({ colorScheme: "x" }, null, 2)}\n`);
    mkdirSync(join(home, ".gemini", "antigravity-cli"), { recursive: true });
    symlinkSync(real, settingsPath);
    const before = readFileSync(real);
    runHook();
    expect(lstatSync(settingsPath).isSymbolicLink()).toBe(true);
    expect(readFileSync(real).equals(before)).toBe(true);
  });

  test("the settings file keeps its permissions", () => {
    writeSettings({ colorScheme: "x" });
    chmodSync(settingsPath, 0o600);
    runHook();
    expect(renderStatusline()).toBe(AGY_HINT_TEXT);
    expect(statSync(settingsPath).mode & 0o777).toBe(0o600);
  });

  test("the statusline command exits 0 even when it prints nothing", () => {
    runHook();
    mkdirSync(join(home, ".siltpoke"), { recursive: true });
    writeFileSync(join(home, ".siltpoke", "config.json"), "{}");
    const cmd = (readSettings().statusLine as { command: string }).command;
    const r = Bun.spawnSync(["sh", "-c", cmd], { stdin: new TextEncoder().encode("{}") });
    expect(new TextDecoder().decode(r.stdout)).toBe("");
    expect(r.exitCode).toBe(0);
  });

  test("the hint names no slash command — agy has none", () => {
    expect(AGY_HINT_TEXT).not.toContain("/siltpoke-");
    expect(AGY_HINT_TEXT).toContain("set up Siltpoke");
  });
});
