// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
// Copyright (c) 2026 Jiaqi Duan
//
// Defect [89]: a doctor started from the copy of Siltpoke that Qoder or
// CodeBuddy installed (`~/.qoder/plugins/cache/…`, `~/.codebuddy/plugins/cache/…`)
// judged itself as a Claude Code install — with or without a ~/.claude on the
// machine — and printed
//   ✗ ~/.claude/settings.json valid — … does not exist — Run `/siltpoke:siltpoke-setup` to set Siltpoke up
//   ✗ Stop hook registered — ~/.claude/settings.json not readable
//   ✗ slash command symlinks intact (0/12) — … Reinstall: /plugin install siltpoke.
// [81] taught doctor to read where the running copy sits for codex and
// Antigravity; these are the two Claude Code forks it left out.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { cpSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { detectDoctorHost, hostWiringPath, setupAdviceFor } from "../../src/cli/doctor";
import { hostOfRunningCopy } from "../../src/cli/doctor-agy-plugin-host";

const REPO = process.cwd();
const FORKS = ["qoder", "codebuddy"] as const;

let home: string;
/** The seams that keep every probe inside the temp home. */
let pins: {
  claudeHome: string;
  agyHooksJsonPath: string;
  codexConfigPath: string;
  qoderHome: string;
  codebuddyHome: string;
};
/** Where each fork keeps its plugin copy (the layout measured 2026-10-13, audit §104). */
const copyOf = (fork: (typeof FORKS)[number]) =>
  join(fork === "qoder" ? pins.qoderHome : pins.codebuddyHome, "plugins", "cache", "siltpoke", "siltpoke", "1.3.0");

beforeEach(() => {
  home = realpathSync(mkdtempSync(join(tmpdir(), "siltpoke-running-fork-")));
  mkdirSync(join(home, ".claude"));
  pins = {
    claudeHome: join(home, ".claude"),
    agyHooksJsonPath: join(home, ".gemini", "config", "hooks.json"),
    codexConfigPath: join(home, ".codex", "config.toml"),
    qoderHome: join(home, ".qoder"),
    codebuddyHome: join(home, ".codebuddy"),
  };
  for (const fork of FORKS) mkdirSync(join(copyOf(fork), "dist"), { recursive: true });
});
afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

describe("which host's copy is this doctor running from — the two Claude Code forks", () => {
  for (const fork of FORKS) {
    test(`${fork}'s plugin cache: ${fork}, on a machine with ~/.claude`, () => {
      expect(hostOfRunningCopy(pins, copyOf(fork))).toBe(fork);
      expect(detectDoctorHost({ ...pins, repoRoot: copyOf(fork) })).toBe(fork);
    });

    test(`${fork}'s plugin cache: ${fork}, on a machine with no ~/.claude`, () => {
      rmSync(pins.claudeHome, { recursive: true });
      expect(detectDoctorHost({ ...pins, repoRoot: copyOf(fork) })).toBe(fork);
    });

    test(`a ${fork} home that also holds Claude Code's home proves nothing`, () => {
      const checkout = join(home, "work", "checkout");
      mkdirSync(checkout, { recursive: true });
      const forkIsHome = { ...pins, [`${fork}Home`]: home };
      expect(hostOfRunningCopy(forkIsHome, checkout)).toBeNull();
      expect(detectDoctorHost({ ...forkIsHome, repoRoot: checkout })).toBe("claude-code");
      // Control: the same layout with no Claude Code home in it is the fork's.
      rmSync(pins.claudeHome, { recursive: true });
      expect(hostOfRunningCopy(forkIsHome, checkout)).toBe(fork);
    });
  }

  test("a folder whose name only starts like the fork's home is not inside it", () => {
    mkdirSync(join(home, ".qoder-backup", "siltpoke"), { recursive: true });
    expect(hostOfRunningCopy(pins, join(home, ".qoder-backup", "siltpoke"))).toBeNull();
  });

  test("control: Claude Code's own plugin cache is still Claude Code", () => {
    const claudeCopy = join(pins.claudeHome, "plugins", "cache", "siltpoke", "siltpoke", "1.3.0");
    mkdirSync(claudeCopy, { recursive: true });
    expect(hostOfRunningCopy(pins, claudeCopy)).toBeNull();
    expect(detectDoctorHost({ ...pins, repoRoot: claudeCopy })).toBe("claude-code");
  });
});

