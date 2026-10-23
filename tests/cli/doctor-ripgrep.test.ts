// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
// Copyright (c) 2026 Jiaqi Duan
//
// Windows Run 4 (install audit §110 W4): no `rg` on the box, the first review
// ran with no checker, and doctor had not said a word.
import { describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DOCTOR_CHECKS } from "../../src/cli/doctor";
import { checkRipgrep, RIPGREP_ROW, RIPGREP_TIMED_OUT, ripgrepInstallHint } from "../../src/cli/doctor-ripgrep-check";

describe("the ripgrep row", () => {
  test("real ripgrep answers -> green, with its version", () => {
    const r = checkRipgrep({}, { version: () => "ripgrep 14.1.0\n\nfeatures:+pcre2\n" });
    expect([r.pass, r.status, r.detail]).toEqual([true, "pass", "ripgrep 14.1.0"]);
  });

  test("Windows line endings are fine", () => {
    expect(checkRipgrep({}, { version: () => "ripgrep 14.1.0\r\n" }).status).toBe("pass");
  });

  test("Run 4's machine: rg cannot start on Windows -> warn, with the winget command", () => {
    const r = checkRipgrep({ platform: "win32" }, { version: () => null });
    expect([r.pass, r.status]).toEqual([true, "warn"]);
    expect(r.detail).toContain("could not be started");
    expect(r.detail).toContain("winget install BurntSushi.ripgrep.MSVC");
  });

  test("something called rg that is not ripgrep -> warn, quoting what it said", () => {
    const r = checkRipgrep({ platform: "darwin" }, { version: () => "grep (BSD grep) 2.6.0\n" });
    expect(r.status).toBe("warn");
    expect(r.detail).toContain('"grep (BSD grep) 2.6.0"');
    expect(r.detail).toContain("brew install ripgrep");
  });

  test("a hint for each platform", () => {
    expect(ripgrepInstallHint("win32")).toBe("winget install BurntSushi.ripgrep.MSVC");
    expect(ripgrepInstallHint("darwin")).toBe("brew install ripgrep");
    expect(ripgrepInstallHint("linux")).toContain("apt install ripgrep");
  });

  test("a slow rg is not reported as missing", () => {
    const r = checkRipgrep({}, { version: () => RIPGREP_TIMED_OUT });
    expect(r.status).toBe("warn");
    expect(r.detail).toContain("did not answer within 10 seconds");
    expect(r.detail).not.toContain("could not be started");
  });

  test("empty output -> warn", () => {
    expect(checkRipgrep({}, { version: () => "" }).status).toBe("warn");
  });

  test("it is in doctor's list", () => {
    const row = DOCTOR_CHECKS.find((c) => c.label === "ripgrep available")?.run({});
    expect((row as { name: string } | undefined)?.name).toBe(RIPGREP_ROW);
  });
});

describe("the default probe runs the bare `rg` the review runs", () => {
  test("a fake rg on PATH that prints ripgrep's banner -> green; PATH without it -> warn", () => {
    if (process.platform === "win32") return;
    const dir = mkdtempSync(join(tmpdir(), "siltpoke-rg-"));
    const saved = process.env.PATH;
    try {
      const bin = join(dir, "bin");
      mkdirSync(bin);
      writeFileSync(join(bin, "rg"), '#!/bin/sh\necho "ripgrep 99.0.0"\n');
      chmodSync(join(bin, "rg"), 0o755);
      process.env.PATH = bin;
      expect(checkRipgrep({}).detail).toBe("ripgrep 99.0.0");
      writeFileSync(join(bin, "rg"), '#!/bin/sh\necho "ripgrep 99.0.0"\nexit 2\n');
      expect(checkRipgrep({}).status).toBe("warn"); // answered, but failed
      process.env.PATH = join(dir, "empty");
      const missing = checkRipgrep({});
      expect(missing.status).toBe("warn");
      expect(missing.detail).toContain("could not be started");
    } finally {
      process.env.PATH = saved;
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
