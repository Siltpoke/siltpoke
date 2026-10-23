// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
// Copyright (c) 2026 Jiaqi Duan
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { claudeUninstallCommands } from "../../src/installer/plugin-hosts";

// Defect [82]: Claude Code removes a plugin only from the scope it is told, and
// a project or local install only from inside that project's folder. Measured
// 2026-10-08 on Claude Code 2.1.295's own `claude plugin uninstall` with a
// stand-in plugin (the record shapes below are what it wrote):
//   local / project, no --scope       → "is not installed in user scope"
//   --scope local, in another folder  → "is not installed in local scope"
//   --scope local, in the project     → uninstalled

const PLAIN = "claude plugin uninstall siltpoke";
const IN_PROJECT = "In the project folder you installed it for";

let home: string;
let env: NodeJS.ProcessEnv;

const write = (text: string) => writeFileSync(join(home, ".claude", "plugins", "installed_plugins.json"), text);
const record = (...entries: Array<Record<string, unknown>>) =>
  write(JSON.stringify({ version: 2, plugins: { "siltpoke@siltpoke": entries } }));
/** What a Mac or Linux user is told; the platform is passed so the answer does not depend on where the tests run. */
const posix = () => claudeUninstallCommands(env, "darwin");
const windows = () => claudeUninstallCommands(env, "win32");

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "siltpoke-uninstall-commands-"));
  env = { HOME: home };
  mkdirSync(join(home, ".claude", "plugins"), { recursive: true });
});
afterEach(() => { rmSync(home, { recursive: true, force: true }); });

