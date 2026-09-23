// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
// Copyright (c) 2026 Jiaqi Duan
//
// Reviewer-found CRITICAL follow-up to audit defect [9]: the skill's
// "Resolve the plugin root first" step used to be a single mandatory
// `codex plugin list --json | jq ...` command. An agy-only user (no `codex`
// binary at all) hit `command not found` on that very first line, so every
// later `bun "$PLUGIN_ROOT/dist/..."` command in the skill was unreachable —
// [9]'s fix was plumbing with no water for agy. Fix = a host-agnostic
// resolution ladder (env vars -> codex form, only when `codex` exists -> the
// agy install path), each rung validated against a real
// `dist/siltpoke-cli.js` before use, with a plain failure message when every
// rung comes up empty.
//
// This test does not re-implement the ladder and does not string-match the
// surrounding prose — it extracts the ACTUAL fenced shell block out of
// skills/siltpoke/SKILL.md and EXECUTES it (mirrors the
// execute-the-real-hook harness in tests/plugin/host-aware-nudge.test.ts),
// so an edit that breaks the snippet breaks this test, not just the docs.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const REPO = process.cwd();

// Prefer dash over the platform `sh` — see hook-guard.test.ts's identical
// rationale: macOS's /bin/sh (bash) is lenient about POSIX edge cases that
// dash treats as fatal, and the snippet must run under a real POSIX `sh`.
const SHELL = existsSync("/bin/dash") ? "/bin/dash" : "sh";

// No codex/agy/jq on this PATH by construction — isolates the ladder's own
// env-var and filesystem rungs from whatever happens to be installed on the
// machine actually running this test.
const SCRUBBED_PATH = "/usr/bin:/bin";

/**
 * A reachable bun in a fixture HOME.
 *
 * The prelude resolves bun as well as the plugin root (defect [22]: a skill-run
 * shell is not a login shell, so a bare `bun` gave 127 — including on `doctor`).
 * With SCRUBBED_PATH there is no bun on PATH, so without this the prelude would
 * correctly complain on stderr and the PLUGIN_ROOT arms would fail for an
 * unrelated reason.
 */
function reachableBun(home: string): void {
  mkdirSync(join(home, ".siltpoke"), { recursive: true });
  writeFileSync(join(home, ".siltpoke", "bun-path"), `${process.execPath}\n`);
}

function extractPlugRootSnippet(): string {
  const md = readFileSync(join(REPO, "skills", "siltpoke", "SKILL.md"), "utf8");
  const sectionStart = md.indexOf("## Resolve the plugin root first");
  if (sectionStart === -1) {
    throw new Error("SKILL.md no longer has a '## Resolve the plugin root first' section");
  }
  const nextSection = md.indexOf("\n## ", sectionStart + 1);
  const section = nextSection === -1 ? md.slice(sectionStart) : md.slice(sectionStart, nextSection);
  const fence = section.match(/```(?:bash|sh)\n([\s\S]*?)```/);
  if (!fence) {
    throw new Error("No fenced bash/sh block found in the plugin-root-resolution section");
  }
  return fence[1];
}

/** Run the extracted snippet, then print the resulting PLUGIN_ROOT so the test can read it. */
function runSnippet(
  env: Record<string, string>,
  opts: { nounset?: boolean } = {},
): { stdout: string; stderr: string; exitCode: number } {
  const snippet = extractPlugRootSnippet();
  // `set -u` is opt-in per arm: a skill-run shell may have it on, and under it an
  // unguarded ${VAR} is a hard abort that kills the whole snippet rather than
  // reaching the designed "could not find" message. Measured: an unguarded
  // ${HOME} in rung (c) died with `HOME: parameter not set` and every later line
  // of the sourced script was skipped.
  const prelude = opts.nounset ? "set -u\n" : "";
  const script = `${prelude}${snippet}\nprintf '%s' "$PLUGIN_ROOT"`;
  const r = Bun.spawnSync([SHELL, "-c", script], { env });
  return {
    stdout: new TextDecoder().decode(r.stdout),
    stderr: new TextDecoder().decode(r.stderr),
    exitCode: r.exitCode,
  };
}

