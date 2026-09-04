// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
// Copyright (c) 2026 Jiaqi Duan
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
// configure()'s writes to disk. The pure Stop-hook sweep: configure-stop-sweep.test.ts.
import {
  answersFilePath,
  configure,
  parseArgs,
  readAnswersFile,
} from "../../src/cli/configure";
import { SPECIES_PROFILES } from "../../src/brain/personality";
import { archetypeOf } from "../../src/installer/personality-seed";
import { resolveDaemonLauncher } from "../../src/installer/daemon-path";

let home: string;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "siltpoke-conf-"));
});
afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

/** Never let a test reach the real launchctl/systemctl. */
const noAutostart = {
  installAutostart: async () => ({ status: "skipped" as const, platform: "test" }),
};

/** The daemon shim, under the current test home. */
const shimPath = (): string => join(home, ".siltpoke", "bin", "daemon.sh");

/**
 * Make `home` look like a PLUGIN install: a real bundle dir + the plugin-root
 * pointer only the plugin's SessionStart hook writes. Without it a home is a repo
 * checkout, and the daemon shim must not be used.
 */
function installPluginRoot(): string {
  const root = join(home, "cache", "siltpoke-1.2.3");
  mkdirSync(join(root, "dist"), { recursive: true });
  mkdirSync(join(home, ".siltpoke"), { recursive: true });
  writeFileSync(join(home, ".siltpoke", "plugin-root"), root);
  return root;
}

describe("parseArgs", () => {
  test("reads every pet field and both feature flags", () => {
    const o = parseArgs([
      "--name", "Silty", "--species", "octopus",
      "--lang", "zh", "--personality", "sassy",
      "--statusline", "--daemon",
    ]);
    expect(o).toEqual({
      name: "Silty",
      species: "octopus",
      lang: "zh",
      personality: "sassy",
      statusline: true,
      daemon: true,
    });
  });

  test("features default OFF when the flags are absent", () => {
    const o = parseArgs([
      "--name", "S", "--species", "octopus",
      "--lang", "en", "--personality", "gentle",
    ]);
    expect(o.statusline).toBe(false);
    expect(o.daemon).toBe(false);
  });
});

