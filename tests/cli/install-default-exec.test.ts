// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
// Copyright (c) 2026 Jiaqi Duan
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, unlinkSync } from "node:fs";
import { buildExecArgv, defaultExec } from "../../src/cli/install";

// `command -v <bin>` is a POSIX shell BUILTIN. macOS/BSD happen to also ship
// a standalone compat binary at /usr/bin/command, but Debian/Ubuntu —
// including GitHub Actions ubuntu-latest — do NOT. This bit siltpoke for
// real: defaultExec used to spawn "command" as a literal argv[0], which
// fails to spawn at all on Linux even when the target binary genuinely is
// on PATH, so detectAgents/detectPrereqs silently reported everything as
// absent there (tests/cli/uninstall.test.ts + install.test.ts caught the
// downstream symptoms on Linux CI).
//
// An earlier version of this file tried to prove the fix by stripping
// process.env.PATH down to `/bin` before calling defaultExec("command", ...)
// and asserting the old implementation would fail there too. That claim is
// FALSE under Bun: spawnSync resolves the child's executable against the
// PARENT process's real $PATH, not a mutated process.env.PATH (the child
// even reports back the original, unstripped PATH). All 3 of those tests
// passed unmodified against the verbatim pre-fix `defaultExec` — zero
// regression value.
//
// This file instead asserts the routing decision STRUCTURALLY, against the
// pure `buildExecArgv` helper `defaultExec` is built on (no subprocess, no
// env trickery, genuinely goes RED if the shell-routing is reverted), plus
// one live-process test that the shell routing does not open a
// shell-injection hole.
describe("buildExecArgv — command -v shell-routing (structural)", () => {
  test("routes the 'command' builtin through sh with positional params", () => {
    expect(buildExecArgv("command", ["-v", "claude"])).toEqual([
      "sh",
      ["-c", 'command "$1" "$2"', "_", "-v", "claude"],
    ]);
  });

  test("non-'command' invocations (e.g. win32's 'where') are left untouched", () => {
    expect(buildExecArgv("echo", ["hi"])).toEqual(["echo", ["hi"]]);
  });

  test("empty args do not build a vacuous 'command ' script (would exit 0 == false present)", () => {
    expect(buildExecArgv("command", [])).toEqual(["command", []]);
  });
});

describe("defaultExec — command -v behavior", () => {
  test("resolves `command -v <bin>` for a real binary on PATH", () => {
    const r = defaultExec("command", ["-v", "sh"]);
    expect(r.status).toBe(0);
    expect(r.stdout.trim().length).toBeGreaterThan(0);
  });

  test("still reports absent for a genuinely missing binary (no false positives)", () => {
    const r = defaultExec("command", ["-v", "definitely-not-a-real-binary-xyz"]);
    expect(r.status).not.toBe(0);
  });
});

describe("defaultExec — shell-injection guard", () => {
  const marker = "/tmp/PWNED_SILTPOKE";

  // Clear both before AND after: a prior run killed before afterEach fired
  // (or any other stray source) could leave the marker pre-existing, which
  // would make existsSync(marker) read true regardless of whether *this*
  // run's injection happened — a false failure that would mask the real
  // regression signal this test exists to catch.
  const clearMarker = () => {
    if (existsSync(marker)) unlinkSync(marker);
  };
  beforeEach(clearMarker);
  afterEach(clearMarker);

  test("shell metacharacters in args are passed as literal positional params, not interpolated", () => {
    const r = defaultExec("command", ["-v", `sh; touch ${marker}`]);
    expect(existsSync(marker)).toBe(false);
    // The literal string (including ';') is not a real binary name, so this
    // reports absent rather than "sh" being found via the injected command.
    expect(r.status).not.toBe(0);
  });
});
