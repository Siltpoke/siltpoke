// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
// The last line of install must say what THIS run actually wired, taken from the
// install result — not from what the user picked, and not a fixed sentence.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runBootstrap } from "../../src/cli/bootstrap";
import { runInstall } from "../../src/cli/install";
import type { EditorPresence } from "../../src/installer/editor-detect";
import { t } from "../../src/installer/i18n";
import type { PlcExec } from "../../src/installer/plc-install";
import type { Exec } from "../../src/installer/prereq";

const noopPlcExec: PlcExec = () => ({ status: 0, stdout: "", stderr: "" });
const edBare: EditorPresence = { vscode: false, cursor: false, claudeExtInVscode: false, claudeExtInCursor: false };
const edPlugin: EditorPresence = { vscode: true, cursor: false, claudeExtInVscode: true, claudeExtInCursor: false };
const allPresent: Exec = () => ({ status: 0, stdout: "" });

let home: string;
let claudeHome: string;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "u10-"));
  claudeHome = join(home, ".claude");
  mkdirSync(claudeHome, { recursive: true });
  writeFileSync(join(claudeHome, "settings.json"), "{}");
});
afterEach(() => rmSync(home, { recursive: true, force: true }));

async function finalText(
  wired: unknown,
  opts: { locale?: "en" | "zh"; editors?: EditorPresence } = {},
): Promise<string> {
  const out: string[] = [];
  let i = 0;
  const answers = [opts.locale ?? "en", "n"];
  await runBootstrap({
    exec: allPresent,
    io: { readLine: async () => answers[i++] ?? "", write: (s) => out.push(s) },
    claudeHome,
    env: { HOME: home },
    platform: "darwin",
    detectEditorsFn: () => opts.editors ?? edBare,
    runInstallFn: async () => ({ status: "installed", wired }),
    plcExecFn: noopPlcExec,
  });
  const lines = out.join("").split("\n");
  return lines.filter((l) => /^[✓!] (Done —|siltpoke)|^✓ 装好了/.test(l)).join("\n");
}

describe("U10: the install ending names what was wired", () => {
  test("only codex wired → names Codex, does not claim Claude Code", async () => {
    const text = await finalText(["codex"]);
    expect(text).toContain("Codex");
    expect(text).not.toContain("Claude Code");
    expect(text).not.toContain("`claude`");
  });

  test("claude-code wired → names Claude Code and keeps the `claude` hint", async () => {
    const text = await finalText(["claude-code"]);
    expect(text).toContain("Claude Code");
    expect(text).toContain("`claude`");
  });

  test("two agents wired → both named", async () => {
    const text = await finalText(["claude-code", "codex"]);
    expect(text).toContain("Claude Code");
    expect(text).toContain("Codex");
  });

  test("nothing wired → no 'Done — … wired' line, says nothing was connected", async () => {
    const text = await finalText([]);
    expect(text).not.toContain("Done —");
    expect(text).not.toContain("wired into");
    expect(t("done.none", "en")).toContain("nothing was connected");
    expect(text).toBe(`! ${t("done.none", "en")}`);
  });

  test("an install result with no `wired` field is treated as nothing wired, not as success", async () => {
    const text = await finalText(undefined);
    expect(text).not.toContain("Done —");
  });

  test("zh: names the agent and never the other one", async () => {
    const text = await finalText(["codex"], { locale: "zh" });
    expect(text).toContain("Codex");
    expect(text).not.toContain("Claude Code");
    expect(text).toContain("装好了");
    const none = await finalText([], { locale: "zh" });
    expect(none).not.toContain("装好了");
    expect(none).toContain("没有");
  });

  test("editor install with Claude wired still gets the editor hint", async () => {
    const text = await finalText(["claude-code"], { editors: edPlugin });
    expect(text).toContain("Claude Code");
    expect(text).toContain(t("done.hintEditor", "en"));
    expect(text).not.toContain("`claude`");
  });

  test("editor detected (branch B) but only codex wired → the editor-extension offer does not appear", async () => {
    const edNoPlugin: EditorPresence = { vscode: true, cursor: false, claudeExtInVscode: false, claudeExtInCursor: false };
    const out: string[] = [];
    const calls: string[] = [];
    await runBootstrap({
      exec: (cmd, args) => {
        calls.push([cmd, ...args].join(" "));
        return { status: 0, stdout: "" };
      },
      io: { readLine: async () => "y", write: (s) => out.push(s) },
      claudeHome,
      env: { HOME: home },
      yes: true,
      platform: "darwin",
      detectEditorsFn: () => edNoPlugin,
      runInstallFn: async () => ({ wired: ["codex"] }),
      plcExecFn: noopPlcExec,
    });
    expect(out.join("")).not.toContain(t("editor.pluginOffer", "en"));
    expect(calls.some((c) => c.includes("extension/anthropic.claude-code"))).toBe(false);
    expect(out.join("")).toContain("Codex");
  });
});

