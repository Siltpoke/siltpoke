// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
// Copyright (c) 2026 Jiaqi Duan
//
// Defect [81]: on a machine that also has ~/.claude, a doctor started from the
// copy of Siltpoke that Antigravity or codex installed judged itself as a
// Claude Code install. From the Antigravity copy it printed
//   ✗ slash command symlinks intact — <plugin>/.claude-plugin/commands does not exist — repo layout is broken
// and from the codex copy (a clone that does carry that folder)
//   ✗ slash command symlinks intact (0/12) — … Reinstall: /plugin install siltpoke.
// Both are answers about Claude Code given to a user who asked from another
// host. Where the running copy sits says which host started it; the machine
// having a ~/.claude does not.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { cpSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { detectDoctorHost, hostWiringPath } from "../../src/cli/doctor";
import { codexWiringPath, hostOfRunningCopy } from "../../src/cli/doctor-agy-plugin-host";
import { resolveCodexHome } from "../../src/installer/paths";

const REPO = process.cwd();

let home: string;
let agyRoot: string;
let codexHome: string;
/** The seams that keep every probe inside the temp home. */
let pins: { claudeHome: string; agyHooksJsonPath: string; codexConfigPath: string };

beforeEach(() => {
  home = realpathSync(mkdtempSync(join(tmpdir(), "siltpoke-running-host-")));
  agyRoot = join(home, ".gemini", "config", "plugins", "siltpoke");
  codexHome = join(home, ".codex");
  mkdirSync(join(agyRoot, "dist"), { recursive: true });
  mkdirSync(join(codexHome, ".tmp", "marketplaces", "siltpoke", "dist"), { recursive: true });
  mkdirSync(join(home, ".claude"));
  pins = {
    claudeHome: join(home, ".claude"),
    agyHooksJsonPath: join(home, ".gemini", "config", "hooks.json"),
    codexConfigPath: join(codexHome, "config.toml"),
  };
});
afterEach(() => { rmSync(home, { recursive: true, force: true }); });

describe("which host's copy is this doctor running from", () => {
  test("the Antigravity plugin folder itself", () => {
    expect(hostOfRunningCopy(pins, agyRoot)).toBe("antigravity");
  });

  test("anywhere under codex's home — the marketplace clone and the plugin cache", () => {
    expect(hostOfRunningCopy(pins, join(codexHome, ".tmp", "marketplaces", "siltpoke"))).toBe("codex");
    mkdirSync(join(codexHome, "plugins", "cache", "siltpoke", "siltpoke", "1.3.0"), { recursive: true });
    expect(hostOfRunningCopy(pins, join(codexHome, "plugins", "cache", "siltpoke", "siltpoke", "1.3.0"))).toBe("codex");
  });

  test("a source checkout, or any folder that is neither: no answer", () => {
    expect(hostOfRunningCopy(pins, REPO)).toBeNull();
    mkdirSync(join(home, "work", "siltpoke"), { recursive: true });
    expect(hostOfRunningCopy(pins, join(home, "work", "siltpoke"))).toBeNull();
  });

  test("a folder whose name only starts like the host's is not inside it", () => {
    mkdirSync(join(home, ".codex-backup", "siltpoke"), { recursive: true });
    expect(hostOfRunningCopy(pins, join(home, ".codex-backup", "siltpoke"))).toBeNull();
    mkdirSync(join(home, ".gemini", "config", "plugins", "siltpoke-old"), { recursive: true });
    expect(hostOfRunningCopy(pins, join(home, ".gemini", "config", "plugins", "siltpoke-old"))).toBeNull();
  });

  test("the folder ABOVE the Antigravity plugin is not the plugin", () => {
    expect(hostOfRunningCopy(pins, join(home, ".gemini", "config", "plugins"))).toBeNull();
  });

  test("reached through a link, it is still that host's copy", () => {
    const link = join(home, "shortcut");
    symlinkSync(agyRoot, link);
    expect(hostOfRunningCopy(pins, link)).toBe("antigravity");
  });

  test("a running copy that is not on disk gives no answer", () => {
    expect(hostOfRunningCopy(pins, join(home, "gone"))).toBeNull();
    expect(hostOfRunningCopy(pins, join(codexHome, "gone"))).toBeNull();
  });

  test("a host folder that is not on disk gives no answer", () => {
    rmSync(join(home, ".gemini"), { recursive: true });
    rmSync(codexHome, { recursive: true });
    expect(hostOfRunningCopy(pins, home)).toBeNull();
  });

  test("a codex home that also holds Claude Code's home (CODEX_HOME=$HOME) proves nothing", () => {
    const checkout = join(home, "work", "checkout");
    mkdirSync(checkout, { recursive: true });
    const codexIsHome = { ...pins, codexConfigPath: join(home, "config.toml") };
    expect(hostOfRunningCopy(codexIsHome, checkout)).toBeNull();
    expect(detectDoctorHost({ ...codexIsHome, repoRoot: checkout })).toBe("claude-code");
    // Control: the same layout with no Claude Code home in it is codex's.
    rmSync(pins.claudeHome, { recursive: true });
    expect(hostOfRunningCopy(codexIsHome, checkout)).toBe("codex");
  });
});