describe("skills/siltpoke/SKILL.md plugin-root resolution ladder", () => {
  let home: string;
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "siltpoke-skill-root-"));
  });

  test("agy-only arm: no codex on PATH, no env var set, resolves via ~/.gemini/config/plugins/siltpoke (positive control)", () => {
    const pluginDir = join(home, ".gemini", "config", "plugins", "siltpoke");
    mkdirSync(join(pluginDir, "dist"), { recursive: true });
    writeFileSync(join(pluginDir, "dist", "siltpoke-cli.js"), "");
    reachableBun(home);
    const { stdout, stderr, exitCode } = runSnippet({ HOME: home, PATH: SCRUBBED_PATH });
    expect(exitCode).toBe(0);
    expect(stdout).toBe(pluginDir);
    expect(stderr).toBe("");
  });

  test("env-var arm: ANTIGRAVITY_PLUGIN_ROOT pointing at a valid install resolves without touching any CLI (positive control)", () => {
    const root = mkdtempSync(join(tmpdir(), "siltpoke-envroot-"));
    try {
      mkdirSync(join(root, "dist"), { recursive: true });
      writeFileSync(join(root, "dist", "siltpoke-cli.js"), "");
      reachableBun(home);
      const { stdout, stderr, exitCode } = runSnippet({
        HOME: home,
        PATH: SCRUBBED_PATH,
        ANTIGRAVITY_PLUGIN_ROOT: root,
      });
      expect(exitCode).toBe(0);
      expect(stdout).toBe(root);
      expect(stderr).toBe("");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("nothing-available arm: empty HOME, no codex, no env var -> empty PLUGIN_ROOT and an actionable stderr message", () => {
    // This arm is the one most likely to pass vacuously — a harness that
    // silently captures nothing also "sees" an empty stdout. The two arms
    // above are its positive control, run through the exact same
    // extract-and-execute harness: both resolve a real, non-empty path, so
    // an empty result here is the ladder's own behavior on a genuinely
    // unresolvable host, not a broken test rig.
    const { stdout, stderr, exitCode } = runSnippet({ HOME: home, PATH: SCRUBBED_PATH });
    expect(exitCode).toBe(0);
    expect(stdout).toBe("");
    expect(stderr.length).toBeGreaterThan(0);
    expect(stderr.toLowerCase()).toContain("could not find");
  });

  test("set -u with HOME genuinely UNSET: reaches the designed message instead of aborting on an unbound variable", () => {
    // Not the same as HOME="" — an empty-but-set HOME never trips `set -u`.
    // The env object deliberately omits HOME entirely; a stripped or minimal
    // execution sandbox does exactly this. The assertion that matters is the
    // LAST one: it proves the snippet ran to completion, which an abort on an
    // unbound variable would prevent. A bare "stderr is non-empty" check would
    // NOT distinguish the two — the abort also writes to stderr.
    const { stdout, stderr, exitCode } = runSnippet(
      { PATH: SCRUBBED_PATH },
      { nounset: true },
    );
    expect(exitCode).toBe(0);
    expect(stdout).toBe("");
    expect(stderr.toLowerCase()).toContain("could not find");
    expect(stderr.toLowerCase()).not.toContain("parameter not set");
    expect(stderr.toLowerCase()).not.toContain("unbound variable");
  });

  test("set -u with a resolvable agy install: the guard does not break the happy path", () => {
    // Positive control for the arm above — the `${HOME:-}` guard must not cost
    // rung (c) its ability to resolve when HOME IS set.
    const root = join(home, ".gemini", "config", "plugins", "siltpoke");
    mkdirSync(join(root, "dist"), { recursive: true });
    writeFileSync(join(root, "dist", "siltpoke-cli.js"), "");
    const { stdout, exitCode } = runSnippet(
      { HOME: home, PATH: SCRUBBED_PATH },
      { nounset: true },
    );
    expect(exitCode).toBe(0);
    expect(stdout).toBe(root);
  });
});
