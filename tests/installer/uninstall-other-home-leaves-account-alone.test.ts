// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
// Copyright (c) 2026 Jiaqi Duan
// Defect [86]: uninstalling under a HOME that is not the account's own home
// must not `launchctl bootout` the REAL account's daemon / login item.
import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { defaultPlistPath, uninstallAutostart } from "../../src/installer/launchd";
import { uninstallAutostartForPlatform } from "../../src/installer/autostart";
import { uninstallSwiftbarAutostart } from "../../src/installer/swiftbar-autostart";

let tmpHome: string;
let accountDir: string;
let out: string[];
let spy: ReturnType<typeof spyOn>;

beforeEach(() => {
  tmpHome = mkdtempSync(join(tmpdir(), "siltpoke-86-home-"));
  accountDir = mkdtempSync(join(tmpdir(), "siltpoke-86-account-"));
  out = [];
  spy = spyOn(process.stdout, "write").mockImplementation(((s: string) => {
    out.push(String(s));
    return true;
  }) as never);
});
afterEach(() => {
  spy.mockRestore();
  rmSync(tmpHome, { recursive: true, force: true });
  rmSync(accountDir, { recursive: true, force: true });
});

function spyExec() {
  const calls: { cmd: string; args: string[] }[] = [];
  return { calls, exec: (cmd: string, args: string[]) => {
      calls.push({ cmd, args });
      return { status: 0 };
    },
  };
}

/** A fake `id -P` whose account home is `home`. */
function idProbe(home: string) {
  return (_cmd: string, _args: string[]) => ({
    status: 0,
    stdout: `me:*:501:20::0:0:Me Person:${home}:/bin/zsh\n`,
  });
}

function putPlist(home: string, name: string): string {
  const p = join(home, "Library", "LaunchAgents", name);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, "<plist/>");
  return p;
}

describe("[86] launchd daemon uninstall", () => {
  test("HOME is not the account home: no launchctl at all, files still removed, plain line printed", async () => {
    const plist = defaultPlistPath(tmpHome);
    mkdirSync(dirname(plist), { recursive: true });
    writeFileSync(plist, "<plist/>");
    const { calls, exec } = spyExec();
    const r = await uninstallAutostart({ home: tmpHome, exec, uid: 501, probe: idProbe(accountDir) });
    expect(r).toEqual({ removed: true });
    expect(existsSync(plist)).toBe(false);
    // Absence: nothing was sent to the real account's launchd domain.
    expect(calls).toEqual([]);
    expect(out.join("")).toContain("left the daemon service alone (not stopped)");
    expect(out.join("")).toContain(accountDir);
  });

  test("positive control: HOME is the account home: bootout is called as before", async () => {
    const plist = defaultPlistPath(tmpHome);
    mkdirSync(dirname(plist), { recursive: true });
    writeFileSync(plist, "<plist/>");
    const { calls, exec } = spyExec();
    const r = await uninstallAutostart({ home: tmpHome, exec, uid: 501, probe: idProbe(tmpHome) });
    expect(r).toEqual({ removed: true });
    expect(existsSync(plist)).toBe(false);
    expect(calls).toEqual([{ cmd: "launchctl", args: ["bootout", "gui/501/io.siltpoke.daemon"] }]);
    expect(out.join("")).not.toContain("left the");
  });

  test("account home unreadable: unknown is not a mismatch, bootout is called", async () => {
    const plist = defaultPlistPath(tmpHome);
    mkdirSync(dirname(plist), { recursive: true });
    writeFileSync(plist, "<plist/>");
    const { calls, exec } = spyExec();
    await uninstallAutostart({ home: tmpHome, exec, uid: 501, probe: () => ({ status: 1, stdout: "" }) });
    expect(calls).toHaveLength(1);
  });
});

describe("[86] SwiftBar login item uninstall", () => {
  test("HOME is not the account home: no launchctl at all, file removed, plain line printed", () => {
    const plist = putPlist(tmpHome, "io.siltpoke.swiftbar.plist");
    const { calls, exec } = spyExec();
    expect(uninstallSwiftbarAutostart({ home: tmpHome, exec, uid: 501, probe: idProbe(accountDir) })).toEqual({
      removed: true,
    });
    expect(existsSync(plist)).toBe(false);
    expect(calls).toEqual([]);
    expect(out.join("")).toContain("left the login item alone (not stopped)");
  });

  test("positive control: HOME is the account home: bootout is called as before", () => {
    const plist = putPlist(tmpHome, "io.siltpoke.swiftbar.plist");
    const { calls, exec } = spyExec();
    expect(uninstallSwiftbarAutostart({ home: tmpHome, exec, uid: 501, probe: idProbe(tmpHome) })).toEqual({
      removed: true,
    });
    expect(existsSync(plist)).toBe(false);
    expect(calls).toEqual([{ cmd: "launchctl", args: ["bootout", "gui/501/io.siltpoke.swiftbar"] }]);
  });
});

describe("[86] unreadable id -P and the real wiring", () => {
  test("SwiftBar: account home unreadable: unknown is not a mismatch, bootout is called", () => {
    putPlist(tmpHome, "io.siltpoke.swiftbar.plist");
    const { calls, exec } = spyExec();
    uninstallSwiftbarAutostart({ home: tmpHome, exec, uid: 501, probe: () => ({ status: 1, stdout: "" }) });
    expect(calls).toEqual([{ cmd: "launchctl", args: ["bootout", "gui/501/io.siltpoke.swiftbar"] }]);
  });

  test("through uninstallAutostartForPlatform: home and probe reach the guard, no launchctl", async () => {
    const plist = defaultPlistPath(tmpHome);
    mkdirSync(dirname(plist), { recursive: true });
    writeFileSync(plist, "<plist/>");
    const { calls, exec } = spyExec();
    const r = await uninstallAutostartForPlatform({
      platform: "darwin",
      home: tmpHome,
      loadLaunchd: async () => ({
        uninstallAutostart: (o) => uninstallAutostart({ ...o, exec, uid: 501, probe: idProbe(accountDir) }),
      }),
    });
    expect(r).toEqual({ status: "removed", platform: "darwin" });
    expect(existsSync(plist)).toBe(false);
    expect(calls).toEqual([]);
  });

  // The DEFAULT probe is the real read-only `id -P` (no launchctl, nothing written):
  // a broken default would fail open and call bootout for a temp home.
  test.skipIf(process.platform !== "darwin")("default probe: a temp HOME is recognised as another home", async () => {
    const plist = defaultPlistPath(tmpHome);
    mkdirSync(dirname(plist), { recursive: true });
    writeFileSync(plist, "<plist/>");
    const { calls, exec } = spyExec();
    await uninstallAutostart({ home: tmpHome, exec, uid: 501 });
    expect(calls).toEqual([]);
    expect(existsSync(plist)).toBe(false);
  });
});
