// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
// Copyright (c) 2026 Jiaqi Duan
/**
 * The replacement argument must itself be legal — defect `[26]`, second half.
 *
 * The fix moves the system prompt out of argv because the runtime refuses any
 * argument containing a cmd.exe special character. The path it puts there
 * instead can contain them too: `os.tmpdir()` honours `%TEMP%`/`%TMP%`, and a
 * Windows account name may legally contain `&`, `^`, `%`, `(`, `)`. The first
 * version of this fix did not check, so on
 * `C:\Users\A&B\AppData\Local\Temp` it produced a refused argument and did
 * nothing — while looking shipped.
 *
 * Reachable from macOS via TMPDIR, which is why these tests exist here rather
 * than as a note to check on Windows one day.
 */

import { test, expect, describe, afterEach } from "bun:test";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { systemPromptArgs } from "../../src/brain/system-prompt-file";

const CMD_SPECIAL = /[\t\n\r "&()<>^|%]/;
/** A directory name carrying the characters the runtime refuses. */
const DIRTY = join(tmpdir(), "sp-dirty-A&B^C%Z");
const CLEAN = join(tmpdir(), "sp-clean-base");

const savedTmp = process.env.TMPDIR;
const savedRoot = process.env.SystemRoot;

afterEach(() => {
  if (savedTmp === undefined) delete process.env.TMPDIR;
  else process.env.TMPDIR = savedTmp;
  if (savedRoot === undefined) delete process.env.SystemRoot;
  else process.env.SystemRoot = savedRoot;
  rmSync(DIRTY, { recursive: true, force: true });
  rmSync(CLEAN, { recursive: true, force: true });
});

describe("defect [26] — the temp path must not carry what the prompt could not", () => {
  test("a temp base with cmd specials is skipped for a clean one", () => {
    mkdirSync(DIRTY, { recursive: true });
    mkdirSync(join(CLEAN, "Temp"), { recursive: true });
    process.env.TMPDIR = DIRTY;
    // Stands in for %SystemRoot%\Temp, the escape hatch when the account name
    // itself cannot be used.
    process.env.SystemRoot = CLEAN;

    const r = systemPromptArgs("REVIEW RUBRIC", { supportsFile: true, platform: "win32" });
    try {
      expect(r.args[0]).toBe("--system-prompt-file");
      const path = String(r.args[1]);
      // The assertion the first version would have failed.
      expect(CMD_SPECIAL.test(path)).toBe(false);
      expect(path.startsWith(CLEAN)).toBe(true);
      expect(existsSync(path)).toBe(true);
    } finally {
      r.cleanup();
    }
  });

  test("when every base is dirty it says so instead of shipping a refused argument", () => {
    mkdirSync(DIRTY, { recursive: true });
    process.env.TMPDIR = DIRTY;
    delete process.env.SystemRoot;

    const r = systemPromptArgs("REVIEW RUBRIC", { supportsFile: true, platform: "win32" });
    // Falls back to argv — which on Windows still fails. That is the honest
    // outcome; what must not happen is a `--system-prompt-file` pointing at a
    // path the runtime will refuse, because its error is indistinguishable from
    // the unfixed defect and reads as "the fix did not ship".
    expect(r.args[0]).toBe("--system-prompt");
    expect(r.args).not.toContain("--system-prompt-file");
    r.cleanup();
  });

  test("a failed write leaves no directory behind", () => {
    mkdirSync(CLEAN, { recursive: true });
    process.env.TMPDIR = CLEAN;
    delete process.env.SystemRoot;
    const before = existsSync(CLEAN);
    const r = systemPromptArgs("REVIEW RUBRIC", { supportsFile: true, platform: "win32" });
    const path = String(r.args[1]);
    r.cleanup();
    expect(before).toBe(true);
    // The per-call directory is gone, not merely the file inside it.
    expect(existsSync(join(path, ".."))).toBe(false);
  });
});
