// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
// Copyright (c) 2026 Jiaqi Duan
//
// `docs/install-prompts/*.md` teach a brand-new user what to type. They ship
// publicly (since #814), and a coding agent follows them literally — so a
// command named there that does not exist fails in the user's face on their
// first day, and reads as a broken product rather than a stale document.
//
// SCOPE — deliberately ONE direction: every command the prompts NAME must
// exist. The reverse ("every shipped command must be taught") is NOT asserted,
// and that is a decision, not an omission: the prompts are a curated first-day
// walkthrough, and PLC alone ships 14 commands. Teaching all of them would
// drown the reader and would red this test every time PLC grows one.
//
// The asymmetry follows the harm. Naming a command that does not exist makes a
// user run something that fails; omitting one costs them a feature they never
// knew about. Only the first is a defect.
import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = process.cwd();
const PROMPT_DIR = join(ROOT, "docs", "install-prompts");
const SILTPOKE_COMMAND_DIR = join(ROOT, ".claude-plugin", "commands");

/**
 * Commands the HOST owns, not this repo and not PLC. The prompts name these on
 * purpose (`/plugin marketplace add …` is how CodeBuddy and Qoder install), and
 * nothing here can verify them — they live in someone else's product.
 */
const HOST_BUILTINS = new Set(["/plugin", "/plugins", "/reload-plugins", "/config", "/resume"]);

/**
 * project-life-cycle's published commands, as `commands/` holds them in the
 * PUBLIC repo at v4.0.0 (read 2026-09-23 via the contents API).
 *
 * This list is a declaration, not a verification: PLC is a separate repository,
 * so nothing in this test run can reach its real command set. What the list DOES
 * buy is a single place to check when PLC cuts a release, instead of five prose
 * files to re-read — and it still catches a typo or an invented command name in
 * a prompt today, which is the failure that actually reaches a user.
 *
 * ⚠️ When PLC publishes a release, re-read its `commands/` and update this.
 * `docs/public-release/PUBLISH-CHECKLIST.md` carries that as a step.
 */
const PLC_COMMANDS = new Set([
  "builder-profile",
  "capture",
  "catchup",
  "cognition-distill",
  "handoff",
  "init-harness",
  "plc-status",
  "recall",
  "reconcile",
  "release",
  "research",
  "review",
  "ship",
  "tasklist",
]);

/**
 * Slash commands named in a prompt file.
 *
 * Only backticked tokens count. Bare `/…` text is almost always part of a path
 * or a URL — a first pass over these same files netted `/bin`, `/dist`,
 * `/github` and `/null` out of `~/.bun/bin/bun` and `https://github.com/…`.
 *
 * A trailing hyphen is dropped: the prompts write `/siltpoke-…` as prose for
 * "any of them", and a real command name never ends in `-`.
 */
function commandsNamedIn(markdown: string): string[] {
  const found = new Set<string>();
  for (const m of markdown.matchAll(/`(\/[a-z][a-z0-9-]*(?::[a-z0-9-]+)?)/g)) {
    const token = m[1];
    if (token.endsWith("-")) continue;
    found.add(token);
  }
  return [...found].sort();
}

const promptFiles = readdirSync(PROMPT_DIR).filter((f) => f.endsWith(".md"));
const shippedSiltpokeCommands = new Set(
  readdirSync(SILTPOKE_COMMAND_DIR)
    .filter((f) => f.endsWith(".md"))
    .map((f) => f.replace(/\.md$/, "")),
);

describe("install prompts — every command they name exists", () => {
  // Without this, a regex that matched nothing would make every assertion below
  // pass over an empty set and print exactly like a healthy run.
  test("the fixtures are non-empty and the extractor actually extracts", () => {
    expect(promptFiles.length).toBeGreaterThanOrEqual(5);
    expect(shippedSiltpokeCommands.size).toBeGreaterThanOrEqual(5);
    expect(shippedSiltpokeCommands.has("siltpoke-doctor")).toBe(true);

    // Every prompt names at least one command — if the extractor silently
    // stopped working, this is the assertion that notices.
    for (const file of promptFiles) {
      const named = commandsNamedIn(readFileSync(join(PROMPT_DIR, file), "utf8"));
      expect(named.length).toBeGreaterThan(0);
    }

    // NOT per-file: `antigravity.md` and `codex.md` name exactly one command
    // between them (`/init-harness`) because those hosts do not expose slash
    // commands the same way — their prompts teach sentences instead ("say
    // 'show me the latest Siltpoke review'"). An earlier draft of this test
    // asserted every file names a `/siltpoke-*`, and it went red on those two:
    // the assumption was wrong, not the docs. Checked at the union instead.
    const union = new Set(
      promptFiles.flatMap((f) => commandsNamedIn(readFileSync(join(PROMPT_DIR, f), "utf8"))),
    );
    expect([...union].filter((c) => c.startsWith("/siltpoke-")).length).toBeGreaterThanOrEqual(5);
  });

  test("the extractor rejects paths and URLs, and keeps real commands", () => {
    const sample =
      "Run `~/.bun/bin/bun` and open `https://github.com/Siltpoke/siltpoke`,\n" +
      "then type `/siltpoke-doctor` and `/project-lifecycle:ship`, any `/siltpoke-…` works.";
    expect(commandsNamedIn(sample)).toEqual(["/project-lifecycle:ship", "/siltpoke-doctor"]);
  });

  for (const file of promptFiles) {
    test(`${file} names only commands that exist`, () => {
      const named = commandsNamedIn(readFileSync(join(PROMPT_DIR, file), "utf8"));
      const unknown: string[] = [];

      for (const token of named) {
        if (HOST_BUILTINS.has(token)) continue;
        const bare = token.slice(1).replace(/^project-lifecycle:/, "");
        if (bare.startsWith("siltpoke-")) {
          if (!shippedSiltpokeCommands.has(bare)) unknown.push(`${token} (no .claude-plugin/commands/${bare}.md)`);
          continue;
        }
        if (!PLC_COMMANDS.has(bare)) unknown.push(`${token} (not a PLC command, not a host builtin)`);
      }

      expect(unknown).toEqual([]);
    });
  }
});
