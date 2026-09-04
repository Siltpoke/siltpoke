// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
// Copyright (c) 2026 Jiaqi Duan
//
// The configure kernel's INPUT layer (src/cli/configure-input.ts): how the four
// pet answers get in, and what makes one legal.
//
// Two defenses live here, and both replace a defense that used to be PROSE in
// .claude-plugin/commands/siltpoke-setup.md — i.e. an instruction to the model,
// which is not a mechanism:
//   1. --answers-file — no user text ever reaches a shell (injection).
//   2. validateOptions — an unknown species/personality is refused, not silently
//      swapped for a default (the "wrong pet" failure).
// The kernel's WRITES are covered in configure.test.ts.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  answersFilePath,
  configure,
  parseArgs,
  readAnswersFile,
} from "../../src/cli/configure";

let home: string;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "siltpoke-conf-in-"));
});
afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

/** Never let a test reach the real launchctl/systemctl. */
const noAutostart = {
  installAutostart: async () => ({ status: "skipped" as const, platform: "test" }),
};

describe("configure input — validation + --answers-file", () => {
  // Both lookups downstream are `TABLE[key] ?? DEFAULT`, so a typo used to be
  // SILENT: the user got a different pet than the one they picked. Fail loudly,
  // and fail before anything is written.
  test("an unknown personality is REJECTED, naming the valid ones, and writes nothing", async () => {
    await expect(
      configure(
        parseArgs(["--name", "S", "--species", "owl", "--lang", "en", "--personality", "banana"]),
        home,
        noAutostart,
      ),
    ).rejects.toThrow(/unknown personality "banana".*sassy, gentle, deadpan, cheerful, rigorous, quiet/s);
    expect(existsSync(join(home, ".siltpoke", "config.json"))).toBe(false);
  });

  test("an unknown species is REJECTED, naming the valid ones, and writes nothing", async () => {
    await expect(
      configure(
        parseArgs(["--name", "S", "--species", "octopus", "--lang", "en", "--personality", "sassy"]),
        home,
        noAutostart,
      ),
    ).rejects.toThrow(/unknown species "octopus".*slime, cat, owl, robot, bunny/s);
    expect(existsSync(join(home, ".siltpoke", "config.json"))).toBe(false);
  });

  test("every advertised species and personality is accepted", async () => {
    for (const species of ["slime", "cat", "owl", "robot", "bunny"]) {
      for (const personality of ["sassy", "gentle", "deadpan", "cheerful", "rigorous", "quiet"]) {
        await configure(
          parseArgs(["--name", "S", "--species", species, "--lang", "en", "--personality", personality]),
          home,
          noAutostart,
        );
      }
    }
    const cfg = JSON.parse(readFileSync(join(home, ".siltpoke", "config.json"), "utf8"));
    expect(cfg.species).toBe("bunny");
    expect(cfg.personality).toBe("quiet");
  });

  test("a nameless pet is rejected", async () => {
    await expect(
      configure(
        parseArgs(["--name", "  ", "--species", "cat", "--lang", "en", "--personality", "sassy"]),
        home,
        noAutostart,
      ),
    ).rejects.toThrow(/missing --name/);
  });

  // --answers-file: the shell-injection defense. /siltpoke-setup writes the four
  // answers with the Write tool (no shell) and passes ONE fixed path, so no user
  // byte is ever interpolated into a command line.
  test("--answers-file takes the pet from JSON; shell metacharacters stay LITERAL", async () => {
    const evil = '"; touch /tmp/pwned; #';
    const backticks = "`touch /tmp/pwned2`$(touch /tmp/pwned3)";
    const answers = join(home, ".siltpoke", ".setup-answers.json");
    mkdirSync(join(home, ".siltpoke"), { recursive: true });
    writeFileSync(
      answers,
      JSON.stringify({
        name: evil,
        species: "cat",
        lang: backticks,
        personality: "sassy",
      }),
    );
    await configure(await readAnswersFile(answers), home, noAutostart);
    const cfg = JSON.parse(readFileSync(join(home, ".siltpoke", "config.json"), "utf8"));
    // Stored verbatim, character for character — never executed, never mangled.
    expect(cfg.name).toBe(evil);
    expect(cfg.language).toBe(backticks);
    expect(existsSync("/tmp/pwned")).toBe(false);
    expect(existsSync("/tmp/pwned2")).toBe(false);
    expect(existsSync("/tmp/pwned3")).toBe(false);
  });

  // --- raw dials: the conversational setup's custom/random/quiz payload ---
  test("explicit dials are written VERBATIM, not a preset's numbers", async () => {
    const answers = join(home, "a.json");
    // No `personality` at all — the conversational path sends only dials.
    writeFileSync(
      answers,
      JSON.stringify({
        name: "Custompet",
        species: "owl",
        lang: "en",
        dials: { snark: 8, patience: 1, rigor: 9, chattiness: 2, curiosity: 10 },
      }),
    );
    await configure(await readAnswersFile(answers), home, noAutostart);
    const cfg = JSON.parse(readFileSync(join(home, ".siltpoke", "config.json"), "utf8"));
    expect(cfg.snark).toBe(8);
    expect(cfg.patience).toBe(1);
    expect(cfg.rigor).toBe(9);
    expect(cfg.chattiness).toBe(2);
    expect(cfg.curiosity).toBe(10);
    // owl's preset/profile would NOT be snark=8,patience=1 — proves dials, not a fallback.
    expect(cfg.personality).toBe("custom");
  });

  test("dials WIN over a preset name when both are present", async () => {
    const answers = join(home, "a.json");
    writeFileSync(
      answers,
      JSON.stringify({
        name: "S",
        species: "cat",
        lang: "en",
        personality: "gentle", // gentle = snark:1 — dials must override
        dials: { snark: 7, patience: 4, rigor: 5, chattiness: 6, curiosity: 3 },
      }),
    );
    await configure(await readAnswersFile(answers), home, noAutostart);
    const cfg = JSON.parse(readFileSync(join(home, ".siltpoke", "config.json"), "utf8"));
    expect(cfg.snark).toBe(7); // dials, not gentle's 1
    expect(cfg.personality).toBe("gentle");
  });

  test("an out-of-range dial is REJECTED and writes nothing", async () => {
    const answers = join(home, "a.json");
    writeFileSync(
      answers,
      JSON.stringify({
        name: "S",
        species: "cat",
        lang: "en",
        dials: { snark: 11, patience: 5, rigor: 5, chattiness: 5, curiosity: 5 },
      }),
    );
    await expect(configure(await readAnswersFile(answers), home, noAutostart)).rejects.toThrow(
      /dial "snark" must be an integer 0\.\.10/,
    );
    expect(existsSync(join(home, ".siltpoke", "config.json"))).toBe(false);
  });

  test("a non-integer / non-number dial is REJECTED", async () => {
    const answers = join(home, "a.json");
    writeFileSync(
      answers,
      JSON.stringify({
        name: "S",
        species: "cat",
        lang: "en",
        dials: { snark: 5.5, patience: 5, rigor: 5, chattiness: 5, curiosity: 5 },
      }),
    );
    await expect(configure(await readAnswersFile(answers), home, noAutostart)).rejects.toThrow(
      /dial "snark" must be an integer/,
    );
    // A string sneaking through the JSON is caught too.
    writeFileSync(
      answers,
      JSON.stringify({
        name: "S",
        species: "cat",
        lang: "en",
        dials: { snark: 5, patience: 5, rigor: 5, chattiness: 5, curiosity: "9" },
      }),
    );
    await expect(configure(await readAnswersFile(answers), home, noAutostart)).rejects.toThrow(
      /dial "curiosity" must be an integer/,
    );
  });

  test("species stays validated even in dials mode; an unknown one is rejected", async () => {
    const answers = join(home, "a.json");
    writeFileSync(
      answers,
      JSON.stringify({
        name: "S",
        species: "dragon",
        lang: "en",
        dials: { snark: 5, patience: 5, rigor: 5, chattiness: 5, curiosity: 5 },
      }),
    );
    await expect(configure(await readAnswersFile(answers), home, noAutostart)).rejects.toThrow(
      /unknown species "dragon"/,
    );
  });

  test("a language beyond en/zh (e.g. ja) is ACCEPTED and written as-is", async () => {
    const answers = join(home, "a.json");
    writeFileSync(
      answers,
      JSON.stringify({
        name: "S",
        species: "owl",
        lang: "ja",
        dials: { snark: 5, patience: 5, rigor: 5, chattiness: 5, curiosity: 5 },
      }),
    );
    await configure(await readAnswersFile(answers), home, noAutostart);
    const cfg = JSON.parse(readFileSync(join(home, ".siltpoke", "config.json"), "utf8"));
    expect(cfg.language).toBe("ja");
  });

  test("the conversational `language` key is read (not silently dropped for `lang`)", async () => {
    // The rewritten /siltpoke-setup writes the key as `language`. The kernel must
    // accept it — reading only `lang` would land an empty speaking-language on
    // every conversational install.
    const answers = join(home, "a.json");
    writeFileSync(
      answers,
      JSON.stringify({
        name: "S",
        species: "owl",
        language: "ko",
        dials: { snark: 5, patience: 5, rigor: 5, chattiness: 5, curiosity: 5 },
      }),
    );
    await configure(await readAnswersFile(answers), home, noAutostart);
    const cfg = JSON.parse(readFileSync(join(home, ".siltpoke", "config.json"), "utf8"));
    expect(cfg.language).toBe("ko");
  });

  test("extra keys riding inside `dials` cannot clobber other config fields", async () => {
    const answers = join(home, "a.json");
    writeFileSync(
      answers,
      JSON.stringify({
        name: "RealName",
        species: "cat",
        language: "en",
        // A hostile / sloppy payload smuggling non-dial keys into the dials object.
        dials: {
          snark: 5,
          patience: 5,
          rigor: 5,
          chattiness: 5,
          curiosity: 5,
          name: "pwned",
          species: "dragon",
          schemaVersion: 999,
        },
      }),
    );
    await configure(await readAnswersFile(answers), home, noAutostart);
    const cfg = JSON.parse(readFileSync(join(home, ".siltpoke", "config.json"), "utf8"));
    expect(cfg.name).toBe("RealName"); // not "pwned"
    expect(cfg.species).toBe("cat"); // not "dragon"
    expect(cfg.schemaVersion).toBe(2); // not 999
  });

  test("an unknown language is NOT hard-rejected (expandLanguage falls through)", async () => {
    const answers = join(home, "a.json");
    writeFileSync(
      answers,
      JSON.stringify({
        name: "S",
        species: "owl",
        lang: "eo", // Esperanto — not in LANGUAGE_NAMES
        dials: { snark: 5, patience: 5, rigor: 5, chattiness: 5, curiosity: 5 },
      }),
    );
    await configure(await readAnswersFile(answers), home, noAutostart);
    const cfg = JSON.parse(readFileSync(join(home, ".siltpoke", "config.json"), "utf8"));
    expect(cfg.language).toBe("eo");
  });

  test("--answers-file still validates species/personality", async () => {
    const answers = join(home, "a.json");
    writeFileSync(
      answers,
      JSON.stringify({ name: "S", species: "dragon", lang: "en", personality: "sassy" }),
    );
    await expect(configure(await readAnswersFile(answers), home, noAutostart)).rejects.toThrow(
      /unknown species "dragon"/,
    );
  });

  test("--answers-file carries the feature toggles, and the flags still work", async () => {
    const answers = join(home, "a.json");
    const pet = { name: "S", species: "cat", lang: "en", personality: "sassy" };
    writeFileSync(answers, JSON.stringify({ ...pet, statusline: true, daemon: true }));
    const fromJson = await readAnswersFile(answers);
    expect(fromJson.statusline).toBe(true);
    expect(fromJson.daemon).toBe(true);

    writeFileSync(answers, JSON.stringify(pet));
    const fromFlags = await readAnswersFile(answers, ["--statusline", "--daemon"]);
    expect(fromFlags.statusline).toBe(true);
    expect(fromFlags.daemon).toBe(true);

    expect((await readAnswersFile(answers)).statusline).toBe(false);
  });

  test("--answers-file: unreadable / non-JSON / non-object all fail loudly", async () => {
    await expect(readAnswersFile(join(home, "nope.json"))).rejects.toThrow(/cannot read/);
    const bad = join(home, "bad.json");
    writeFileSync(bad, "{not json");
    await expect(readAnswersFile(bad)).rejects.toThrow(/not valid JSON/);
    writeFileSync(bad, "[1,2]");
    await expect(readAnswersFile(bad)).rejects.toThrow(/must contain a JSON object/);
  });

  test("answersFilePath reads the flag, null when absent", () => {
    expect(answersFilePath(["--answers-file", "/x/y.json"])).toBe("/x/y.json");
    expect(answersFilePath(["--name", "S"])).toBeNull();
  });
});
