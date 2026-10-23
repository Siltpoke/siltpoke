// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
// Copyright (c) 2026 Jiaqi Duan
// Defect [72]: systemd's user-unit search path is $XDG_CONFIG_HOME/systemd/user
// (fallback ~/.config/systemd/user). A hardcoded ~/.config wrote a unit systemd
// never read for anyone with XDG_CONFIG_HOME set. Writer AND every reader
// (uninstall, doctor, install receipt) must resolve the same path. The XDG Base
// Directory spec says a non-absolute value is invalid and must be ignored.
// Env is always passed in; the real process env is never consulted here.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { checkAutostart } from "../../src/cli/doctor-daemon-check";
import { installAutostartForPlatform, type AutostartModule } from "../../src/installer/autostart";
import { autostartUnitPath } from "../../src/installer/receipt-sites";
import { defaultUnitPath, uninstallAutostart } from "../../src/installer/systemd";

let root: string;
let home: string;
let xdg: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "siltpoke-xdg72-"));
  home = join(root, "home");
  xdg = join(root, "xdg-config");
  mkdirSync(home, { recursive: true });
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

const xdgUnit = () => join(xdg, "systemd", "user", "siltpoked.service");
const fallback = (h: string) => join(h, ".config", "systemd", "user", "siltpoked.service");

describe("defaultUnitPath honours XDG_CONFIG_HOME", () => {
  test("absolute XDG_CONFIG_HOME wins over <home>/.config", () => {
    expect(defaultUnitPath(home, { XDG_CONFIG_HOME: xdg })).toBe(join(xdg, "systemd", "user", "siltpoked.service"));
  });
  test("unset → <home>/.config fallback", () => {
    expect(defaultUnitPath(home, {})).toBe(fallback(home));
  });
  test("empty XDG_CONFIG_HOME is ignored", () => {
    expect(defaultUnitPath(home, { XDG_CONFIG_HOME: "" })).toBe(fallback(home));
  });
  test("relative XDG_CONFIG_HOME is ignored (XDG spec)", () => {
    expect(defaultUnitPath(home, { XDG_CONFIG_HOME: "relative/cfg" })).toBe(fallback(home));
  });
});

describe("readers follow the same path as the writer", () => {
  test("receipt site", () => {
    expect(autostartUnitPath("linux", { HOME: home, XDG_CONFIG_HOME: xdg })).toBe(xdgUnit());
  });

  test("doctor finds a unit living under XDG_CONFIG_HOME", () => {
    const p = join(xdg, "systemd", "user", "siltpoked.service");
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, "[Unit]\n");
    const r = checkAutostart({ platform: "linux", home, env: { XDG_CONFIG_HOME: xdg } });
    expect(r.status).toBe("pass");
    expect(r.detail).toContain(p);
  });

  test("uninstall removes the unit under XDG_CONFIG_HOME", async () => {
    const p = join(xdg, "systemd", "user", "siltpoked.service");
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, "[Unit]\n");
    const r = await uninstallAutostart({ home, env: { XDG_CONFIG_HOME: xdg }, exec: () => ({ status: 0 }) });
    expect(r.removed).toBe(true);
    expect(existsSync(p)).toBe(false);
  });
});

describe("the dispatcher hands env to systemd only", () => {
  // launchd's installAutostart(home, execFn) takes an exec seam as its 2nd
  // parameter: an env object there would be called as a function.
  function recorder(): { mod: AutostartModule; args: unknown[][] } {
    const args: unknown[][] = [];
    const mod = {
      async installAutostart(...a: unknown[]) {
        args.push(a);
      },
    } as AutostartModule;
    return { mod, args };
  }
  const env = { XDG_CONFIG_HOME: "/abs/xdg" };

  test("linux: systemd gets (home, env)", async () => {
    const sd = recorder();
    await installAutostartForPlatform({ platform: "linux", home: "/h", env, loadSystemd: async () => sd.mod });
    expect(sd.args).toEqual([["/h", env]]);
  });

  test("darwin: launchd gets only (home) — env is never its exec seam", async () => {
    const ld = recorder();
    await installAutostartForPlatform({ platform: "darwin", home: "/h", env, loadLaunchd: async () => ld.mod });
    expect(ld.args).toEqual([["/h"]]);
  });
});
