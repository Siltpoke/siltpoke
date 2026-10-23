// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
// Copyright (c) 2026 Jiaqi Duan
//
// Regression guard for audit defect [9]: `.antigravity-plugin/plugin.json`
// declared only `hooks`, so `agy plugin install` reported
// `skills: skipped (not found)` and the conversational setup guide in
// `skills/siltpoke/SKILL.md` never reached agy users — the plugin installed
// and did nothing, with no error. Fix = `scripts/build-dist.ts`
// (`copyAgyPluginSelfContained`) copies the repo-root `skills/` tree into
// `.antigravity-plugin/skills/`, since agy `plugin install <dir>` copies ONLY
// that subdir. agy finds `./skills/` by folder name.
//
// The `[9]` fix also added `"skills": "./skills/"` to plugin.json. agy 1.4.2
// and 1.4.4 reject that value ("syntax error … unexpected token "./skills/". The
// loader skips this plugin") — the WHOLE plugin, Stop hook included, so agy
// sessions got no review at all. Measured 2026-10-21 with `agy plugin
// validate`: an internal design note
//
// These tests assert real filesystem effects, not string-matching: they run
// the real copy function and read files back off disk. A stubbed writer
// proves nothing about disk.
import { describe, expect, test } from "bun:test";
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
import { copyAgyPluginSelfContained } from "../../scripts/build-dist";

describe("agy plugin ships ./skills/ without naming it in plugin.json", () => {
  test("plugin.json has no skills key, and ./skills/ exists on disk after the build copy, with a SKILL.md in it", () => {
    const manifest = JSON.parse(
      readFileSync(join(".antigravity-plugin", "plugin.json"), "utf8"),
    ) as Record<string, unknown>;
    // agy rejects this key and skips the whole plugin (header above).
    expect(Object.keys(manifest)).not.toContain("skills");

    // Run the REAL copy against the real repo tree (dist/ + hooks/agy-stop.sh
    // already exist here from a prior build — same precondition buildAll()
    // relies on). This is the exact function `bun run build:dist` calls.
    copyAgyPluginSelfContained();

    const shippedSkillsDir = join(".antigravity-plugin", "skills");
    expect(existsSync(shippedSkillsDir)).toBe(true);

    const shippedSkillFile = join(shippedSkillsDir, "siltpoke", "SKILL.md");
    expect(existsSync(shippedSkillFile)).toBe(true);
  });

  test("the shipped SKILL.md is a real copy of the source, byte for byte (not stubbed)", () => {
    copyAgyPluginSelfContained();
    const source = readFileSync(join("skills", "siltpoke", "SKILL.md"), "utf8");
    const shipped = readFileSync(
      join(".antigravity-plugin", "skills", "siltpoke", "SKILL.md"),
      "utf8",
    );
    expect(shipped).toBe(source);
    expect(shipped.length).toBeGreaterThan(0);
  });
});

// Defect [49]: an agy install sees ONLY .antigravity-plugin/, and agy-stop.sh
// sources its helpers behind a `-r` test — a helper that was not copied makes
// the wrapper skip it in silence. That is exactly how a new helper would ship
// to every host except agy with nothing going red.
describe("every helper agy-stop.sh sources travels with the agy plugin", () => {
  test("each lib/*.sh the wrapper names is shipped, byte for byte", () => {
    copyAgyPluginSelfContained();
    const wrapper = readFileSync(join("hooks", "agy-stop.sh"), "utf8");
    const named = [...new Set([...wrapper.matchAll(/\/lib\/([a-z0-9-]+\.sh)/g)].map((m) => m[1] as string))].sort();
    // Not vacuous: the wrapper really does name these two.
    expect(named).toEqual(["record-host.sh", "resolve-bun.sh"]);
    for (const name of named) {
      const shipped = join(".antigravity-plugin", "hooks", "lib", name);
      expect(existsSync(shipped)).toBe(true);
      expect(readFileSync(shipped, "utf8")).toBe(readFileSync(join("hooks", "lib", name), "utf8"));
    }
  });
});

describe("copyAgyPluginSelfContained skills copy is rm-then-cp, not a merge", () => {
  // Uses an isolated fixture root (not the real skills/ source) so this test
  // can delete a "source" skill without ever touching the repo's real one.
  function makeFixtureRoot(): string {
    const root = mkdtempSync(join(tmpdir(), "siltpoke-agy-skills-test-"));
    mkdirSync(join(root, "dist"), { recursive: true });
    writeFileSync(join(root, "dist", "siltpoke-stop.js"), "// stub dist entry\n");
    mkdirSync(join(root, "hooks"), { recursive: true });
    writeFileSync(join(root, "hooks", "agy-stop.sh"), "#!/bin/sh\necho stub\n");
    // agy-stop.sh sources this (defect [20]/[21]); the build copies it, so the
    // fixture has to carry it too.
    mkdirSync(join(root, "hooks", "lib"), { recursive: true });
    writeFileSync(join(root, "hooks", "lib", "resolve-bun.sh"), "# stub\n");
    mkdirSync(join(root, "skills", "probeskill"), { recursive: true });
    writeFileSync(join(root, "skills", "probeskill", "SKILL.md"), "# probe skill\n");
    mkdirSync(join(root, ".antigravity-plugin"), { recursive: true });
    return root;
  }

  test("a skill removed from source does NOT survive in the shipped plugin", () => {
    const root = makeFixtureRoot();
    const prevCwd = process.cwd();
    try {
      process.chdir(root);
      copyAgyPluginSelfContained();
      expect(
        existsSync(join(root, ".antigravity-plugin", "skills", "probeskill", "SKILL.md")),
      ).toBe(true);

      // Delete the skill from the SOURCE (not the shipped copy), then rebuild.
      rmSync(join(root, "skills", "probeskill"), { recursive: true, force: true });
      copyAgyPluginSelfContained();

      // If this were a merge-copy (cpSync without a preceding rmSync) the
      // stale skill would still be sitting in the shipped plugin. The
      // rm-then-cp semantics require it gone.
      expect(
        existsSync(join(root, ".antigravity-plugin", "skills", "probeskill")),
      ).toBe(false);
      // The skills root itself must still exist (didn't just vanish).
      expect(existsSync(join(root, ".antigravity-plugin", "skills"))).toBe(true);
    } finally {
      process.chdir(prevCwd);
      rmSync(root, { recursive: true, force: true });
    }
  });
});
