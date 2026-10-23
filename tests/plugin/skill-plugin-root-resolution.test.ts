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
  opts: { nounset?: boolean; errexit?: boolean; cwd?: string } = {},
): { stdout: string; stderr: string; exitCode: number } {
  const snippet = extractPlugRootSnippet();
  // `set -u` is opt-in per arm: a skill-run shell may have it on, and under it an
  // unguarded ${VAR} is a hard abort that kills the whole snippet rather than
  // reaching the designed "could not find" message. Measured: an unguarded
  // ${HOME} in rung (c) died with `HOME: parameter not set` and every later line
  // of the sourced script was skipped.
  const prelude = (opts.nounset ? "set -u\n" : "") + (opts.errexit ? "set -e\n" : "");
  const script = `${prelude}${snippet}\nprintf '%s' "$PLUGIN_ROOT"`;
  const r = Bun.spawnSync([SHELL, "-c", script], { env, cwd: opts.cwd });
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

// Defect [54]: with BOTH codex and agy installed, a skill running inside agy
// resolved codex's copy (the codex rung sat before the agy rung). The ladder now
// orders those two rungs by the host running the skill. `codex` here is a stub
// script on a private PATH dir — the real `codex plugin list` is never run.
describe("host-aware ordering when codex AND agy are both installed ([54])", () => {
  let home: string;
  let stubDir: string;
  let codexRoot: string;
  let agyRoot: string;
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "siltpoke-skill-both-"));
    stubDir = join(home, "stubs");
    codexRoot = join(home, "codex-copy");
    agyRoot = join(home, ".gemini", "config", "plugins", "siltpoke");
    for (const r of [codexRoot, agyRoot]) {
      mkdirSync(join(r, "dist"), { recursive: true });
      writeFileSync(join(r, "dist", "siltpoke-cli.js"), "");
    }
    mkdirSync(stubDir, { recursive: true });
    const json = JSON.stringify({ installed: [{ name: "siltpoke", source: { path: codexRoot } }] });
    writeFileSync(join(stubDir, "codex"), `#!/bin/sh\nprintf '%s' '${json}'\n`, { mode: 0o755 });
    reachableBun(home);
  });
  afterEach(() => rmSync(home, { recursive: true, force: true }));

  const env = (extra: Record<string, string> = {}) => ({
    HOME: home,
    PATH: `${stubDir}:${SCRUBBED_PATH}`,
    ...extra,
  });

  test("running as agy: agy's own copy wins, codex's is not chosen", () => {
    const { stdout } = runSnippet(env({ SILTPOKE_HOST: "agy" }));
    expect(stdout).toBe(agyRoot);
    expect(stdout).not.toBe(codexRoot);
  });

  test("running as codex: codex's copy wins", () => {
    expect(runSnippet(env({ SILTPOKE_HOST: "codex" })).stdout).toBe(codexRoot);
  });

  test("unknown host keeps the old order (codex first)", () => {
    expect(runSnippet(env()).stdout).toBe(codexRoot);
  });

  test("host detected from an ancestor process named agy", () => {
    // Stub `ps`: every process reports comm `agy`.
    writeFileSync(
      join(stubDir, "ps"),
      "#!/bin/sh\ncase \"$*\" in *comm=*) echo /Applications/agy;; *ppid=*) echo 1;; esac\n",
      { mode: 0o755 },
    );
    expect(runSnippet(env()).stdout).toBe(agyRoot);
  });

  test("only codex installed while running as agy: falls back to codex's copy", () => {
    rmSync(join(home, ".gemini"), { recursive: true, force: true });
    expect(runSnippet(env({ SILTPOKE_HOST: "agy" })).stdout).toBe(codexRoot);
  });

  test("only agy installed while running as codex: falls back to agy's copy", () => {
    rmSync(join(stubDir, "codex"));
    expect(runSnippet(env({ SILTPOKE_HOST: "codex" })).stdout).toBe(agyRoot);
  });

  test("SILTPOKE_SKILL_FILE: the copy the skill was loaded from wins over host order", () => {
    const skillFile = join(agyRoot, "skills", "siltpoke", "SKILL.md");
    mkdirSync(join(agyRoot, "skills", "siltpoke"), { recursive: true });
    writeFileSync(skillFile, "");
    const { stdout } = runSnippet(env({ SILTPOKE_SKILL_FILE: skillFile, SILTPOKE_HOST: "codex" }));
    expect(stdout).toBe(agyRoot);
  });

  test("SILTPOKE_SKILL_FILE under .codex-plugin/skills resolves to the parent that holds dist", () => {
    const skillFile = join(codexRoot, ".codex-plugin", "skills", "siltpoke", "SKILL.md");
    mkdirSync(join(codexRoot, ".codex-plugin", "skills", "siltpoke"), { recursive: true });
    writeFileSync(skillFile, "");
    expect(runSnippet(env({ SILTPOKE_SKILL_FILE: skillFile, SILTPOKE_HOST: "agy" })).stdout).toBe(
      codexRoot,
    );
  });

  test("bad SILTPOKE_SKILL_FILE with a cwd that holds dist/ does NOT resolve to cwd", () => {
    const cwd = join(home, "project");
    mkdirSync(join(cwd, "dist"), { recursive: true });
    writeFileSync(join(cwd, "dist", "siltpoke-cli.js"), "");
    const { stdout } = runSnippet(
      env({ SILTPOKE_SKILL_FILE: "", SILTPOKE_HOST: "agy" }),
      { cwd },
    );
    expect(stdout).toBe(agyRoot);
    const bad = runSnippet(
      env({ SILTPOKE_SKILL_FILE: "/nonexistent/x/y/SKILL.md", SILTPOKE_HOST: "agy" }),
      { cwd },
    );
    expect(bad.stdout).toBe(agyRoot);
    expect(bad.stdout).not.toBe(".");
    expect(bad.stdout).not.toBe(cwd);
  });

  test("under set -e a bad skill path and a failing codex stub still complete", () => {
    writeFileSync(join(stubDir, "codex"), "#!/bin/sh\nexit 3\n", { mode: 0o755 });
    const { stdout, exitCode } = runSnippet(
      env({ SILTPOKE_SKILL_FILE: "/nonexistent/x/y/SKILL.md", SILTPOKE_HOST: "codex" }),
      { errexit: true },
    );
    expect(exitCode).toBe(0);
    expect(stdout).toBe(agyRoot);
  });

  test("SILTPOKE_HOST=claude (not agy) keeps codex first", () => {
    expect(runSnippet(env({ SILTPOKE_HOST: "claude" })).stdout).toBe(codexRoot);
  });

  test("env-var override still wins over everything", () => {
    expect(
      runSnippet(env({ SILTPOKE_HOST: "codex", ANTIGRAVITY_PLUGIN_ROOT: agyRoot })).stdout,
    ).toBe(agyRoot);
  });
});