describe("configure", () => {
  test("writes config.json with the pet the user created", async () => {
    await configure(
      parseArgs(["--name", "Silty", "--species", "slime", "--lang", "zh", "--personality", "sassy"]),
      home,
      noAutostart,
    );
    const cfg = JSON.parse(readFileSync(join(home, ".siltpoke", "config.json"), "utf8"));
    expect(cfg.name).toBe("Silty");
    expect(cfg.species).toBe("slime");
    // The FLAG is --lang; the KEY is `language` — the only one the runtime reads
    // (brain/personality.ts) and the one cli/doctor.ts requires. No `lang` mirror
    // key: nothing in src/ ever read it (schema noise).
    expect(cfg.language).toBe("zh");
    expect(cfg).not.toHaveProperty("lang");
    expect(cfg.snark).toBeGreaterThan(5); // sassy preset
  });

  test("species-default mode (no dials + no personality) applies THIS species' profile — not flat 5/10", async () => {
    // Defect 1: the "species default" mode sends NEITHER dials NOR a preset name.
    // The kernel must fall back to SPECIES_PROFILES[species] — a cat is 8/2/4/5/7,
    // NOT a flat 5/10 (only slime is all-5).
    const answers = join(home, "answers.json");
    writeFileSync(
      answers,
      JSON.stringify({ name: "Kitty", species: "cat", language: "en" }),
    );
    await configure(await readAnswersFile(answers), home, noAutostart);
    const cfg = JSON.parse(readFileSync(join(home, ".siltpoke", "config.json"), "utf8"));
    const profile = SPECIES_PROFILES.cat;
    expect(cfg.snark).toBe(profile.snark); // 8
    expect(cfg.patience).toBe(profile.patience); // 2
    expect(cfg.rigor).toBe(profile.rigor); // 4
    expect(cfg.chattiness).toBe(profile.chattiness); // 5
    expect(cfg.curiosity).toBe(profile.curiosity); // 7
    // The bug's tell: it would have been the flat slime profile.
    expect({
      snark: cfg.snark, patience: cfg.patience, rigor: cfg.rigor,
      chattiness: cfg.chattiness, curiosity: cfg.curiosity,
    }).not.toEqual({ snark: 5, patience: 5, rigor: 5, chattiness: 5, curiosity: 5 });
  });

  test("config.json carries a derived `archetype` string (matches archetypeOf on the resolved dials)", async () => {
    // Defect 3: the pre-plugin config shape includes `archetype`, derived from the
    // dials. buildConfig must write it. Custom-dials path first…
    const answers = join(home, "answers.json");
    // 0000 quadrant with mid curiosity (no Steady/Curious prefix) → "The Worrier",
    // the exact archetype the owner's pre-plugin config carried.
    const dials = { snark: 0, patience: 0, rigor: 0, chattiness: 0, curiosity: 5 };
    writeFileSync(
      answers,
      JSON.stringify({ name: "Doom", species: "slime", language: "en", dials }),
    );
    await configure(await readAnswersFile(answers), home, noAutostart);
    const cfg = JSON.parse(readFileSync(join(home, ".siltpoke", "config.json"), "utf8"));
    expect(typeof cfg.archetype).toBe("string");
    expect(cfg.archetype.length).toBeGreaterThan(0);
    expect(cfg.archetype).toBe(archetypeOf(dials)); // known dials → "The Worrier"
    expect(cfg.archetype).toBe("The Worrier");
  });

  test("archetype is derived even in species-default mode (from the species profile)", async () => {
    const answers = join(home, "answers.json");
    writeFileSync(
      answers,
      JSON.stringify({ name: "Kitty", species: "cat", language: "en" }),
    );
    await configure(await readAnswersFile(answers), home, noAutostart);
    const cfg = JSON.parse(readFileSync(join(home, ".siltpoke", "config.json"), "utf8"));
    expect(cfg.archetype).toBe(archetypeOf(SPECIES_PROFILES.cat));
  });

  test("re-running keeps the pet's progression and lets the new answers win", async () => {
    mkdirSync(join(home, ".siltpoke"), { recursive: true });
    writeFileSync(
      join(home, ".siltpoke", "config.json"),
      JSON.stringify({ name: "Old", species: "slime", language: "en", level: 7, xp: 420 }),
    );
    await configure(
      parseArgs(["--name", "New", "--species", "cat", "--lang", "zh", "--personality", "gentle"]),
      home,
      noAutostart,
    );
    const cfg = JSON.parse(readFileSync(join(home, ".siltpoke", "config.json"), "utf8"));
    expect(cfg.name).toBe("New"); // the answer the user just gave wins
    expect(cfg.level).toBe(7); // progression survives
    expect(cfg.xp).toBe(420);
    expect(existsSync(join(home, ".siltpoke", "config.json.pre-configure-bak"))).toBe(true);
  });

  test("--statusline writes the shim, points settings.json at it, and drops the legacy Stop hook", async () => {
    mkdirSync(join(home, ".claude"), { recursive: true });
    writeFileSync(
      join(home, ".claude", "settings.json"),
      JSON.stringify({
        statusLine: { type: "command", command: "starship prompt" },
        hooks: {
          Stop: [{ hooks: [{ type: "command", command: "bun /old/siltpoke/src/hooks/on-stop.ts" }] }],
        },
      }),
    );
    await configure(
      parseArgs([
        "--name", "S", "--species", "slime", "--lang", "en",
        "--personality", "sassy", "--statusline",
      ]),
      home,
      noAutostart,
    );
    const settings = JSON.parse(readFileSync(join(home, ".claude", "settings.json"), "utf8"));
    expect(settings.statusLine.command).toContain(".siltpoke/bin/statusline.sh");
    // The user's previous statusline is preserved so the wrapper can chain to it.
    expect(readFileSync(join(home, ".siltpoke", "inner.txt"), "utf8")).toContain("starship");
    // The plugin owns the Stop hook now — a leftover settings.json one means DOUBLE reviews.
    expect(settings.hooks?.Stop ?? []).toHaveLength(0);
    expect(existsSync(join(home, ".siltpoke", "bin", "statusline.sh"))).toBe(true);
  });

  test("--statusline backs settings.json up before mutating it", async () => {
    mkdirSync(join(home, ".claude"), { recursive: true });
    writeFileSync(
      join(home, ".claude", "settings.json"),
      JSON.stringify({ statusLine: { type: "command", command: "starship prompt" } }),
    );
    await configure(
      parseArgs(["--name", "S", "--species", "cat", "--lang", "en", "--personality", "sassy", "--statusline"]),
      home,
      noAutostart,
    );
    const backup = readFileSync(join(home, ".claude", "settings.json.pre-siltpoke"), "utf8");
    expect(JSON.parse(backup).statusLine.command).toBe("starship prompt");
  });

  test("--statusline on a re-run never writes the wrapper into inner.txt (fork-bomb guard)", async () => {
    mkdirSync(join(home, ".siltpoke"), { recursive: true });
    writeFileSync(join(home, ".siltpoke", "inner.txt"), "starship prompt");
    mkdirSync(join(home, ".claude"), { recursive: true });
    writeFileSync(
      join(home, ".claude", "settings.json"),
      JSON.stringify({
        statusLine: { type: "command", command: `sh ${join(home, ".siltpoke", "bin", "statusline.sh")}` },
      }),
    );
    await configure(
      parseArgs(["--name", "S", "--species", "cat", "--lang", "en", "--personality", "sassy", "--statusline"]),
      home,
      noAutostart,
    );
    expect(readFileSync(join(home, ".siltpoke", "inner.txt"), "utf8")).toBe("starship prompt");
  });

  test("--statusline with no settings.json at all still installs cleanly", async () => {
    await configure(
      parseArgs(["--name", "S", "--species", "cat", "--lang", "en", "--personality", "sassy", "--statusline"]),
      home,
      noAutostart,
    );
    const settings = JSON.parse(readFileSync(join(home, ".claude", "settings.json"), "utf8"));
    expect(settings.statusLine.command).toContain("statusline.sh");
  });

  test("--daemon on a PLUGIN install (pointer resolves) writes the version-proof shim, then installs autostart", async () => {
    installPluginRoot();
    const calls: string[] = [];
    await configure(
      parseArgs(["--name", "S", "--species", "cat", "--lang", "en", "--personality", "sassy", "--daemon"]),
      home,
      {
        installAutostart: async () => {
          // The shim must exist BEFORE the unit is rendered — the unit points at it.
          calls.push(existsSync(shimPath()) ? "shim-first" : "no-shim");
          return { status: "installed" as const, platform: "test" };
        },
      },
    );
    expect(calls).toEqual(["shim-first"]);
    const shim = readFileSync(shimPath(), "utf8");
    expect(shim).toContain(".siltpoke/plugin-root");
    expect(shim).not.toContain("/plugins/cache/"); // no versioned path baked in
    // …and the launcher actually selects it.
    const l = resolveDaemonLauncher("/usr/bin/bun", "/repo/src/cli/daemon.ts", home);
    expect(l).toEqual({ program: "/bin/sh", script: shimPath(), viaShim: true });
  });

  test("--daemon on a REPO checkout (no plugin pointer) writes NO shim — the unit keeps the direct path", async () => {
    // Without ~/.siltpoke/plugin-root (only the plugin's SessionStart hook writes
    // it) the shim resolves nothing: it idles, gets respawned forever, and reports
    // "installed" while serving no daemon.
    await configure(
      parseArgs(["--name", "S", "--species", "cat", "--lang", "en", "--personality", "sassy", "--daemon"]),
      home,
      noAutostart,
    );
    expect(existsSync(shimPath())).toBe(false);
    expect(resolveDaemonLauncher("/usr/bin/bun", "/repo/src/cli/daemon.ts", home)).toEqual({
      program: "/usr/bin/bun",
      script: "/repo/src/cli/daemon.ts",
      viaShim: false,
    });
  });

  test("--daemon with a DANGLING pointer (plugin uninstalled) writes no shim either", async () => {
    mkdirSync(join(home, ".siltpoke"), { recursive: true });
    writeFileSync(join(home, ".siltpoke", "plugin-root"), join(home, "cache", "gone-1.0.0"));
    await configure(
      parseArgs(["--name", "S", "--species", "cat", "--lang", "en", "--personality", "sassy", "--daemon"]),
      home,
      noAutostart,
    );
    expect(existsSync(shimPath())).toBe(false);
  });

  test("a failing autostart install warns but never throws (no half-install blowup)", async () => {
    await configure(
      parseArgs(["--name", "S", "--species", "cat", "--lang", "en", "--personality", "sassy", "--daemon"]),
      home,
      {
        installAutostart: async () => {
          throw new Error("launchctl bootstrap failed");
        },
      },
    );
    // config.json still landed — the pet exists even though autostart failed.
    expect(existsSync(join(home, ".siltpoke", "config.json"))).toBe(true);
  });

  test("no --daemon ⇒ autostart is never touched", async () => {
    let called = false;
    await configure(
      parseArgs(["--name", "S", "--species", "cat", "--lang", "en", "--personality", "sassy"]),
      home,
      {
        installAutostart: async () => {
          called = true;
          return { status: "installed" as const, platform: "test" };
        },
      },
    );
    expect(called).toBe(false);
    expect(existsSync(shimPath())).toBe(false);
  });

  test("sweeps the legacy Stop hook even WITHOUT --statusline (the plugin's hook fires regardless)", async () => {
    // The double-Brain-call hazard does not care which features the user picked:
    // the plugin's hooks.json Stop hook is unconditional. A user who takes only
    // --daemon (or neither flag) must not be left paying for two reviews a turn.
    mkdirSync(join(home, ".claude"), { recursive: true });
    writeFileSync(
      join(home, ".claude", "settings.json"),
      JSON.stringify({
        hooks: {
          Stop: [
            { hooks: [{ type: "command", command: "bun /Users/x/dev/pet/src/hooks/on-stop.ts" }] },
            { hooks: [{ type: "command", command: "notify-send done" }] },
          ],
        },
      }),
    );
    await configure(
      parseArgs(["--name", "S", "--species", "cat", "--lang", "en", "--personality", "sassy"]),
      home,
      noAutostart,
    );
    const settings = JSON.parse(readFileSync(join(home, ".claude", "settings.json"), "utf8"));
    // Ours is gone (caught by the on-stop.ts anchor, not the dir name) …
    expect(settings.hooks.Stop).toHaveLength(1);
    // … the user's own Stop hook is not.
    expect(settings.hooks.Stop[0].hooks[0].command).toBe("notify-send done");
    // The statusLine was NOT requested, so it stays absent.
    expect(settings.statusLine).toBeUndefined();
  });

  test("settings.json with nothing of ours in it is not rewritten at all", async () => {
    mkdirSync(join(home, ".claude"), { recursive: true });
    const original = JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: "command", command: "notify-send done" }] }] } });
    writeFileSync(join(home, ".claude", "settings.json"), original);
    await configure(
      parseArgs(["--name", "S", "--species", "cat", "--lang", "en", "--personality", "sassy"]),
      home,
      noAutostart,
    );
    // Byte-identical: no reformat, no backup churn on a file we had no business in.
    expect(readFileSync(join(home, ".claude", "settings.json"), "utf8")).toBe(original);
    expect(existsSync(join(home, ".claude", "settings.json.pre-siltpoke"))).toBe(false);
  });

  test("an unwritable ~/.claude warns but still leaves the pet installed", async () => {
    // ~/.claude is a FILE, not a dir → every settings.json write under it is ENOTDIR.
    writeFileSync(join(home, ".claude"), "not a directory");
    const warnings: string[] = [];
    await configure(
      parseArgs(["--name", "S", "--species", "cat", "--lang", "en", "--personality", "sassy", "--statusline"]),
      home,
      { ...noAutostart, warn: (m) => warnings.push(m) },
    );
    expect(warnings.join("\n")).toContain("settings.json");
    expect(existsSync(join(home, ".siltpoke", "config.json"))).toBe(true);
  });

  test("the sweep spares foreign Stop hooks that merely mention siltpoke, and says what it took", async () => {
    // The adversarial case, straight through the real settings.json write path.
    mkdirSync(join(home, ".claude"), { recursive: true });
    writeFileSync(
      join(home, ".claude", "settings.json"),
      JSON.stringify({
        permissions: { allow: ["Bash(ls:*)"] },
        env: { FOO: "bar" },
        hooks: {
          Stop: [
            {
              hooks: [
                { type: "command", command: "bun /Users/x/siltpoke/src/hooks/on-stop.ts" },
                { type: "command", command: "cd /Users/x/dev/siltpoke && make lint-notify" },
                { type: "command", command: "otherpet --log /Users/x/siltpoke-notes/x.log" },
              ],
            },
          ],
        },
      }),
    );
    const warnings: string[] = [];
    await configure(
      parseArgs(["--name", "S", "--species", "cat", "--lang", "en", "--personality", "sassy"]),
      home,
      { ...noAutostart, warn: (m) => warnings.push(m) },
    );
    const settings = JSON.parse(readFileSync(join(home, ".claude", "settings.json"), "utf8"));
    // The two foreign hooks are still there…
    expect(settings.hooks.Stop[0].hooks.map((h: { command: string }) => h.command)).toEqual([
      "cd /Users/x/dev/siltpoke && make lint-notify",
      "otherpet --log /Users/x/siltpoke-notes/x.log",
    ]);
    // …unrelated keys are intact, and the one entry we DID remove was announced.
    expect(settings.permissions).toEqual({ allow: ["Bash(ls:*)"] });
    expect(settings.env).toEqual({ FOO: "bar" });
    expect(warnings.join("\n")).toContain("removed legacy siltpoke Stop hook");
    expect(warnings.join("\n")).toContain("on-stop.ts");
  });

  test("an unparseable settings.json is left ALONE (never silently rewritten from {})", async () => {
    // Starting from `{}` would re-serialize it with permissions / env / every other hook gone.
    mkdirSync(join(home, ".claude"), { recursive: true });
    const corrupt = '{ "permissions": { "allow": ["Bash(ls:*)"] },,, }';
    writeFileSync(join(home, ".claude", "settings.json"), corrupt);
    const warnings: string[] = [];
    await configure(
      parseArgs([
        "--name", "S", "--species", "cat", "--lang", "en",
        "--personality", "sassy", "--statusline",
      ]),
      home,
      { ...noAutostart, warn: (m) => warnings.push(m) },
    );
    // Byte-identical — we did not touch it.
    expect(readFileSync(join(home, ".claude", "settings.json"), "utf8")).toBe(corrupt);
    expect(warnings.join("\n")).toContain("not valid JSON");
    // The pet still installs; only the settings wiring is skipped.
    expect(existsSync(join(home, ".siltpoke", "config.json"))).toBe(true);
  });

  test("asks nothing — completes with stdin closed", async () => {
    // The whole point of the kernel: it is callable from a slash command, which has no TTY.
    await configure(
      parseArgs(["--name", "S", "--species", "slime", "--lang", "en", "--personality", "sassy"]),
      home,
      noAutostart,
    );
    expect(existsSync(join(home, ".siltpoke", "config.json"))).toBe(true);
  });
});
