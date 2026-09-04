// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
// Copyright (c) 2026 Jiaqi Duan
import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { PLUGIN_COMMANDS } from "../../src/cli/plugin-help";

const COMMANDS_DIR = ".claude-plugin/commands";
const setup = readFileSync(join(COMMANDS_DIR, "siltpoke-setup.md"), "utf8");

const commandFiles = readdirSync(COMMANDS_DIR).filter((f) => f.endsWith(".md"));
const commandSources = commandFiles.map((f) => ({
  file: f,
  body: readFileSync(join(COMMANDS_DIR, f), "utf8"),
}));

/**
 * REGRESSION GUARD — this is the bug the whole 8-command cull exists to kill.
 *
 * `/plugin install` is pure file placement: no installer runs, so nothing
 * rewrites paths, and the cache has no `node_modules`. Before this guard, 34 of
 * 37 command files hardcoded `bun /Users/<author>/…/src/cli/<x>.ts` — a path
 * that exists on exactly one machine on earth, invoking TypeScript that could
 * not resolve its imports even if the path did exist. The entire command
 * surface was dead in a plugin install and nothing was checking.
 *
 * Every `bun` invocation in a command file must therefore go through
 * `${CLAUDE_PLUGIN_ROOT}` and land on a built `dist/*.js` bundle.
 */
