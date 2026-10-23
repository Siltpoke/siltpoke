// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
// Copyright (c) 2026 Jiaqi Duan
//
// Which coding agent one dashboard chat message goes to. Defect [49] step 2,
// revised by spec 2026-10-13-agent-in-use-truth §11.1 (the maintainer 2026-10-14):
// chat no longer follows "the agent used last" — that record is global and
// time-ordered, so with two agents open it can name the wrong one.
//
//   1. the user chose one for chat (`brain.roles.chat`)   → "chosen"
//   2. the agents installed: exactly one                  → "installed"
//                            two or more                  → ask, pick none
//                            none                         → say so
//
// `last-host` still matters in one way only: its recorded command path counts
// as an install (the autostarted daemon has a short PATH, the hook saw the
// user's real one), and supplies the folder to put in front of the child's PATH.
//
// `which` is injected everywhere: the answer must not depend on what this
// developer's machine happens to have installed.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { installedFamilies, resolveChatProvider } from "../../src/brain/chat-provider";

let home: string;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "siltpoke-chat-provider-"));
});
afterEach(() => rmSync(home, { recursive: true, force: true }));

const config = (obj: unknown) => writeFileSync(join(home, "config.json"), JSON.stringify(obj));
const lastHost = (text: string) => writeFileSync(join(home, "last-host"), text);
/** A machine where exactly these commands are on PATH. */
const installed = (...bins: string[]) => (bin: string) => (bins.includes(bin) ? `/usr/local/bin/${bin}` : null);
const nothingInstalled = installed();

describe("step 1 — the user chose one for chat", () => {
  test("the choice wins over the last-used agent and over what is installed", () => {
    config({ brain: { roles: { chat: { provider: "codex" } } } });
    lastHost("qoder\n\n");
    const r = resolveChatProvider(home, { which: installed("qodercli", "codebuddy", "codex") });
    expect(r).toEqual({ kind: "use", family: "codex", source: "chosen" });
  });

  test("a chosen claude carries the chosen model; without one, today's default", () => {
    config({ brain: { roles: { chat: { provider: "claude", model: "claude-sonnet-4-6" } } } });
    expect(resolveChatProvider(home, { which: nothingInstalled })).toEqual({
      kind: "use", family: "claude", source: "chosen", model: "claude-sonnet-4-6",
    });
    config({ brain: { roles: { chat: { provider: "claude" } } } });
    expect(resolveChatProvider(home, { which: nothingInstalled })).toEqual({
      kind: "use", family: "claude", source: "chosen", model: "claude-haiku-4-5-20251001",
    });
  });

  test("a model chosen for codex is handed to codex", () => {
    config({ brain: { roles: { chat: { provider: "codex", model: "gpt-5.6-luna" } } } });
    expect(resolveChatProvider(home, { which: nothingInstalled })).toEqual({
      kind: "use",
      family: "codex",
      source: "chosen",
      model: "gpt-5.6-luna",
    });
  });

  test("the choice is NOT quietly swapped when its command is missing", () => {
    // Spec §3.1: the failure then names this family. Falling through to another
    // agent would leave the user not knowing who answered.
    config({ brain: { roles: { chat: { provider: "agy" } } } });
    lastHost("qoder\n\n");
    const r = resolveChatProvider(home, { which: installed("qodercli") });
    expect(r).toEqual({ kind: "use", family: "agy", source: "chosen" });
  });

  test("`brain.main` alone is not a chat choice", () => {
    // The pre-[49] fallback: chat → main → claude. It is why wiring the chat
    // role alone would not have fixed the defect.
    config({ brain: { main: "codex" } });
    lastHost("qoder\n\n");
    const r = resolveChatProvider(home, { which: installed("qodercli", "codex") });
    expect(r).toEqual({ kind: "choose", found: ["codex", "qoder"] });
  });

  test("a chosen agent off PATH gets the folder last-host recorded for that same agent", () => {
    config({ brain: { roles: { chat: { provider: "qoder" } } } });
    lastHost("qoder\n/Users/x/.local/bin/qodercli\n");
    const r = resolveChatProvider(home, { which: nothingInstalled, fileExists: (p) => p === "/Users/x/.local/bin/qodercli" });
    expect(r).toEqual({ kind: "use", family: "qoder", source: "chosen", commandDir: "/Users/x/.local/bin" });
  });

  test("a chosen agent is never handed another agent's recorded folder", () => {
    config({ brain: { roles: { chat: { provider: "agy" } } } });
    lastHost("qoder\n/Users/x/.local/bin/qodercli\n");
    const r = resolveChatProvider(home, { which: nothingInstalled, fileExists: () => true });
    expect(r).toEqual({ kind: "use", family: "agy", source: "chosen" });
  });

  test.each([
    ["a provider outside the five", { brain: { roles: { chat: { provider: "gpt" } } } }],
    ["a string where the role object should be", { brain: { roles: { chat: "codex" } } }],
    ["an empty role object", { brain: { roles: { chat: {} } } }],
  ])("%s is not a choice", (_label, cfg) => {
    config(cfg);
    expect(resolveChatProvider(home, { which: installed("codebuddy") })).toEqual({
      kind: "use", family: "codebuddy", source: "installed",
    });
  });
});

