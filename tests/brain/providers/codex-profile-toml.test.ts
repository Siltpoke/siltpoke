// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
// Copyright (c) 2026 Jiaqi Duan
/**
 * Defect `[26]`, codex half — the TOML the rubric is written as.
 *
 * A malformed file makes codex reject the WHOLE config, so a review rubric that
 * escapes badly takes the reviewer down with it. The escaper is private, so these
 * assertions read the file `developerInstructionsArgs` actually writes: the real
 * write path, not an internal helper called in isolation.
 *
 * Fidelity is NOT asserted by re-deriving the escaper's own output. That was
 * measured out-of-band with two independent parsers (2026-09-26): python
 * `tomllib` round-trips a prompt carrying quotes, backslashes, a tab, a CR, a
 * form feed, a backspace, `\u0001`, DEL and multi-byte UTF-8 EXACTLY (with a
 * mutated-expectation control proving the oracle can fail), and codex's own Rust
 * parser accepts the file under `--strict-config` while rejecting a deliberately
 * unterminated one. Bun's TOML parser is deliberately NOT used as an oracle: it
 * decoded a `\t` escape as a form feed.
 *
 * What is asserted here is the STRUCTURAL property that makes the file parseable
 * at all — one line, no raw control characters, no bare quote — plus the exact
 * wire format, so a future edit has to be deliberate.
 *
 * Split from codex-instructions.test.ts, which crossed the 400-line cap.
 */

import { test, expect } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { developerInstructionsArgs } from "../../../src/brain/providers/codex-instructions";

/**
 * The value side of the `developer_instructions = …` line the provider wrote,
 * quotes included — i.e. exactly the bytes codex's parser will see.
 */
function writtenValue(prompt: string): string {
  const home = mkdtempSync(join(tmpdir(), "codex-toml-"));
  const { args, cleanup } = developerInstructionsArgs(prompt, {
    platform: "win32",
    codexHome: home,
  });
  try {
    const file = join(home, `${args[1]}.config.toml`);
    const text = readFileSync(file, "utf8");
    const prefix = "developer_instructions = ";
    expect(text.startsWith(prefix)).toBe(true);
    expect(text.endsWith("\n")).toBe(true);
    return text.slice(prefix.length, -1);
  } finally {
    cleanup();
  }
}

test("escapes what would otherwise break the file", () => {
  expect(writtenValue('say "hi"')).toBe('"say \\"hi\\""');
  expect(writtenValue("back\\slash")).toBe('"back\\\\slash"');
  expect(writtenValue("a\nb")).toBe('"a\\nb"');
  expect(writtenValue("a\tb")).toBe('"a\\tb"');
  expect(writtenValue("a\rb")).toBe('"a\\rb"');
  expect(writtenValue("a\bb")).toBe('"a\\bb"');
  expect(writtenValue("a\fb")).toBe('"a\\fb"');
  // Control bytes with no short escape need \uXXXX, or the file is invalid TOML.
  expect(writtenValue("a\u0001b")).toBe('"a\\u0001b"');
  expect(writtenValue("a\u007fb")).toBe('"a\\u007fb"');
  // Multi-byte text is legal raw inside a basic string — escaping it would be
  // lossy for no reason.
  expect(writtenValue("中文 🐙")).toBe('"中文 🐙"');
});

test("the written value is one TOML line whose only bare quotes are its delimiters", () => {
  // A whole realistic rubric shape rather than one character at a time: the
  // structural property is what makes the file parseable at all.
  const prompt = [
    'You are Fuzzyglob. Reply with JSON: {"mood": "happy"}',
    "Windows paths look like C:\\Users\\name\\repo",
    "\ttabbed\r\n",
  ].join("\n");
  const out = writtenValue(prompt);

  expect(out.startsWith('"')).toBe(true);
  expect(out.endsWith('"')).toBe(true);
  expect(out).not.toContain("\n");
  expect(out).not.toContain("\r");
  expect(out).not.toContain("\t");
  // No quote in the interior is left bare — every one is preceded by a
  // backslash that is not itself escaped.
  const interior = out.slice(1, -1);
  for (let i = 0; i < interior.length; i++) {
    if (interior[i] !== '"') continue;
    let backslashes = 0;
    for (let j = i - 1; j >= 0 && interior[j] === "\\"; j--) backslashes++;
    expect(backslashes % 2).toBe(1);
  }
});

test("the rubric survives the round trip — the file is not just well-formed but right", () => {
  // Well-formed and empty would satisfy every structural assertion above while
  // codex reviewed with no instructions.
  const prompt = 'REVIEW RUBRIC: reject "bad" code\nsecond line';
  const out = writtenValue(prompt);
  expect(out).toContain("REVIEW RUBRIC");
  expect(out).toContain("second line");
});
