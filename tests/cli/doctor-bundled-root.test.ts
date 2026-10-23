// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
// Copyright (c) 2026 Jiaqi Duan
//
// Defect [32]: the doctor a plugin user actually runs is the BUNDLE,
// dist/siltpoke-cli.js, and it resolved the plugin root one level too high.
// `[24]`'s "the pointer names THIS install" check therefore never matched in
// the shipped build, and a healthy plugin install got two false ✗ rows plus
// "re-run /siltpoke:siltpoke-setup" (install audit §46.3; seen on Windows, reproduced on
// macOS). The §34 tests missed it because they inject `repoRoot` and never
// reach defaultRepoRoot(). These run the real entry points, bundle AND source,
// with the one condition the user has: no CLAUDE_PLUGIN_ROOT in the env.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const REPO = process.cwd();

let home: string;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "siltpoke-doctor-root-"));
  mkdirSync(join(home, ".siltpoke"), { recursive: true });
});
afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

function doctorWithPointer(entry: string, pointer: string): string {
  writeFileSync(join(home, ".siltpoke", "plugin-root"), pointer);
  const env: Record<string, string | undefined> = { ...process.env, HOME: home };
  // The whole defect lives in this absence: the host does not hand this
  // variable to a doctor the user starts, so the pointer is the only evidence.
  delete env.CLAUDE_PLUGIN_ROOT;
  delete env.SILTPOKE_HOME;
  // Keep the settings.json read inside the temp HOME, off the developer's own.
  delete env.CLAUDE_HOME;
  delete env.CLAUDE_CONFIG_DIR;
  const r = Bun.spawnSync(["bun", join(REPO, entry), "doctor"], { env, timeout: 60_000 });
  return new TextDecoder().decode(r.stdout);
}

/** The slash-command row, as printed. Its NAME changes with the verdict. */
function slashRow(out: string): string {
  return out.split("\n").find((l) => /slash command/.test(l)) ?? "";
}

/** The Stop-hook row plus its detail line — the second false ✗ in [32]. */
function stopHookRows(out: string): string {
  const lines = out.split("\n");
  const i = lines.findIndex((l) => l.includes("Stop hook registered"));
  return i < 0 ? "" : `${lines[i]}\n${lines[i + 1] ?? ""}`;
}

describe("doctor finds its own plugin root (defect [32])", () => {
  for (const entry of ["dist/siltpoke-cli.js", "src/cli/plugin-cli.ts"]) {
    test(`${entry}: a pointer naming this install reads as a plugin install`, () => {
      const out = doctorWithPointer(entry, REPO);
      const row = slashRow(out);
      expect(row).not.toBe("");
      expect(row).toContain("slash commands");
      expect(row).not.toContain("symlinks intact");
      // The Stop-hook row: the plugin's own hooks.json owns the hook, so an
      // empty settings.json is expected — not "hooks.Stop[] is missing".
      const stop = stopHookRows(out);
      expect(stop).toContain("plugin-owned");
      expect(stop).not.toContain("✗");
    }, 90_000);
  }

  test("control: a pointer naming a different directory does NOT read as this install", () => {
    // Without this, the test above would also pass if the check simply
    // always said "plugin install" — the opposite mask of the same defect.
    const elsewhere = mkdtempSync(join(tmpdir(), "siltpoke-other-install-"));
    try {
      const out = doctorWithPointer("dist/siltpoke-cli.js", elsewhere);
      expect(slashRow(out)).toContain("symlinks intact");
      expect(stopHookRows(out)).not.toContain("plugin-owned");
    } finally {
      rmSync(elsewhere, { recursive: true, force: true });
    }
  }, 90_000);
});
