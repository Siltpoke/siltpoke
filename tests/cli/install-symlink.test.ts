// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, lstatSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { symlinkCommands } from "../../src/cli/install";

let root: string, pluginDir: string, claudeDir: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "sym-"));
  pluginDir = join(root, "plugin-cmds");
  claudeDir = join(root, "claude-cmds");
  mkdirSync(pluginDir, { recursive: true });
  writeFileSync(join(pluginDir, "siltpoke.md"), "# cmd");
  writeFileSync(join(pluginDir, "ignore.txt"), "no");
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe("symlinkCommands", () => {
  test("win32: copies .md files as real files, not symlinks", async () => {
    const linked = await symlinkCommands(pluginDir, claudeDir, "win32");
    expect(linked).toEqual(["siltpoke.md"]);
    const st = lstatSync(join(claudeDir, "siltpoke.md"));
    expect(st.isSymbolicLink()).toBe(false);
    expect(st.isFile()).toBe(true);
  });

  test("darwin: creates a symlink", async () => {
    await symlinkCommands(pluginDir, claudeDir, "darwin");
    const st = lstatSync(join(claudeDir, "siltpoke.md"));
    expect(st.isSymbolicLink()).toBe(true);
  });

  test("win32: re-run overwrites idempotently", async () => {
    await symlinkCommands(pluginDir, claudeDir, "win32");
    const linked = await symlinkCommands(pluginDir, claudeDir, "win32");
    expect(linked).toEqual(["siltpoke.md"]);
  });
});