describe("plugin command files carry no machine-specific paths", () => {
  test.each(commandSources)("$file has no home-directory path", ({ body }) => {
    expect(body).not.toContain("/Users/");
    expect(body).not.toContain("/home/");
    expect(body).not.toMatch(/\/opt\/homebrew\//);
    expect(body).not.toMatch(/[A-Za-z]:\\/); // Windows drive path, e.g. C:\Users
  });

  test.each(commandSources)("$file contains no bare absolute path to a script", ({ body }) => {
    // The real bug was a hardcoded absolute path to a `.ts`/`.js` file. Catch
    // ANY absolute path to a script anywhere in the prose — not just the three
    // author-machine prefixes above — UNLESS it is rooted at ${CLAUDE_PLUGIN_ROOT}.
    // Strip the one legitimate shape first, then any leftover `/…/x.(ts|js)` is a leak.
    const stripped = body.replaceAll(/\$\{CLAUDE_PLUGIN_ROOT}[^\s"']*/g, "");
    const absScript = stripped.match(/(?:^|[\s"'(])(\/[\w./-]+\.(?:ts|js|cjs|mjs))\b/m);
    expect(absScript?.[1] ?? null).toBeNull();
  });

  test.each(commandSources)("$file never invokes source TypeScript", ({ body }) => {
    // `bun src/cli/foo.ts` (or any `src/`-relative bun call) only resolves in
    // the dev checkout — the plugin cache ships `dist/`, not `src/`.
    expect(body).not.toMatch(/\bbun\s+\S*src\//);
    expect(body).not.toMatch(/\bbun\s+run\s+\w/);
  });

  test.each(commandSources)("$file routes every bun call through the plugin root", ({ body }) => {
    // Non-anchored: a `bun …` mid-sentence (in prose, not a fence) is caught
    // too — the original line-anchored scan let a rogue call in prose slip by.
    const bunCalls = [...body.matchAll(/\bbun[ \t]+([^\n]+)/g)].map((m) => m[1] ?? "");
    expect(bunCalls.length).toBeGreaterThan(0);
    for (const call of bunCalls) {
      expect(call).toContain(`$\{CLAUDE_PLUGIN_ROOT}`);
      expect(call).toMatch(/\/dist\/siltpoke-[a-z-]+\.js/);
    }
  });
});

describe("the shipped command surface is exactly the 10 core commands", () => {
  test("the .md files on disk match the manual's list, both ways", () => {
    const onDisk = commandFiles.map((f) => `/${f.replace(/\.md$/, "")}`).sort();
    const advertised = PLUGIN_COMMANDS.map((c) => c.name).sort();
    expect(onDisk).toEqual(advertised);
    expect(onDisk).toHaveLength(10);
  });

  test("the culled commands are gone from the plugin (their src/cli code stays)", () => {
    for (const gone of ["siltpoke-inbox", "siltpoke-forward", "siltpoke-dismiss", "siltpoke-pet", "siltpoke-explain"]) {
      expect(commandFiles).not.toContain(`${gone}.md`);
    }
  });
});

describe("/siltpoke-setup command", () => {
  test("is CONVERSATIONAL, not AskUserQuestion cards — the cards gutted the wizard's range", () => {
    // The whole point of this rewrite: the model runs the wizard in prose so it
    // can offer all 5 species / 8 languages / a real random-name roll / 4
    // personality modes — none of which fit AskUserQuestion's 4-option cards.
    expect(setup).not.toContain("AskUserQuestion");
    // A terminal wizard would still hang (no TTY) — the command must say so.
    expect(setup.toLowerCase()).toContain("no interactive tty");
  });

  test("calls the configure kernel through the plugin root, via the answers file", () => {
    expect(setup).toContain(`"$\{CLAUDE_PLUGIN_ROOT}/dist/siltpoke-configure.js"`);
    expect(setup).toContain("--answers-file");
    expect(setup).toContain(".setup-answers.json");
  });

  test("offers an express fast-path that defaults every field and reuses the configure kernel", () => {
    // The express (秒装) path: one confirmation → slime + species-default (no
    // dials) + inferred language + one auto-rolled name → same answers-file →
    // same configure kernel. It must NOT introduce a new kernel surface, and
    // must NOT remove the rich path (asserted by the other tests in this block).
    expect(setup.toLowerCase()).toContain("express");
    expect(setup).toContain("秒装");
    // Express defaults the species to slime and omits dials (species-default).
    expect(setup.toLowerCase()).toContain("slime");
    // Express still routes through the one configure mechanism (no new surface).
    expect(setup).toContain(`"$\{CLAUDE_PLUGIN_ROOT}/dist/siltpoke-configure.js"`);
  });

  test("does NOT force daemon autostart — daemon is opt-in per #329 (default off)", () => {
    // The answers-file the command tells the model to write drives
    // configure.ts `if (opts.daemon) installAutostartForPlatform()`. #329 made
    // the daemon opt-in (core review runs in the Stop hook; the daemon only
    // powers the dashboard/chat/index web surfaces, started on demand by
    // `/siltpoke-dashboard`). So this command MUST NOT ship `"daemon": true`,
    // or every plugin user silently gets a launchd/systemd unit installed —
    // exactly the reboot-ECONNREFUSED friction #329 removed from `bun run setup`
    // but which had never reached the plugin path.
    expect(setup).not.toContain(`"daemon": true`);
    expect(setup).toContain(`"daemon": false`);
  });

  test("presents every real species — all 5, not a 3-option subset", () => {
    for (const species of ["slime", "cat", "owl", "robot", "bunny"]) {
      expect(setup).toContain(species);
    }
    // Fabricated species from the old brief's wrong example must NOT appear.
    for (const bogus of ["octopus", "mushroom"]) {
      expect(setup.toLowerCase()).not.toContain(bogus);
    }
  });

  test("presents every speaking language — all 8, not just en/zh", () => {
    for (const lang of ["en", "zh-CN", "zh-TW", "ja", "ko", "es", "fr", "de"]) {
      expect(setup).toContain(lang);
    }
  });

  test("offers a REAL random-name roll via the plugin-cli subcommand", () => {
    expect(setup).toContain("random-name");
    // routed through the plugin root, like every other bun call.
    expect(setup).toContain(`"$\{CLAUDE_PLUGIN_ROOT}/dist/siltpoke-cli.js" random-name`);
  });

  test("offers all FIVE personality modes and the five dials", () => {
    // Five modes now: the species-default (per-species profile, NOT flat 5/10),
    // customize, random, quiz, AND read-my-memory (reads ~/.claude to calibrate).
    for (const mode of ["Species default", "Customize", "Random", "Quiz", "Read my memory"]) {
      expect(setup).toContain(mode);
    }
    for (const dial of ["snark", "patience", "rigor", "chattiness", "curiosity"]) {
      expect(setup).toContain(dial);
    }
  });

  test("the species-default mode is per-species, NOT a flat 5/10 label", () => {
    // The bug: mode (a) used to claim "all five at 5/10". That is only true for
    // slime; every other species has its own profile the kernel fills in when no
    // dials are sent. The .md must say so and must NOT relabel it as 5/10-neutral.
    expect(setup).toContain("Species default");
    expect(setup.toLowerCase()).toContain("this species' own default");
    // No lingering "all five at 5/10"-style neutral-default claim.
    expect(setup).not.toContain("all five at 5/10");
  });

  test("the read-my-memory mode names the ~/.claude sources it reads", () => {
    expect(setup).toContain("Read my memory");
    expect(setup).toContain("~/.claude/CLAUDE.md");
    expect(setup).toContain("~/.claude/rules/");
    expect(setup).toContain("~/.claude/memory/");
  });

  test("writes `dials` (five numbers), NOT a `personality` preset name", () => {
    // The answers JSON carries the personality as five dials now.
    expect(setup).toContain(`"dials"`);
    // ...and NOT as a `"personality"` preset key (the kernel would validate a
    // preset name; the conversational path sends raw numbers instead).
    expect(setup).not.toContain(`"personality"`);
    // The example JSON must carry all five dial keys as JSON fields.
    for (const dial of ["snark", "patience", "rigor", "chattiness", "curiosity"]) {
      expect(setup).toContain(`"${dial}"`);
    }
  });

  test("the quiz asks the 5 Likert statements verbatim + all 3 finale scenarios", () => {
    // The owner caught the quiz being paraphrased/watered-down. These are the
    // exact texts from QUIZ_LIKERT_ITEMS / QUIZ_FINALES in personality-seed.ts.
    // v5: NON-TECHNICAL — general personality, never code/tools/reviews.
    for (const stmt of [
      "I'd rather someone be honest with me than spare my feelings.",
      "When someone makes the same mistake twice, I stay calm about it.",
      "I like to double-check my work before I call it done.",
      "I enjoy a good long conversation more than a quick exchange.",
      "I like to explore a few different options before I decide.",
    ]) {
      expect(setup).toContain(stmt);
    }
    // Finale scenario prompts (all three) + their option texts.
    for (const scenario of [
      "A friend points out you slipped up. You'd rather they:",
      "You're telling someone a story. You tend to:",
      "Faced with a choice, you usually:",
    ]) {
      expect(setup).toContain(scenario);
    }
    for (const opt of [
      "Tease you about it with a grin",
      "Gently talk you through it",
      "Walk you through every step so it won't happen again",
      "Just let it go",
      "Give them the quick version",
      "Tell the whole thing with every detail",
      "Go with the first good option",
      "Explore a few alternatives first",
    ]) {
      expect(setup).toContain(opt);
    }
  });

  test("the quiz statements use NO code/tool words (non-technical audience)", () => {
    // The owner targets non-technical end users, so the quiz must never mention
    // code, tools, builds, bugs, or reviews. Scope the check to the quiz block.
    const start = setup.indexOf("agree↔disagree statements");
    const end = setup.indexOf("Now compute the dials");
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    const quizBlock = setup.slice(start, end).toLowerCase();
    for (const banned of [
      "code review",
      "a tool",
      "the tool",
      "build breaks",
      "finds a bug",
      "file:line",
      "standup",
    ]) {
      expect(quizBlock).not.toContain(banned);
    }
  });

  test("the quiz asks the mirror/complement/hybrid match-mode question + passes --match-mode", () => {
    // The original wizard asked how the pet should relate to the user; the
    // conversational path had dropped it. It must be restored (quiz mode only).
    expect(setup).toContain("relate to YOUR personality");
    for (const mode of ["mirror", "complement", "hybrid"]) {
      expect(setup).toContain(mode);
    }
    expect(setup).toContain("--match-mode");
  });

  test("the quiz scores dials via the real scorer, not a model guess", () => {
    // The dials must come back from quiz-score (which calls scoreQuiz), and the
    // .md must tell the model NOT to pick them itself.
    expect(setup).toContain(`"$\{CLAUDE_PLUGIN_ROOT}/dist/siltpoke-cli.js" quiz-score`);
    expect(setup).toContain("--answers");
    // One-at-a-time is preserved (collapse markdown line-wrap first).
    expect(setup.toLowerCase().replace(/\s+/g, " ")).toContain("one question at a time");
  });

  test("tells the user where the things setup does NOT do live", () => {
    // The local-model (Ollama) path is the remaining "not part of setup"
    // capability; /siltpoke-menubar was cut entirely in the 37→8 cull.
    expect(setup.toLowerCase()).toContain("ollama");
  });

  test("spells out plainly that reviews run on the existing claude CLI by default", () => {
    expect(setup).toContain("claude` CLI by default");
  });

  // The injection defense is STRUCTURAL, not prose: name / species / language
  // are user text, so none may reach a shell. The model writes them with the
  // Write tool — no shell — and the ONE command that runs the kernel carries a
  // single fixed path with zero user data.
  test("no user answer is ever interpolated into the kernel invocation", () => {
    // Isolate the configure invocation itself (the only command carrying pet
    // data risk) — the random-name fence legitimately takes a fixed species arg.
    const configureLine = setup
      .split("\n")
      .find((l) => l.includes("siltpoke-configure.js"));
    expect(configureLine).toBeDefined();
    for (const flag of ["--name", "--species", "--lang", "--personality"]) {
      expect(configureLine).not.toContain(flag);
    }
    // The answers file is written by the model, not the shell.
    expect(setup).toContain("Write tool");
  });

  test("enumerates the failure modes the kernel can emit", () => {
    expect(setup).toContain("unknown species");
    expect(setup).toContain('dial "'); // the new dial-range failure mode
    expect(setup).toContain("command not found: bun");
    expect(setup).toContain("not valid JSON");
    expect(setup).toContain("EACCES");
  });
});
