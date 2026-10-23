// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
// Copyright (c) 2026 Jiaqi Duan
// [61] PR 2, plan P1.3 (spec §2.2, §5): the outside tools siltpoke installs —
// the project-lifecycle plugin, Claude Code, codex — are recorded as
// outside-tool entries. PLC's `byUs` needs a `claude plugin list` probe BEFORE
// acting (an already-installed plugin is the user's); Claude Code and codex are
// only ever installed when absent, so they are ours.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { selectAndInstallAgents } from "../../src/installer/agent-menu";
import { installClaude, installCodex } from "../../src/installer/agent-offer";
import { installPlc, type PlcExec } from "../../src/installer/plc-install";
import type { Exec } from "../../src/installer/prereq";
import { readReceipt } from "../../src/installer/receipt";

let home: string;
let env: NodeJS.ProcessEnv;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "siltpoke-tools-receipt-"));
  env = { HOME: home };
});
afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

const io = { readLine: async () => "", write: () => {} };
const entry = (id: string) => readReceipt(env)?.entries.find((e) => e.id === id);

/** `list` is what `claude plugin list` prints (status `listStatus`); every other call exits `status`. */
function plcExec(opts: { list?: string; listStatus?: number; status?: number }): { exec: PlcExec; calls: string[][] } {
  const calls: string[][] = [];
  const exec: PlcExec = (_cmd, args) => {
    calls.push(args);
    if (args[0] === "plugin" && args[1] === "list") {
      return { status: opts.listStatus ?? 0, stdout: opts.list ?? "", stderr: "" };
    }
    return { status: opts.status ?? 0, stdout: "", stderr: "" };
  };
  return { exec, calls };
}

describe("installPlc → receipt", () => {
  test("plugin not installed before → ours, done", () => {
    const { exec } = plcExec({ list: "some-other-plugin@market\n" });
    installPlc({ exec, io, claudePresent: true, receiptEnv: env });
    expect(entry("tool:plc")).toMatchObject({
      kind: "outside-tool",
      target: "project-lifecycle@project-life-cycle",
      byUs: true,
      state: "done",
      level: "purge",
    });
  });

  test("plugin already installed before → recorded as not ours, done, and NO install command runs", () => {
    const { exec, calls } = plcExec({ list: "project-lifecycle@project-life-cycle  enabled\n" });
    installPlc({ exec, io, claudePresent: true, receiptEnv: env });
    expect(entry("tool:plc")).toMatchObject({ byUs: false, state: "done" });
    expect(calls.filter((a) => !(a[0] === "plugin" && a[1] === "list"))).toEqual([]);
  });

  test("a probe result handed in is used as is: no second `plugin list`", () => {
    const { exec, calls } = plcExec({});
    installPlc({ exec, io, claudePresent: true, receiptEnv: env, probe: "absent" });
    expect(calls.filter((a) => a[1] === "list")).toEqual([]);
    expect(entry("tool:plc")).toMatchObject({ byUs: true });
    const second = plcExec({});
    installPlc({ exec: second.exec, io, claudePresent: true, receiptEnv: { HOME: join(home, "x") }, probe: "present" });
    expect(second.calls).toEqual([]);
  });

  test("the list probe itself fails → ownership unknown, so NOT ours", () => {
    const { exec } = plcExec({ listStatus: 1 });
    installPlc({ exec, io, claudePresent: true, receiptEnv: env });
    expect(entry("tool:plc")).toMatchObject({ byUs: false });
  });

  test("the probe runs before the marketplace add (ownership is observed before acting)", () => {
    const { exec, calls } = plcExec({});
    installPlc({ exec, io, claudePresent: true, receiptEnv: env });
    const kinds = calls.map((a) => a.slice(0, 2).join(" "));
    expect(kinds.indexOf("plugin list")).toBeLessThan(kinds.indexOf("plugin marketplace"));
  });

  test("install fails → the entry stays pending, never done", () => {
    const { exec } = plcExec({ status: 1 });
    installPlc({ exec, io, claudePresent: true, receiptEnv: env });
    expect(entry("tool:plc")).toMatchObject({ byUs: true, state: "pending" });
  });

  test("marketplace add succeeds but the plugin install fails → still pending", () => {
    const exec: PlcExec = (_cmd, args) =>
      args[0] === "plugin" && args[1] === "install"
        ? { status: 1, stdout: "", stderr: "boom" }
        : { status: 0, stdout: "", stderr: "" };
    installPlc({ exec, io, claudePresent: true, receiptEnv: env });
    expect(entry("tool:plc")).toMatchObject({ state: "pending" });
  });

  test("Claude Code absent → nothing probed, nothing recorded", () => {
    const { exec, calls } = plcExec({});
    installPlc({ exec, io, claudePresent: false, receiptEnv: env });
    expect(calls).toEqual([]);
    expect(readReceipt(env)).toBeNull();
  });
});

describe("installClaude → receipt", () => {
  test("installer exits 0 → tool:claude-code ours, done", () => {
    const exec: Exec = () => ({ status: 0, stdout: "" });
    installClaude(exec, io, env);
    expect(entry("tool:claude-code")).toMatchObject({ kind: "outside-tool", target: "claude-code", byUs: true, state: "done", level: "purge" });
  });

  test("installer fails → pending", () => {
    const exec: Exec = () => ({ status: 1, stdout: "" });
    installClaude(exec, io, env);
    expect(entry("tool:claude-code")).toMatchObject({ byUs: true, state: "pending" });
  });
});

describe("installCodex → receipt", () => {
  const withNpm: Exec = () => ({ status: 0, stdout: "" });

  test("npm install exits 0 → tool:codex ours, done", () => {
    installCodex(withNpm, io, "darwin", env);
    expect(entry("tool:codex")).toMatchObject({ kind: "outside-tool", target: "codex", byUs: true, state: "done", level: "purge" });
    expect(entry("tool:claude-code")).toBeUndefined(); // installing codex says nothing about Claude Code
  });

  test("npm install fails → pending", () => {
    const exec: Exec = (cmd) => (cmd === "npm" ? { status: 1, stdout: "" } : { status: 0, stdout: "" });
    installCodex(exec, io, "darwin", env);
    expect(entry("tool:codex")).toMatchObject({ state: "pending" });
  });

  test("no npm → nothing was run, nothing recorded", () => {
    const exec: Exec = (cmd) => (cmd === "node" || cmd === "command" ? { status: 1, stdout: "" } : { status: 0, stdout: "" });
    installCodex(exec, io, "darwin", env);
    expect(readReceipt(env)).toBeNull();
  });
});

describe("the Claude-Code-as-host gate → receipt", () => {
  test("Claude Code not selected, absent, user accepts the host gate → it is installed and recorded", async () => {
    const answers = ["2", "y"]; // pick codex only, then accept "install Claude Code now?"
    let i = 0;
    const gateIo = { readLine: async () => answers[i++] ?? "", write: () => {} };
    const exec: Exec = () => ({ status: 0, stdout: "" });
    const presence = { claude: false, codex: true, codebuddy: false, qodercli: false, antigravity: false, antigravityApp: false };
    await selectAndInstallAgents({ presence, io: gateIo, exec, platform: "darwin", locale: "en", env });
    expect(entry("tool:claude-code")).toMatchObject({ byUs: true, state: "done" });
  });
});
