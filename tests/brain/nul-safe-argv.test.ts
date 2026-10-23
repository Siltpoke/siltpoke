// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
// Copyright (c) 2026 Jiaqi Duan
/**
 * A raw NUL character in a reviewed diff must never reach a reviewer's argv.
 *
 * Measured 2026-09-29 on the maintainer's machine: a removed source line held a
 * literal NUL inside a template string, the prompt carrying that diff rode
 * argv, and the runtime refused the spawn with ERR_INVALID_ARG_VALUE. These
 * tests cover every production function that turns prompt text into argv.
 */
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { nulSafe } from "../../src/brain/nul-safe";
import { mergeAgyPrompt } from "../../src/brain/providers/agy-wire";
import { developerInstructionsArgs } from "../../src/brain/providers/codex-instructions";
import { systemPromptArgs } from "../../src/brain/system-prompt-file";

const NUL = "\u0000";
const DIRTY = `const key = \`\${caller}${NUL}\${target}\`;`;

test("the premise still holds: this runtime refuses a NUL in argv", () => {
  expect(() => Bun.spawn([process.execPath, "--version", DIRTY])).toThrow(/without null bytes/);
});

test("nulSafe replaces every NUL with a visible stand-in and leaves clean text identical", () => {
  expect(nulSafe(`a${NUL}b${NUL}c`)).toBe("a\u2400b\u2400c");
  expect(nulSafe("plain text")).toBe("plain text");
});

test("systemPromptArgs (argv form) carries no NUL, and the runtime accepts the result", async () => {
  const { args } = systemPromptArgs(DIRTY, { supportsFile: true, platform: "darwin" });
  expect(args[0]).toBe("--system-prompt");
  expect(args[1]).toBe(nulSafe(DIRTY));
  expect(args.join("")).not.toContain(NUL);
  // The runtime itself as the child, so this runs on every platform.
  const proc = Bun.spawn([process.execPath, "-e", "process.exit(0)", "--", ...args], {
    stdout: "pipe",
  });
  expect(await proc.exited).toBe(0);
});

test("systemPromptArgs (win32 file form) writes no NUL into the staged file", () => {
  const { args, cleanup } = systemPromptArgs(DIRTY, { supportsFile: true, platform: "win32" });
  try {
    expect(args[0]).toBe("--system-prompt-file");
    expect(readFileSync(args[1] as string, "utf8")).toBe(nulSafe(DIRTY));
  } finally {
    cleanup();
  }
});

test("codex developerInstructionsArgs (argv form) carries no NUL", () => {
  const { args, cleanup } = developerInstructionsArgs(DIRTY, { platform: "darwin" });
  try {
    expect(args.join("")).not.toContain(NUL);
    expect(args[1]).toBe(`developer_instructions=${nulSafe(DIRTY)}`);
  } finally {
    cleanup();
  }
});

test("mergeAgyPrompt carries no NUL from either the rubric or the diff", () => {
  const merged = mergeAgyPrompt(`rubric${NUL}`, DIRTY);
  expect(merged).not.toContain(NUL);
  expect(merged).toContain(nulSafe(DIRTY));
  expect(merged).toContain("rubric\u2400");
});
