// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
// Copyright (c) 2026 Jiaqi Duan
/**
 * Defect `[26]`'s sibling path: `--output-schema <path>` rides argv on EVERY
 * codex call, so if that path carries a cmd.exe special character the whole fix
 * is inert on Windows — which is exactly how version 1 of the `claude` fix was
 * inert (`system-prompt-file.ts:48-62`, measured with TMPDIR pointed at
 * `A&B^C%Z`).
 *
 * This file exists because a mutation survived: reverting the base to a raw
 * `tmpdir()` left every other test green. The fix had no assertion at all.
 *
 * It drives `schemaFilePath()` — the exported entry point codex.ts actually
 * calls — rather than the private base picker, so what is asserted is the path
 * that really reaches argv. The temp bases are REAL directories, because
 * `schemaFilePath` writes the schema file for real.
 */

import { afterEach, beforeEach, test, expect } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { schemaFilePath } from "../../../src/brain/providers/codex-schema";

/** The characters the runtime refuses to hand a `.bat`/`.cmd`. Spelled out here
 * rather than imported: the production regex is private, and what matters is
 * that these specific characters are absent from the path. */
const SPECIALS = ['"', "&", "(", ")", "<", ">", "^", "|", "%", " ", "\t"];

let root: string;
let dirty: string;
let clean: string;
let prev: Record<string, string | undefined>;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "codex-schema-base-"));
  dirty = join(root, "A&B^C%Z");
  clean = join(root, "plain");
  mkdirSync(dirty, { recursive: true });
  mkdirSync(clean, { recursive: true });
  prev = {
    TMPDIR: process.env.TMPDIR,
    TMP: process.env.TMP,
    SystemRoot: process.env.SystemRoot,
  };
  // `schemaFilePath` memoizes across the whole process and only recomputes when
  // the cached file is gone — and bun runs every test file in one process, so
  // another file's call would otherwise hand this one a stale answer. Take the
  // cached file away. (Measured: these three tests passed alone and failed as
  // part of `bun test tests/brain/providers`.)
  rmSync(schemaFilePath(), { force: true });
});

afterEach(() => {
  for (const [k, v] of Object.entries(prev)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  // Each test has to take its file with it, or the next one asserts against the
  // previous test's cached path.
  rmSync(root, { recursive: true, force: true });
  // And leave nothing cached for whatever runs next in this process.
  rmSync(schemaFilePath(), { force: true });
});

test("a dirty %TEMP% does not reach argv when another base is clean", () => {
  process.env.TMPDIR = dirty;
  process.env.TMP = dirty;
  // The escape hatch the sibling path documents: %SystemRoot%\Temp, whose path
  // contains no special characters on a default Windows install.
  process.env.SystemRoot = clean;

  const path = schemaFilePath();

  for (const ch of SPECIALS) expect(path).not.toContain(ch);
  expect(path).not.toContain("A&B");
  // It chose the fallback base rather than inventing a directory.
  expect(path.startsWith(join(clean, "Temp"))).toBe(true);
  // And the schema file is really there — a clean path pointing at nothing would
  // satisfy every assertion above while codex got an unreadable `--output-schema`.
  expect(existsSync(path)).toBe(true);
});

test("a clean %TEMP% is used as-is — nothing moves on the platforms that work", () => {
  process.env.TMPDIR = clean;
  process.env.TMP = clean;
  delete process.env.SystemRoot;

  const path = schemaFilePath();

  expect(path.startsWith(join(clean, "siltpoke-codex-schemas"))).toBe(true);
  expect(existsSync(path)).toBe(true);
});

test("no clean base anywhere: still returns a path, and says why it is broken", () => {
  // Silence here is the failure that matters — the operator would see exactly
  // defect [26]'s own error and conclude the fix never shipped.
  process.env.TMPDIR = dirty;
  process.env.TMP = dirty;
  delete process.env.SystemRoot;

  const warnings: string[] = [];
  const realError = console.error;
  console.error = (...parts: unknown[]) => {
    warnings.push(parts.join(" "));
  };
  let path: string;
  try {
    path = schemaFilePath();
  } finally {
    console.error = realError;
  }

  expect(path).toContain("siltpoke-codex-schemas");
  expect(warnings.join("\n")).toContain("defect [26]");
  expect(warnings.join("\n")).toContain("--output-schema");
});
