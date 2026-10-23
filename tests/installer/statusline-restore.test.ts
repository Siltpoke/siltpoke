// Defect [61]: `claude plugin uninstall siltpoke` leaves settings.json pointing
// at ~/.siltpoke/bin/statusline.sh. `restoreUserStatusLine` is the surgical
// undo — it puts back ONLY the statusLine, from ~/.siltpoke/inner.txt, and
// touches no other key. (The older `runUninstall` copies a whole backup file
// over settings.json, which reverts everything the user changed since setup.)
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  chmodSync,
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
import { isOurStatusLine, restoreUserStatusLine } from "../../src/installer/statusline-restore";

let home: string;
let env: NodeJS.ProcessEnv;
let settingsPath: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "siltpoke-restore-"));
  // Explicit env: never inherit SILTPOKE_HOME / CLAUDE_HOME from the machine
  // running the test, or this would rewrite the real settings.json.
  env = { HOME: home };
  mkdirSync(join(home, ".claude"), { recursive: true });
  mkdirSync(join(home, ".siltpoke"), { recursive: true });
  settingsPath = join(home, ".claude", "settings.json");
});
afterEach(() => { rmSync(home, { recursive: true, force: true }); });

const OURS = (h: string) => `sh ${h}/.siltpoke/bin/statusline.sh`;

function writeSettings(value: unknown): string {
  const raw = `${JSON.stringify(value, null, 2)}\n`;
  writeFileSync(settingsPath, raw);
  return raw;
}
function readSettings(): Record<string, unknown> {
  return JSON.parse(readFileSync(settingsPath, "utf8")) as Record<string, unknown>;
}

describe("isOurStatusLine", () => {
  test("recognises the POSIX shim command", () => {
    expect(isOurStatusLine("sh /Users/a/.siltpoke/bin/statusline.sh")).toBe(true);
  });
  test("recognises the Windows form (Git Bash interpreter, backslashes)", () => {
    expect(
      isOurStatusLine('"C:\\Program Files\\Git\\bin\\bash.exe" C:\\Users\\a\\.siltpoke\\bin\\statusline.sh'),
    ).toBe(true);
  });
  test("a user's own command is not ours — even one that mentions siltpoke", () => {
    expect(isOurStatusLine("echo ORIGINAL")).toBe(false);
    expect(isOurStatusLine("~/bin/my-siltpoke-status.sh")).toBe(false);
    expect(isOurStatusLine(undefined)).toBe(false);
    expect(isOurStatusLine(42)).toBe(false);
  });
});

describe("restoreUserStatusLine", () => {
  test("ours + a saved original → the original command is back, every other key untouched", () => {
    writeSettings({
      statusLine: { type: "command", command: OURS(home) },
      enabledPlugins: { "other@market": true },
      theme: "dark",
      hooks: { Stop: [{ hooks: [{ type: "command", command: "echo mine" }] }] },
    });
    writeFileSync(join(home, ".siltpoke", "inner.txt"), "echo ORIGINAL\n");

    expect(restoreUserStatusLine(env)).toBe("restored");
    expect(readSettings()).toEqual({
      statusLine: { type: "command", command: "echo ORIGINAL" },
      enabledPlugins: { "other@market": true },
      theme: "dark",
      hooks: { Stop: [{ hooks: [{ type: "command", command: "echo mine" }] }] },
    });
  });

  test("other sub-keys of statusLine (the user's `padding`) survive — only the command was ours", () => {
    writeSettings({ statusLine: { type: "command", command: OURS(home), padding: 2 } });
    writeFileSync(join(home, ".siltpoke", "inner.txt"), "echo ORIGINAL");

    expect(restoreUserStatusLine(env)).toBe("restored");
    expect(readSettings()).toEqual({ statusLine: { type: "command", command: "echo ORIGINAL", padding: 2 } });
  });

  test("a symlinked settings.json is written THROUGH: the link stays a link, the target gets the change, its mode is kept", () => {
    const real = join(home, "dotfiles-settings.json");
    writeFileSync(real, JSON.stringify({ statusLine: { type: "command", command: OURS(home) } }));
    chmodSync(real, 0o600);
    symlinkSync(real, settingsPath);
    writeFileSync(join(home, ".siltpoke", "inner.txt"), "echo ORIGINAL");

    expect(restoreUserStatusLine(env)).toBe("restored");
    expect(lstatSync(settingsPath).isSymbolicLink()).toBe(true);
    expect(JSON.parse(readFileSync(real, "utf8"))).toEqual({ statusLine: { type: "command", command: "echo ORIGINAL" } });
    expect(statSync(real).mode & 0o777).toBe(0o600);
  });

  test("ours + no saved original → the statusLine key is removed, not left dangling", () => {
    writeSettings({ statusLine: { type: "command", command: OURS(home) }, theme: "dark" });

    expect(restoreUserStatusLine(env)).toBe("removed");
    const after = readSettings();
    expect("statusLine" in after).toBe(false);
    expect(after).toEqual({ theme: "dark" });
  });

  test("an empty inner.txt counts as no saved original", () => {
    writeSettings({ statusLine: { type: "command", command: OURS(home) } });
    writeFileSync(join(home, ".siltpoke", "inner.txt"), "  \n");

    expect(restoreUserStatusLine(env)).toBe("removed");
    expect("statusLine" in readSettings()).toBe(false);
  });

  test("a saved original that is itself our shim is never written back (it would restore nothing)", () => {
    writeSettings({ statusLine: { type: "command", command: OURS(home) } });
    writeFileSync(join(home, ".siltpoke", "inner.txt"), OURS(home));

    expect(restoreUserStatusLine(env)).toBe("removed");
    expect("statusLine" in readSettings()).toBe(false);
  });

  test("someone else's statusLine → the file is not rewritten at all", () => {
    const raw = writeSettings({ statusLine: { type: "command", command: "echo THEIRS" } });
    writeFileSync(join(home, ".siltpoke", "inner.txt"), "echo ORIGINAL");

    expect(restoreUserStatusLine(env)).toBe("not-ours");
    expect(readFileSync(settingsPath, "utf8")).toBe(raw);
  });

  test("no statusLine at all → not ours, file untouched", () => {
    const raw = writeSettings({ theme: "dark" });
    expect(restoreUserStatusLine(env)).toBe("not-ours");
    expect(readFileSync(settingsPath, "utf8")).toBe(raw);
  });

  test("unparseable settings.json → left byte-for-byte as it was", () => {
    const raw = '{ "statusLine": { "command": "sh x/.siltpoke/bin/statusline.sh" ';
    writeFileSync(settingsPath, raw);

    expect(restoreUserStatusLine(env)).toBe("unreadable");
    expect(readFileSync(settingsPath, "utf8")).toBe(raw);
  });

  test("no settings.json → nothing is created", () => {
    expect(restoreUserStatusLine(env)).toBe("no-settings");
    expect(() => readFileSync(settingsPath, "utf8")).toThrow();
  });

  test("running it twice is safe: the second run finds nothing of ours", () => {
    writeSettings({ statusLine: { type: "command", command: OURS(home) } });
    writeFileSync(join(home, ".siltpoke", "inner.txt"), "echo ORIGINAL");

    expect(restoreUserStatusLine(env)).toBe("restored");
    const afterFirst = readFileSync(settingsPath, "utf8");
    expect(restoreUserStatusLine(env)).toBe("not-ours");
    expect(readFileSync(settingsPath, "utf8")).toBe(afterFirst);
  });
});