describe("what doctor tells a fork's user", () => {
  for (const fork of FORKS) {
    test(`${fork}: the setup advice names no /siltpoke- command`, () => {
      expect(setupAdviceFor(fork)).toBe('Ask your agent to "run Siltpoke setup"');
      expect(setupAdviceFor(fork)).not.toContain("/siltpoke-");
    });

    test(`${fork}: wired through the plugin's own hooks/hooks.json when the running copy carries one`, () => {
      mkdirSync(join(copyOf(fork), "hooks"));
      writeFileSync(join(copyOf(fork), "hooks", "hooks.json"), "{}");
      expect(hostWiringPath(fork, { ...pins, repoRoot: copyOf(fork) })).toBe(join(copyOf(fork), "hooks", "hooks.json"));
    });

    test(`${fork}: otherwise its own settings.json (the from-source install)`, () => {
      const home = fork === "qoder" ? pins.qoderHome : pins.codebuddyHome;
      expect(hostWiringPath(fork, { ...pins, repoRoot: copyOf(fork) })).toBe(join(home, "settings.json"));
      // A copy that is not the fork's never names its own hooks.json (this repo has one).
      expect(hostWiringPath(fork, { ...pins, repoRoot: REPO })).toBe(join(home, "settings.json"));
    });
  }
});

describe("the real bundle, started from each fork's plugin cache (the run a user makes)", () => {
  /** Run `<where>/dist/siltpoke-cli.js doctor` with the temp home and nothing that names a host. */
  function doctorFrom(where: string): string {
    for (const dir of ["dist", "hooks", ".claude-plugin"]) cpSync(join(REPO, dir), join(where, dir), { recursive: true });
    const env: Record<string, string | undefined> = { ...process.env, HOME: home, SILTPOKE_HOME: join(home, ".siltpoke") };
    for (const name of [
      "CLAUDE_PLUGIN_ROOT",
      "CLAUDE_HOME",
      "CLAUDE_CONFIG_DIR",
      "CODEX_HOME",
      "QODER_HOME",
      "CODEBUDDY_HOME",
      "ANTIGRAVITY_HOOKS_HOME",
      "SILTPOKE_HOST",
    ]) {
      delete env[name];
    }
    const r = Bun.spawnSync(["bun", join(where, "dist", "siltpoke-cli.js"), "doctor"], { env, timeout: 60_000 });
    return new TextDecoder().decode(r.stdout);
  }

  for (const fork of FORKS) {
    test(`${fork} copy: no Claude Code row is red and nothing hands out a Claude Code command`, () => {
      const out = doctorFrom(copyOf(fork));
      expect(out).toContain(`skipped — this is a ${fork} install, wired through ${join(copyOf(fork), "hooks", "hooks.json")}`);
      expect(out).toContain(`skipped — a ${fork} install has no Claude Code slash-command symlinks`);
      expect(out).not.toContain("settings.json does not exist");
      expect(out).not.toContain("settings.json not readable");
      expect(out).not.toContain("Reinstall: /plugin install");
      expect(out).not.toContain("/siltpoke:siltpoke-setup");
    }, 90_000);
  }

  test("control: the same bundle from Claude Code's plugin cache is still judged as Claude Code", () => {
    const out = doctorFrom(join(home, ".claude", "plugins", "cache", "siltpoke", "siltpoke", "1.3.0"));
    expect(out).toContain("settings.json does not exist — Run `/siltpoke:siltpoke-setup`");
  }, 90_000);
});
