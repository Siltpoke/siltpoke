// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
// Copyright (c) 2026 Jiaqi Duan
//
// Regression guard for audit defect [9]: `.antigravity-plugin/plugin.json`
// declared only `hooks`, so `agy plugin install` reported
// `skills: skipped (not found)` and the conversational setup guide in
// `skills/siltpoke/SKILL.md` never reached agy users — the plugin installed
// and did nothing, with no error. Fix = plugin.json now declares a `skills`
// key AND `scripts/build-dist.ts` (`copyAgyPluginSelfContained`) actually
// copies the repo-root `skills/` tree into `.antigravity-plugin/skills/`,
// since agy `plugin install <dir>` copies ONLY that subdir.
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

describe("agy plugin.json declares a skills key that resolves to a real dir", () => {
  test("plugin.json parses and its skills path exists on disk after the build copy, with a SKILL.md in it", () => {
    const manifest = JSON.parse(
      readFileSync(join(".antigravity-plugin", "plugin.json"), "utf8"),
    ) as { skills?: string };
    expect(manifest.skills).toBe("./skills/");

    // Run the REAL copy against the real repo tree (dist/ + hooks/agy-stop.sh
    // already exist here from a prior build — same precondition buildAll()
    // relies on). This is the exact function `bun run build:dist` calls.
    copyAgyPluginSelfContained();

    const shippedSkillsDir = join(".antigravity-plugin", manifest.skills as string);
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
