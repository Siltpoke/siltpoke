// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
// Copyright (c) 2026 Jiaqi Duan
//
// Defect [49], step 2 (spec §8): the Settings page and `/siltpoke:siltpoke-brain` say
// which agent chat ACTUALLY uses and why — from the same function the chat route
// asks, so the page cannot say one thing while chat does another. Before this,
// the chat row showed whatever `brain.main` fell back to (claude) and the word
// "auto", and chat ignored both.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveChatProvider } from "../../src/brain/chat-provider";
import { brainView, formatBrainShow, runBrainSet, runBrainUnset } from "../../src/cli/brain-cli";

let home: string;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "siltpoke-brain-chat-view-"));
});
afterEach(() => rmSync(home, { recursive: true, force: true }));

const installed = (...bins: string[]) => ({ which: (bin: string) => (bins.includes(bin) ? `/usr/local/bin/${bin}` : null) });
const chatRow = (deps: ReturnType<typeof installed>) => brainView(home, deps).roles.find((r) => r.role === "chat");
const chatLine = (deps: ReturnType<typeof installed>) =>
  formatBrainShow(home, deps).split("\n").find((l) => l.trimStart().startsWith("chat")) ?? "";

describe("brainView().chat is the chat route's own answer", () => {
  test.each([
    ["chosen", () => writeFileSync(join(home, "config.json"), JSON.stringify({ brain: { roles: { chat: { provider: "codex" } } } })), ["codex", "agy"]],
    ["last-host is not a choice", () => writeFileSync(join(home, "last-host"), "qoder\n\n"), ["qodercli", "agy"]],
    ["installed", () => {}, ["codebuddy"]],
    ["choose", () => {}, ["codebuddy", "agy"]],
    ["none", () => {}, []],
  ] as Array<[string, () => void, string[]]>)("%s", (_label, arrange, bins) => {
    arrange();
    const deps = installed(...bins);
    expect(brainView(home, deps).chat).toEqual(resolveChatProvider(home, deps));
  });
});

describe("the chat row says which agent and why (AC5)", () => {
  test("the agent used last is not chosen for chat when two are installed (§11.1)", () => {
    writeFileSync(join(home, "last-host"), "qoder\n\n");
    const deps = installed("qodercli", "claude");
    expect(brainView(home, deps).chat).toEqual({ kind: "choose", found: ["claude", "qoder"] });
  });

  test("only one installed", () => {
    const deps = installed("codebuddy");
    expect(chatRow(deps)?.family).toBe("codebuddy");
    expect(chatRow(deps)?.source).toBe("only one installed");
    expect(chatLine(deps)).toContain("codebuddy · (CLI default)  [only one installed]");
  });

  test("chosen, with a model", () => {
    runBrainSet(home, "chat", "claude", "claude-sonnet-4-6");
    const deps = installed("codebuddy");
    expect(chatRow(deps)).toEqual({ role: "chat", family: "claude", model: "claude-sonnet-4-6", source: "from settings" });
  });

  test("a machine with no claude and no choice does NOT show claude", () => {
    // The old row: chat → brain.main → claude, on a machine that has no claude.
    writeFileSync(join(home, "last-host"), "codebuddy\n\n");
    const deps = installed("codebuddy");
    expect(chatRow(deps)?.family).toBe("codebuddy");
    expect(chatLine(deps)).not.toContain("claude");
  });

  test("two installed and nothing to go on: the line names them and how to pick", () => {
    const line = chatLine(installed("codex", "codebuddy"));
    expect(line).toContain("not decided");
    expect(line).toContain("codex, codebuddy");
    expect(line).toContain("siltpoke brain set chat");
  });

  test("nothing installed: the line says so, and names no agent", () => {
    const line = chatLine(installed());
    expect(line).toContain("no coding-agent CLI found");
    for (const family of ["claude", "codex", "agy", "qoder", "codebuddy"]) expect(line).not.toContain(family);
  });
});

describe("a choice applies at once, and undoing it goes back to following (AC4)", () => {
  test("set → chosen; unset → back to asking (two installed, last-host is not a choice)", () => {
    writeFileSync(join(home, "last-host"), "qoder\n\n");
    const deps = installed("qodercli", "codex");
    expect(brainView(home, deps).chat).toEqual({ kind: "choose", found: ["codex", "qoder"] });
    runBrainSet(home, "chat", "codex");
    expect(brainView(home, deps).chat).toMatchObject({ family: "codex", source: "chosen" });
    runBrainUnset(home, "chat");
    expect(brainView(home, deps).chat).toEqual({ kind: "choose", found: ["codex", "qoder"] });
  });

  test("the review row is untouched by a chat choice (AC6)", () => {
    runBrainSet(home, "review", "agy", "some-model");
    const before = brainView(home, installed("codex")).roles.find((r) => r.role === "review");
    runBrainSet(home, "chat", "codex");
    const after = brainView(home, installed("codex")).roles.find((r) => r.role === "review");
    expect(after).toEqual(before);
    expect(after).toMatchObject({ family: "agy", model: "some-model", source: "pinned here" });
  });
});
