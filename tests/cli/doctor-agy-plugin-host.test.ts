// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
// Copyright (c) 2026 Jiaqi Duan
/**
 * Audit defect `[67]`: an agy install made ONLY through the agy plugin
 * (`<config>/plugins/siltpoke/hooks.json`, no global hooks.json) was reported
 * by doctor as Claude Code, so the Claude-only red rows and `/siltpoke:siltpoke-setup`
 * advice (which defect `[16]` removed for the global-hooks.json case) came back.
 *
 * All paths are pinned into a temp dir; nothing here reads the real home.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { detectDoctorHost, formatChecklist, hostWiringPath, runAllChecks } from "../../src/cli/doctor";
import { aHost } from "../../src/cli/doctor-agy-plugin-host";

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "sp-doctor-agyplugin-"));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

const withStop = { hooks: { Stop: [{ type: "command", command: "sh ./hooks/agy-stop.sh", timeout: 30 }] } };

/** agy plugin install: NO global hooks.json (pinned path, never created), only the plugin's. */
function pluginOnly(hooksJson: unknown) {
  const configDir = join(root, "gemini", "config");
  mkdirSync(join(configDir, "plugins", "siltpoke"), { recursive: true });
  writeFileSync(join(configDir, "plugins", "siltpoke", "hooks.json"), JSON.stringify(hooksJson));
  const siltpokeHome = join(root, ".siltpoke");
  mkdirSync(siltpokeHome, { recursive: true });
  return {
    claudeHome: join(root, "no-claude-home"),
    siltpokeHome,
    agyHooksJsonPath: join(configDir, "hooks.json"),
    codexConfigPath: join(root, "no-codex", "config.toml"),
    autostartPath: join(root, "no-autostart", "siltpoke.plist"),
  };
}

describe("detectDoctorHost with a plugin-only agy install", () => {
  test("plugin hooks.json with an agy-stop.sh Stop entry is antigravity", () => {
    expect(detectDoctorHost(pluginOnly(withStop))).toBe("antigravity");
  });

  test("a plugin dir WITHOUT a siltpoke Stop entry is not antigravity", () => {
    for (const bad of [
      { hooks: {} },
      { hooks: { Stop: [{ type: "command", command: "echo hi" }] } },
      { hooks: { Stop: [{ type: "prompt", command: "agy-stop.sh" }] } },
      { hooks: { Stop: "agy-stop.sh" } },
    ]) {
      expect(detectDoctorHost(pluginOnly(bad))).toBe("claude-code");
    }
  });

  test("a corrupt plugin hooks.json is not antigravity", () => {
    const opts = pluginOnly(withStop);
    writeFileSync(join(root, "gemini", "config", "plugins", "siltpoke", "hooks.json"), "{nope");
    expect(detectDoctorHost(opts)).toBe("claude-code");
  });

  test("a present ~/.claude still wins (no per-host hint reaches doctor)", () => {
    const opts = pluginOnly(withStop);
    mkdirSync(opts.claudeHome, { recursive: true });
    expect(detectDoctorHost(opts)).toBe("claude-code");
  });
});

describe("which file the info rows name as the agy wiring", () => {
  test("plugin-only install: the plugin's hooks.json, not a global file that does not exist", () => {
    const opts = pluginOnly(withStop);
    const pluginFile = join(root, "gemini", "config", "plugins", "siltpoke", "hooks.json");
    expect(hostWiringPath("antigravity", opts)).toBe(pluginFile);
    const stopRow = runAllChecks(opts).find((r) => r.name.includes("Stop hook registered"));
    expect(stopRow?.detail).toContain(pluginFile);
    expect(stopRow?.detail).not.toContain(opts.agyHooksJsonPath);
  });

  test("a global hooks.json WITHOUT the siltpoke entry does not beat a plugin that has it", () => {
    const opts = pluginOnly(withStop);
    writeFileSync(opts.agyHooksJsonPath, "{}");
    expect(hostWiringPath("antigravity", opts)).toBe(
      join(root, "gemini", "config", "plugins", "siltpoke", "hooks.json"),
    );
  });

  test("a global hooks.json WITH the siltpoke entry stays the named path", () => {
    const opts = pluginOnly(withStop);
    writeFileSync(
      opts.agyHooksJsonPath,
      JSON.stringify({ "siltpoke-review": { Stop: [{ type: "command", command: "bun /x/agy-stop.ts" }] } }),
    );
    expect(hostWiringPath("antigravity", opts)).toBe(opts.agyHooksJsonPath);
  });

  test("global without the entry and no plugin entry: falls back to the global path", () => {
    const opts = pluginOnly({ hooks: {} });
    writeFileSync(opts.agyHooksJsonPath, "{}");
    expect(hostWiringPath("antigravity", opts)).toBe(opts.agyHooksJsonPath);
  });

  test("plugin dir without a siltpoke Stop entry: the global path", () => {
    const opts = pluginOnly({ hooks: {} });
    expect(hostWiringPath("antigravity", opts)).toBe(opts.agyHooksJsonPath);
  });
});

describe("the indefinite article before a host name", () => {
  test("an before a vowel, a otherwise", () => {
    expect(aHost("antigravity")).toBe("an antigravity");
    expect(aHost("codex")).toBe("a codex");
    expect(aHost("claude-code")).toBe("a claude-code");
  });

  test("no rendered row says 'a antigravity'", () => {
    const rendered = formatChecklist(runAllChecks(pluginOnly(withStop)));
    expect(rendered).not.toContain("a antigravity");
    expect(rendered).toContain("an antigravity install");
  });
});

describe("doctor output for a plugin-only agy install", () => {
  test("Claude-only rows are informational, and no /siltpoke- command is offered", () => {
    const results = runAllChecks(pluginOnly(withStop));
    expect(results.find((r) => r.name.includes("settings.json valid"))?.status).toBe("info");
    expect(results.find((r) => r.name.includes("Stop hook registered"))?.status).toBe("info");
    expect(formatChecklist(results)).not.toContain("/siltpoke-");
  });
});
