// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
// Copyright (c) 2026 Jiaqi Duan
/**
 * Tests for src/cli/plugin-cli.ts — the bundled multiplexer every non-setup
 * slash command shells out to. These exercise the router directly (the .md
 * regression guard in tests/plugin/commands.test.ts only checks the command
 * files statically; it never proves the dispatcher itself works).
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runPluginCli, type CliIo } from "../../src/cli/plugin-cli";
import {
  type QuizAnswers,
  scoreQuiz,
} from "../../src/installer/personality-seed";

/** Collects stdout/stderr so a test can assert on what the user would see. */
function captureIo(): { io: CliIo; out: () => string; err: () => string } {
  let out = "";
  let err = "";
  return {
    io: { stdout: (s) => (out += s), stderr: (s) => (err += s) },
    out: () => out,
    err: () => err,
  };
}

describe("plugin-cli dispatcher", () => {
  const originalCwd = process.cwd();
  let projectDir: string;
  let home: string;

  beforeEach(() => {
    projectDir = mkdtempSync(join(tmpdir(), "siltpoke-plugincli-proj-"));
    home = mkdtempSync(join(tmpdir(), "siltpoke-plugincli-home-"));
    // mute/unmute write under ~/.siltpoke — point HOME at a scratch dir so the
    // real one is never touched.
    process.env.SILTPOKE_HOME = join(home, ".siltpoke");
    mkdirSync(process.env.SILTPOKE_HOME, { recursive: true });
    process.chdir(projectDir);
  });

  afterEach(() => {
    process.chdir(originalCwd);
    delete process.env.SILTPOKE_HOME;
    rmSync(projectDir, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  });

  test("help lists all 9 commands and exits 0", async () => {
    const c = captureIo();
    const code = await runPluginCli(["help"], c.io);
    expect(code).toBe(0);
    for (const cmd of [
      "/siltpoke-setup",
      "/siltpoke-last",
      "/siltpoke-dashboard",
      "/siltpoke-restart-daemon",
      "/siltpoke-menubar",
      "/siltpoke-mute",
      "/siltpoke-unmute",
      "/siltpoke-doctor",
      "/siltpoke-help",
    ]) {
      expect(c.out()).toContain(cmd);
    }
  });

  test("menubar subcommand routes through the handler (status is safe, read-only)", async () => {
    // Exercises the plugin-cli `menubar` HANDLERS entry (resolveCardPath wiring
    // + io shim), not just runMenubarCli directly. `status` never writes/execs.
    const c = captureIo();
    const code = await runPluginCli(["menubar", "status"], c.io);
    expect(code).toBe(0);
    expect(c.out()).toContain("menu-bar pet");
  });

  test("random-name prints one generated name; a species biases the pool", async () => {
    const c = captureIo();
    expect(await runPluginCli(["random-name"], c.io)).toBe(0);
    const generic = c.out().trim();
    // Sentence-cased single word, no shell/JSON junk, non-empty.
    expect(generic).toMatch(/^[A-Z][A-Za-z]+$/);

    // A couple of real species — each still yields a plausible single-word name.
    for (const species of ["cat", "robot"]) {
      const s = captureIo();
      expect(await runPluginCli(["random-name", species], s.io)).toBe(0);
      expect(s.out().trim()).toMatch(/^[A-Z][A-Za-z]+$/);
    }
  });

  test("no args defaults to help", async () => {
    const c = captureIo();
    expect(await runPluginCli([], c.io)).toBe(0);
    expect(c.out()).toContain("Siltpoke");
  });

  test("unknown subcommand prints usage and exits 2", async () => {
    const c = captureIo();
    const code = await runPluginCli(["bogus"], c.io);
    expect(code).toBe(2);
    expect(c.err()).toContain("unknown subcommand: bogus");
    expect(c.err()).toContain("usage:");
  });

  test("last reads the project's latest critique from cwd/.siltpoke", async () => {
    mkdirSync(join(projectDir, ".siltpoke", "critiques"), { recursive: true });
    writeFileSync(join(projectDir, ".siltpoke", "critiques", "latest.md"), "# Review\n- off-by-one\n");
    const c = captureIo();
    expect(await runPluginCli(["last"], c.io)).toBe(0);
    expect(c.out()).toContain("off-by-one");
  });

  test("last on an empty project reports not-found, still exit 0", async () => {
    const c = captureIo();
    expect(await runPluginCli(["last"], c.io)).toBe(0);
    expect(c.out().toLowerCase()).toContain("not found");
  });

  test("mute writes the marker; unmute clears it", async () => {
    const m = captureIo();
    expect(await runPluginCli(["mute", "15m"], m.io)).toBe(0);
    expect(m.out()).toContain("muted");

    const u = captureIo();
    expect(await runPluginCli(["unmute"], u.io)).toBe(0);
    expect(u.out()).toContain("unmuted");
  });

  test("mute with no duration is a usage error (exit 1 on stderr)", async () => {
    const c = captureIo();
    const code = await runPluginCli(["mute"], c.io);
    expect(code).toBe(1);
    expect(c.err()).toContain("siltpoke-mute");
  });

  test("mute --json emits JSON", async () => {
    const c = captureIo();
    expect(await runPluginCli(["mute", "1h", "--json"], c.io)).toBe(0);
    expect(() => JSON.parse(c.out())).not.toThrow();
  });

  test("quiz-score scores a known answer set to exactly what scoreQuiz produces", async () => {
    // Same answers, two ways: through the subcommand, and via scoreQuiz directly.
    const scores = [5, 4, 3, 2, 1];
    const finales = ["a", "a", "a"] as const;
    const answers: QuizAnswers = {
      likert: scores.map((score, itemIndex) => ({ itemIndex, score: score as 1 | 2 | 3 | 4 | 5 })),
      finales: [...finales],
    };
    const expected = scoreQuiz(answers, "mirror");

    const c = captureIo();
    const code = await runPluginCli(
      ["quiz-score", "--answers", JSON.stringify({ scores, finales })],
      c.io,
    );
    expect(code).toBe(0);
    expect(JSON.parse(c.out())).toEqual(expected);
    // Every dial clamped to 0-10.
    for (const v of Object.values(expected)) {
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThanOrEqual(10);
    }
  });

  test("quiz-score honors --match-mode (complement differs from mirror here)", async () => {
    const scores = [5, 4, 3, 2, 1];
    const finales = ["c", "a", "a"] as const;
    const answers: QuizAnswers = {
      likert: scores.map((score, itemIndex) => ({ itemIndex, score: score as 1 | 2 | 3 | 4 | 5 })),
      finales: [...finales],
    };
    const c = captureIo();
    expect(
      await runPluginCli(
        ["quiz-score", "--answers", JSON.stringify({ scores, finales }), "--match-mode", "complement"],
        c.io,
      ),
    ).toBe(0);
    expect(JSON.parse(c.out())).toEqual(scoreQuiz(answers, "complement"));
  });

  test("quiz-score rejects out-of-range scores with a clear error, no dials, exit 1", async () => {
    const c = captureIo();
    const code = await runPluginCli(
      ["quiz-score", "--answers", JSON.stringify({ scores: [5, 4, 3, 2, 9], finales: ["a", "a", "a"] })],
      c.io,
    );
    expect(code).toBe(1);
    expect(c.err()).toContain("must be an integer 1-5");
    expect(c.out()).toBe(""); // never prints partial dials
  });

  test("quiz-score rejects a bad finale letter (invalid for that scenario)", async () => {
    // Scenario 2 only has options a/b — 'c' is out of range for it.
    const c = captureIo();
    const code = await runPluginCli(
      ["quiz-score", "--answers", JSON.stringify({ scores: [5, 4, 3, 2, 1], finales: ["a", "c", "a"] })],
      c.io,
    );
    expect(code).toBe(1);
    expect(c.err()).toContain("finale #2");
    expect(c.out()).toBe("");
  });

  test("quiz-score rejects wrong number of finales, wrong number of scores, and non-JSON", async () => {
    const badFinales = captureIo();
    expect(
      await runPluginCli(
        ["quiz-score", "--answers", JSON.stringify({ scores: [5, 4, 3, 2, 1], finales: ["a"] })],
        badFinales.io,
      ),
    ).toBe(1);
    expect(badFinales.err()).toContain("finales");

    const short = captureIo();
    expect(
      await runPluginCli(["quiz-score", "--answers", JSON.stringify({ scores: [5, 4, 3], finales: ["a", "a", "a"] })], short.io),
    ).toBe(1);
    expect(short.err()).toContain("exactly 5");

    const junk = captureIo();
    expect(await runPluginCli(["quiz-score", "--answers", "not json"], junk.io)).toBe(1);
    expect(junk.err().toLowerCase()).toContain("valid json");
  });

  // NB: `dashboard` / `restart-daemon` are deliberately NOT exercised here —
  // their handlers reach the real daemon pidfile under the actual home dir (no
  // injection seam), so a test could SIGTERM a daemon the developer is running.
  // Their proof is the end-to-end run from a copied plugin cache (task 6b report).
});
