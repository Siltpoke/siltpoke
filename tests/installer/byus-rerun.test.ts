// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
// Copyright (c) 2026 Jiaqi Duan
// [61] review I1: the first observation of "was it there before us?" wins. A
// re-run finds PLC / the model / the command copies present BECAUSE the first run
// put them there; that must never turn "ours" into "the user's".
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { symlinkCommands } from "../../src/cli/install";
import { installPlc, type PlcExec } from "../../src/installer/plc-install";
import { readReceipt } from "../../src/installer/receipt";
import { setupOllamaInteractive } from "../../src/installer/setup-ollama";

let root: string;
let env: NodeJS.ProcessEnv;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "siltpoke-byus-"));
  env = { HOME: root };
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});
const io = { readLine: async () => "", write: () => {} };
const byUs = (id: string) => readReceipt(env)?.entries.find((e) => e.id === id)?.byUs;

describe("re-run keeps byUs", () => {
  test("PLC: first run installs it, second run lists it → still ours", () => {
    let listed = "";
    const exec: PlcExec = (_c, args) => ({ status: 0, stdout: args[1] === "list" ? listed : "", stderr: "" });
    installPlc({ exec, io, claudePresent: true, receiptEnv: env });
    listed = "project-lifecycle@project-life-cycle enabled";
    installPlc({ exec, io, claudePresent: true, receiptEnv: env });
    expect(byUs("tool:plc")).toBe(true);
  });

  test("Ollama model: first run pulls it, second run finds it → still ours", async () => {
    const base = { checkInstalled: async () => true, pull: async () => {}, validate: async () => true };
    await setupOllamaInteractive({ io: { write: () => {} }, env, deps: { ...base, hasModel: async () => false } });
    await setupOllamaInteractive({ io: { write: () => {} }, env, deps: { ...base, hasModel: async () => true } });
    expect(byUs("tool:ollama-model")).toBe(true);
  });

  test("win32 command copy: an edited copy on the second run does not turn our file into the user's", async () => {
    const plugin = join(root, "plugin");
    const dest = join(root, "cmds");
    mkdirSync(plugin);
    writeFileSync(join(plugin, "a.md"), "v1");
    await symlinkCommands(plugin, dest, "win32", env);
    writeFileSync(join(plugin, "a.md"), "v2"); // plugin updated; the copy on disk is the old bytes
    await symlinkCommands(plugin, dest, "win32", env);
    expect(byUs(`file:${join(dest, "a.md")}`)).toBe(true);
  });
});