describe("last-host is an install record, not a choice (§11.1)", () => {
  test("the agent used last is NOT picked when another agent is installed too", () => {
    lastHost("qoder\n/somewhere/qodercli\n");
    const r = resolveChatProvider(home, { which: installed("claude", "qodercli"), fileExists: () => false });
    expect(r).toEqual({ kind: "choose", found: ["claude", "qoder"] });
  });

  test("its recorded command, off PATH, counts as installed beside what PATH has", () => {
    lastHost("qoder\n/Users/x/.local/bin/qodercli\n");
    const r = resolveChatProvider(home, {
      which: installed("claude"),
      fileExists: (p) => p === "/Users/x/.local/bin/qodercli",
    });
    expect(r).toEqual({ kind: "choose", found: ["claude", "qoder"] });
  });

  test("the only installed agent is used, last-used or not", () => {
    lastHost("qoder\n/somewhere/qodercli\n");
    const r = resolveChatProvider(home, { which: installed("qodercli"), fileExists: () => false });
    expect(r).toEqual({ kind: "use", family: "qoder", source: "installed" });
  });

  test("no config.json at all: the one installed agent", () => {
    lastHost("codebuddy\n\n");
    expect(resolveChatProvider(home, { which: installed("codebuddy") })).toEqual({
      kind: "use", family: "codebuddy", source: "installed",
    });
  });

  test("not on the daemon's PATH, but the recorded path exists: used, with that folder", () => {
    // The autostarted daemon gets a short PATH; the hook saw the user's real one.
    lastHost("codebuddy\n/Users/x/.nvm/bin/codebuddy\n");
    const r = resolveChatProvider(home, {
      which: nothingInstalled,
      fileExists: (p) => p === "/Users/x/.nvm/bin/codebuddy",
    });
    expect(r).toEqual({ kind: "use", family: "codebuddy", source: "installed", commandDir: "/Users/x/.nvm/bin" });
  });

  test("the recorded path is gone and the command is not on PATH: fall to step 3, no error", () => {
    lastHost("codebuddy\n/gone/codebuddy\n");
    const r = resolveChatProvider(home, { which: installed("codex"), fileExists: () => false });
    expect(r).toEqual({ kind: "use", family: "codex", source: "installed" });
  });

  test("only claude installed: today's default model", () => {
    lastHost("claude\n\n");
    expect(resolveChatProvider(home, { which: installed("claude") })).toEqual({
      kind: "use", family: "claude", source: "installed", model: "claude-haiku-4-5-20251001",
    });
  });

  test.each([
    ["a name outside the five", "antigravity\n\n"],
    ["empty", ""],
    ["a family with trailing junk", "qoder extra\n\n"],
  ])("a damaged record (%s) counts as no record", (_label, text) => {
    lastHost(text);
    expect(resolveChatProvider(home, { which: installed("qodercli", "agy") })).toEqual({
      kind: "choose", found: ["agy", "qoder"],
    });
  });

  test("a recorded path that is not absolute is ignored, never joined onto anything", () => {
    lastHost("codebuddy\nbin/codebuddy\n");
    const seen: string[] = [];
    const r = resolveChatProvider(home, {
      which: nothingInstalled,
      fileExists: (p) => {
        seen.push(p);
        return true;
      },
    });
    expect(r).toEqual({ kind: "none" });
    expect(seen).toEqual([]);
  });
});