describe("where a codex install is wired", () => {
  const copy = () => join(codexHome, ".tmp", "marketplaces", "siltpoke");

  test("running from codex's own copy, which carries a hooks.json: that file", () => {
    writeFileSync(join(copy(), "hooks.json"), "{}");
    expect(codexWiringPath(pins, copy())).toBe(join(copy(), "hooks.json"));
  });

  test("doctor's rows get that file from the copy they were told is running", () => {
    writeFileSync(join(copy(), "hooks.json"), "{}");
    expect(hostWiringPath("codex", { ...pins, repoRoot: copy() })).toBe(join(copy(), "hooks.json"));
  });

  test("codex's copy with no hooks.json of its own: the older location", () => {
    expect(codexWiringPath(pins, copy())).toBe(join(resolveCodexHome(), "hooks.json"));
  });

  test("control: a copy that is not codex's never names its own hooks.json (this repo has one)", () => {
    expect(codexWiringPath(pins, REPO)).toBe(join(resolveCodexHome(), "hooks.json"));
    mkdirSync(join(home, "work", "checkout"), { recursive: true });
    writeFileSync(join(home, "work", "checkout", "hooks.json"), "{}");
    expect(codexWiringPath(pins, join(home, "work", "checkout"))).toBe(join(resolveCodexHome(), "hooks.json"));
  });
});

describe("host detection: the copy that is running outranks a ~/.claude that merely exists", () => {
  test("from the Antigravity copy, on a machine with ~/.claude: antigravity", () => {
    expect(detectDoctorHost({ ...pins, repoRoot: agyRoot })).toBe("antigravity");
  });

  test("from the codex copy, on a machine with ~/.claude: codex", () => {
    expect(detectDoctorHost({ ...pins, repoRoot: join(codexHome, ".tmp", "marketplaces", "siltpoke") })).toBe("codex");
  });

  test("control: from anywhere else, a present ~/.claude still wins ([16]'s rule)", () => {
    // Both other hosts are wired on this machine, and it is still Claude Code.
    writeFileSync(pins.codexConfigPath, "");
    mkdirSync(join(home, "work", "checkout"), { recursive: true });
    expect(detectDoctorHost({ ...pins, repoRoot: join(home, "work", "checkout") })).toBe("claude-code");
  });

  test("control: from anywhere else with no ~/.claude, the machine is still what is read", () => {
    rmSync(pins.claudeHome, { recursive: true });
    writeFileSync(pins.codexConfigPath, "");
    mkdirSync(join(home, "work", "checkout"), { recursive: true });
    expect(detectDoctorHost({ ...pins, repoRoot: join(home, "work", "checkout") })).toBe("codex");
  });
});

describe("the real bundle, started from where each host keeps it (the run a user makes)", () => {
  /** Run `<where>/dist/siltpoke-cli.js doctor` with the temp home and nothing that names a host. */
  function doctorFrom(where: string): string {
    cpSync(join(REPO, "dist"), join(where, "dist"), { recursive: true });
    const env: Record<string, string | undefined> = { ...process.env, HOME: home };
    for (const name of ["CLAUDE_PLUGIN_ROOT", "SILTPOKE_HOME", "CLAUDE_HOME", "CLAUDE_CONFIG_DIR", "CODEX_HOME", "ANTIGRAVITY_HOOKS_HOME", "SILTPOKE_HOST"]) {
      delete env[name];
    }
    const r = Bun.spawnSync(["bun", join(where, "dist", "siltpoke-cli.js"), "doctor"], { env, timeout: 60_000 });
    return new TextDecoder().decode(r.stdout);
  }
  const slashRows = (out: string) => {
    const lines = out.split("\n");
    const i = lines.findIndex((l) => /slash command/.test(l));
    return i < 0 ? "" : `${lines[i]}\n${lines[i + 1] ?? ""}`;
  };

  test("Antigravity copy: the slash-command row is skipped, and nothing calls the folder a broken repo", () => {
    const out = doctorFrom(agyRoot);
    expect(slashRows(out)).toContain("skipped — an antigravity install has no Claude Code slash-command symlinks");
    expect(out).not.toContain("repo layout is broken");
    expect(out).not.toContain("/siltpoke:siltpoke-setup");
    expect(out).not.toContain("/plugin install");
  }, 90_000);

  test("codex copy (it carries .claude-plugin/commands): skipped too, not '0/12 … Reinstall: /plugin install'", () => {
    const where = join(codexHome, ".tmp", "marketplaces", "siltpoke");
    cpSync(join(REPO, ".claude-plugin"), join(where, ".claude-plugin"), { recursive: true });
    const out = doctorFrom(where);
    expect(slashRows(out)).toContain("skipped — a codex install has no Claude Code slash-command symlinks");
    // The copy's own hooks.json is named, not the older ~/.codex/hooks.json —
    // and since §110 W2 it is read, not skipped: an empty one is a red row.
    cpSync(join(REPO, ".codex-plugin"), join(where, ".codex-plugin"), { recursive: true });
    writeFileSync(join(where, "hooks.json"), "{}");
    const again = doctorFrom(where);
    expect(again).toContain(`${join(where, "hooks.json")} has no Stop entry that runs codex-stop`);
    expect(again).not.toContain(join(codexHome, "hooks.json"));
    expect(out).not.toContain("Reinstall: /plugin install");
    expect(out).not.toContain("/siltpoke:siltpoke-setup");
  }, 90_000);

  test("control: the same bundle from a folder that is no host's is still judged as Claude Code", () => {
    const where = join(home, "work", "checkout");
    mkdirSync(where, { recursive: true });
    const out = doctorFrom(where);
    expect(slashRows(out)).toContain("symlinks intact");
    expect(slashRows(out)).toContain("repo layout is broken");
  }, 90_000);
});