describe("U10: a host that fails is not reported as wired", () => {
  test("one host throws mid-way → onWired skips it, the other is still reported", async () => {
    const { wireSecondaryHosts } = await import("../../src/installer/secondary-hosts");
    const bad = join(home, ".codebuddy", "settings.json");
    mkdirSync(join(home, ".codebuddy"), { recursive: true });
    writeFileSync(bad, '{\n  // a comment\n  "model": "x"\n}\n');
    const commands = join(home, "repo", ".claude-plugin", "commands");
    mkdirSync(commands, { recursive: true });
    const seen: string[] = [];
    const count = await wireSecondaryHosts({
      env: { HOME: home, SILTPOKE_HOME: join(home, ".siltpoke") },
      home,
      repoRoot: "/repo",
      selectedAgents: ["codebuddy", "qodercli"],
      pluginCommandsDir: commands,
      platform: process.platform,
      io: { readLine: async () => "", write: () => {} },
      onWired: (id) => seen.push(id),
    });
    expect(count).toBe(1);
    expect(seen).toEqual(["qodercli"]);
    expect(seen).not.toContain("codebuddy");
  });
});

describe("U10: runInstall reports which agents it wired this run", () => {
  const baseEnv = () => ({
    ...process.env,
    HOME: home,
    CLAUDE_HOME: claudeHome,
    SILTPOKE_HOME: join(home, ".siltpoke"),
    CI: "true",
  });
  const quiet = { readLine: async () => "n", write: () => {} };

  test("claude-code selected, settings.json present → wired is ['claude-code']", async () => {
    const res = await runInstall({
      io: quiet,
      noninteractive: true,
      presetAgents: ["claude-code"],
      env: baseEnv(),
      platform: "darwin",
      setupOllamaFn: async () => ({ enabled: false }),
    });
    expect(res.status).toBe("installed");
    expect(res.wired).toEqual(["claude-code"]);
  });

  test("claude-code selected but no ~/.claude/settings.json → wired is empty", async () => {
    rmSync(join(claudeHome, "settings.json"));
    const res = await runInstall({
      io: quiet,
      noninteractive: true,
      presetAgents: ["claude-code"],
      env: baseEnv(),
      platform: "darwin",
      setupOllamaFn: async () => ({ enabled: false }),
    });
    expect(res.status).toBe("no_settings");
    expect(res.wired).toEqual([]);
  });

  test("only codex selected → wired is ['codex'], not claude-code", async () => {
    const repoRoot = join(home, "repo");
    mkdirSync(join(repoRoot, ".claude-plugin", "commands"), { recursive: true });
    const res = await runInstall({
      io: quiet,
      noninteractive: true,
      presetAgents: ["codex"],
      repoRoot,
      env: { ...baseEnv(), CODEX_HOME: join(home, ".codex") },
      platform: "darwin",
      setupOllamaFn: async () => ({ enabled: false }),
    });
    expect(res.wired).toEqual(["codex"]);
  });

  test("user declines the install question → status user_aborted, wired is empty", async () => {
    const res = await runInstall({
      io: { readLine: async () => "n", write: () => {} },
      noninteractive: false,
      presetAgents: ["claude-code"],
      env: baseEnv(),
      platform: "darwin",
      setupOllamaFn: async () => ({ enabled: false }),
    });
    expect(res.status).toBe("user_aborted");
    expect(res.wired).toEqual([]);
  });

  test("re-run over an existing install still reports claude-code as wired", async () => {
    const opts = {
      io: quiet,
      noninteractive: true,
      presetAgents: ["claude-code" as const],
      env: baseEnv(),
      platform: "darwin" as const,
      setupOllamaFn: async () => ({ enabled: false }),
    };
    await runInstall(opts);
    const again = await runInstall(opts);
    expect(again.status).toBe("already_installed");
    expect(again.wired).toEqual(["claude-code"]);
  });
});