describe("step 3 — what is installed (AC2, AC3)", () => {
  test("exactly one: use it", () => {
    expect(resolveChatProvider(home, { which: installed("agy") })).toEqual({
      kind: "use", family: "agy", source: "installed",
    });
  });

  test("only claude: use it, with today's default model", () => {
    expect(resolveChatProvider(home, { which: installed("claude") })).toEqual({
      kind: "use", family: "claude", source: "installed", model: "claude-haiku-4-5-20251001",
    });
  });

  test("two or more: pick none, name them all — claude gets no priority", () => {
    const r = resolveChatProvider(home, { which: installed("claude", "codebuddy", "qodercli") });
    expect(r).toEqual({ kind: "choose", found: ["claude", "qoder", "codebuddy"] });
  });

  test("none: say so", () => {
    expect(resolveChatProvider(home, { which: nothingInstalled })).toEqual({ kind: "none" });
  });

  test("a lookup that throws counts as not installed", () => {
    const r = resolveChatProvider(home, {
      which: (bin) => {
        if (bin === "agy") throw new Error("which exploded");
        return bin === "codex" ? "/usr/local/bin/codex" : null;
      },
    });
    expect(r).toEqual({ kind: "use", family: "codex", source: "installed" });
  });
});

test("a corrupt config.json does not throw; resolution carries on", () => {
  writeFileSync(join(home, "config.json"), "{ not json");
  lastHost("qoder\n\n");
  expect(resolveChatProvider(home, { which: installed("qodercli") })).toEqual({
    kind: "use", family: "qoder", source: "installed",
  });
});

// The defaults — no `which` / `fileExists` injected — are what the daemon runs.
// "Found" has to mean "a spawn from this process will find it": the lookup and
// the spawn must read the same PATH. `Bun.which` with no options reads the PATH
// the process STARTED with, while a spawn is handed `process.env` as it is now
// (measured 2026-10-10: after `process.env.PATH = "/usr/bin:/bin"`, the bare
// call still returned ~/.local/bin/qodercli and the spawn then failed).
describe("the default lookups (nothing injected)", () => {
  let bin: string;
  let savedPath: string | undefined;
  beforeEach(() => {
    bin = mkdtempSync(join(tmpdir(), "siltpoke-chat-provider-bin-"));
    savedPath = process.env.PATH;
  });
  afterEach(() => {
    process.env.PATH = savedPath;
    rmSync(bin, { recursive: true, force: true });
  });
  const fakeCommand = (name: string): string => {
    const path = join(bin, name);
    writeFileSync(path, "#!/bin/sh\n");
    chmodSync(path, 0o755);
    return path;
  };

  test("a command is 'installed' only if it is on PATH as PATH stands now", () => {
    fakeCommand("codebuddy");
    process.env.PATH = `${bin}:/usr/bin:/bin`;
    expect(resolveChatProvider(home)).toEqual({ kind: "use", family: "codebuddy", source: "installed" });
    process.env.PATH = "/usr/bin:/bin";
    expect(resolveChatProvider(home)).toEqual({ kind: "none" });
  });

  test("last-used agent off PATH: its recorded command file gives the folder to add", () => {
    const recorded = fakeCommand("qodercli");
    process.env.PATH = "/usr/bin:/bin";
    lastHost(`qoder\n${recorded}\n`);
    expect(resolveChatProvider(home)).toEqual({ kind: "use", family: "qoder", source: "installed", commandDir: bin });
  });

  test("a recorded path that is a folder, not a command file, is not trusted", () => {
    process.env.PATH = "/usr/bin:/bin";
    // `bin` exists — as a directory. Its parent would otherwise go on a child's PATH.
    lastHost(`qoder\n${bin}\n`);
    expect(resolveChatProvider(home)).toEqual({ kind: "none" });
  });
});

// Spec §12.1 — the Settings chips say "installed" by the same rule chat uses.
describe("installedFamilies", () => {
  test("the families whose command is on PATH, in FAMILIES order", () => {
    expect(installedFamilies(home, { which: installed("codebuddy", "claude") })).toEqual(["claude", "codebuddy"]);
  });

  test("a command off PATH but recorded by a hook, still a file, counts", () => {
    lastHost("qoder\n/opt/q/qodercli\n");
    const r = installedFamilies(home, { which: nothingInstalled, fileExists: (p) => p === "/opt/q/qodercli" });
    expect(r).toEqual(["qoder"]);
  });

  test("nothing installed: empty", () => {
    expect(installedFamilies(home, { which: nothingInstalled })).toEqual([]);
  });
});