describe("the lines that remove the plugin from Claude Code (defect [82])", () => {
  test("a user-scope install: the plain command", () => {
    record({ scope: "user", installPath: "/x" });
    expect(posix()).toEqual([PLAIN]);
    expect(windows()).toEqual([PLAIN]);
  });

  test("a local install: one line that goes to the project, names the scope, and leaves the shell where it was", () => {
    record({ scope: "local", installPath: "/x", projectPath: "/Users/me/work/proj" });
    expect(posix()).toEqual([`(cd "/Users/me/work/proj" && ${PLAIN} --scope local)`]);
  });

  test("a project install: the same, with its own scope", () => {
    record({ scope: "project", installPath: "/x", projectPath: "/Users/me/work/proj" });
    expect(posix()).toEqual([`(cd "/Users/me/work/proj" && ${PLAIN} --scope project)`]);
  });

  test("a folder name with a space stays one argument", () => {
    record({ scope: "local", projectPath: "/Users/me/my work/proj" });
    expect(posix()).toEqual([`(cd "/Users/me/my work/proj" && ${PLAIN} --scope local)`]);
  });

  test("with no platform given, it answers for the machine it runs on", () => {
    record({ scope: "local", projectPath: "/p" });
    expect(claudeUninstallCommands(env)).toEqual(claudeUninstallCommands(env, process.platform));
  });

  test("installed for the user AND for two projects: each one, in the record's order", () => {
    record(
      { scope: "local", projectPath: "/a" },
      { scope: "user" },
      { scope: "project", projectPath: "/b" },
    );
    expect(posix()).toEqual([
      `(cd "/a" && ${PLAIN} --scope local)`,
      PLAIN,
      `(cd "/b" && ${PLAIN} --scope project)`,
    ]);
  });

  test("the same install recorded twice is given once", () => {
    record({ scope: "user" }, { scope: "user" }, { scope: "local", projectPath: "/a" }, { scope: "local", projectPath: "/a" });
    expect(posix()).toEqual([PLAIN, `(cd "/a" && ${PLAIN} --scope local)`]);
    expect(windows()).toEqual([PLAIN, 'cd "/a"', `${PLAIN} --scope local`]);
  });

  test("another marketplace's siltpoke counts; another plugin's project install does not", () => {
    write(JSON.stringify({
      version: 2,
      plugins: {
        "other@siltpoke": [{ scope: "local", projectPath: "/not-ours" }],
        "siltpoke@fork": [{ scope: "local", projectPath: "/ours" }],
      },
    }));
    expect(posix()).toEqual([`(cd "/ours" && ${PLAIN} --scope local)`]);
  });

  describe("Windows: two lines (PowerShell 5 has no &&), and a backslash is only a separator there", () => {
    test("a Windows path", () => {
      record({ scope: "local", projectPath: "C:\\Users\\me\\my proj" });
      expect(windows()).toEqual(['cd "C:\\Users\\me\\my proj"', `${PLAIN} --scope local`]);
    });

    test("two projects with the same scope keep their own cd line", () => {
      record({ scope: "local", projectPath: "C:\\a" }, { scope: "local", projectPath: "C:\\b" });
      expect(windows()).toEqual(['cd "C:\\a"', `${PLAIN} --scope local`, 'cd "C:\\b"', `${PLAIN} --scope local`]);
    });

    for (const path of ['C:\\say "hi"', "C:\\$env", "C:\\`x", "C:\\%TEMP%", "C:\\a\rb"]) {
      test(`not put in a command: ${JSON.stringify(path)}`, () => {
        record({ scope: "local", projectPath: path });
        expect(windows()).toEqual([`${IN_PROJECT} (${JSON.stringify(path)}):`, `${PLAIN} --scope local`]);
      });
    }

    test("an exclamation mark is fine there", () => {
      record({ scope: "local", projectPath: "C:\\wow!" });
      expect(windows()).toEqual(['cd "C:\\wow!"', `${PLAIN} --scope local`]);
    });
  });

  describe("a path the shell would change inside double quotes is named in words, never put in a command", () => {
    for (const path of ['/a/say "hi"', "/a/$HOME", "/a/`id`", "/a/back\\slash", "/a/trailing\\", "/a/!!", "/a/new\nline", "/a/cr\rx", "/a/esc\u001b[2J", "/a/del\u007f"]) {
      test(JSON.stringify(path), () => {
        record({ scope: "local", projectPath: path });
        const lines = posix();
        // The path is shown escaped, on a line that is not a command; the command line is plain.
        expect(lines).toEqual([`${IN_PROJECT} (${JSON.stringify(path).replaceAll("\x7f", "\\u007f")}):`, `${PLAIN} --scope local`]);
        expect(lines.join("\n")).not.toContain("cd ");
        // biome-ignore lint/suspicious/noControlCharactersInRegex: asserting none is printed
        expect(lines.join("")).not.toMatch(/[\x00-\x1f\x7f]/);
      });
    }

    test("control: the characters that are safe inside double quotes stay in the command", () => {
      const path = "/a/it's (1) [x] *?~;&|<>#";
      record({ scope: "local", projectPath: path });
      expect(posix()).toEqual([`(cd "${path}" && ${PLAIN} --scope local)`]);
    });
  });

  describe("a project-scoped record with no usable folder: where to run it, then the command on its own line", () => {
    for (const projectPath of [undefined, "", 7, null]) {
      test(JSON.stringify(projectPath) ?? "absent", () => {
        record({ scope: "project", projectPath });
        expect(posix()).toEqual([`${IN_PROJECT}:`, `${PLAIN} --scope project`]);
      });
    }
  });

  test("no line mixes a command with words (a pasted line must run as it is)", () => {
    record({ scope: "local" }, { scope: "project", projectPath: "/a/$x" }, { scope: "local", projectPath: "/ok" }, { scope: "user" });
    for (const line of posix()) {
      const isCommand = line.includes(PLAIN);
      if (isCommand) expect(line).toMatch(/^(\(cd "[^"]+" && )?claude plugin uninstall siltpoke( --scope (local|project))?\)?$/);
      else expect(line).toEndWith(":");
    }
  });

  describe("when the record says nothing usable, the plain command is still given", () => {
    const cases: Array<[string, string | null]> = [
      ["no file", null],
      ["not JSON", "{ nope"],
      ["no plugins key", JSON.stringify({ version: 2 })],
      ["plugins is not an object", JSON.stringify({ plugins: [] })],
      ["siltpoke is not listed", JSON.stringify({ plugins: { "other@x": [{ scope: "local", projectPath: "/p" }] } })],
      ["the entry list is not a list", JSON.stringify({ plugins: { "siltpoke@siltpoke": { scope: "local" } } })],
      ["the entry list is empty", JSON.stringify({ plugins: { "siltpoke@siltpoke": [] } })],
      ["an entry with no scope (the oldest record shape)", JSON.stringify({ plugins: { "siltpoke@siltpoke": [{}] } })],
      ["a scope this version does not know", JSON.stringify({ plugins: { "siltpoke@siltpoke": [{ scope: "managed", projectPath: "/p" }] } })],
      ["entries that are not objects", JSON.stringify({ plugins: { "siltpoke@siltpoke": [null, 3, "x"] } })],
    ];
    for (const [name, text] of cases) {
      test(name, () => {
        if (text !== null) write(text);
        expect(posix()).toEqual([PLAIN]);
      });
    }
  });
});
