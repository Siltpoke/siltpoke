import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  installSwiftbarAutostart,
  renderSwiftbarPlist,
  uninstallSwiftbarAutostart,
} from "../../src/installer/swiftbar-autostart";

describe("renderSwiftbarPlist", () => {
  test("labels the SwiftBar login-item and runs `open -a SwiftBar` at load", () => {
    const xml = renderSwiftbarPlist();
    expect(xml).toContain("<key>Label</key><string>io.siltpoke.swiftbar</string>");
    expect(xml).toContain("<string>/usr/bin/open</string>");
    expect(xml).toContain("<string>-a</string>");
    expect(xml).toContain("<string>SwiftBar</string>");
    expect(xml).toMatch(/<key>RunAtLoad<\/key>\s*<true\/>/);
  });

  test("has NO KeepAlive (open exits after launch — no relaunch loop)", () => {
    expect(renderSwiftbarPlist()).not.toContain("KeepAlive");
  });
});

function spyExec(status = 0) {
  const calls: Array<{ cmd: string; args: string[] }> = [];
  return { calls, exec: (cmd: string, args: string[]) => (calls.push({ cmd, args }), { status }) };
}

describe("installSwiftbarAutostart", () => {
  test("non-darwin: no-op, reason not-darwin, zero writes/execs", () => {
    const writes: string[] = [];
    const { calls, exec } = spyExec();
    const r = installSwiftbarAutostart({
      platform: "linux",
      exec,
      existsSync: () => true,
      writeFile: (p) => writes.push(p),
    });
    expect(r).toEqual({ installed: false, reason: "not-darwin" });
    expect(writes.length).toBe(0);
    expect(calls.length).toBe(0);
  });

  test("AC21 guard: SwiftBar app absent → swiftbar-absent, no plist write, no launchctl", () => {
    const writes: string[] = [];
    const { calls, exec } = spyExec();
    const r = installSwiftbarAutostart({
      platform: "darwin",
      exec,
      existsSync: () => false, // /Applications/SwiftBar.app missing
      writeFile: (p) => writes.push(p),
    });
    expect(r).toEqual({ installed: false, reason: "swiftbar-absent" });
    expect(writes.length).toBe(0);
    expect(calls.length).toBe(0);
  });

  test("happy path: writes plist + bootout/bootstrap by label", () => {
    const dir = mkdtempSync(join(tmpdir(), "sb-auto-"));
    const plistPath = join(dir, "io.siltpoke.swiftbar.plist");
    const { calls, exec } = spyExec(0);
    const r = installSwiftbarAutostart({
      platform: "darwin",
      exec,
      existsSync: () => true,
      plistPath,
      uid: 501,
    });
    expect(r).toEqual({ installed: true, reason: "ok" });
    expect(existsSync(plistPath)).toBe(true);
    expect(calls).toEqual([
      { cmd: "launchctl", args: ["bootout", "gui/501/io.siltpoke.swiftbar"] },
      { cmd: "launchctl", args: ["bootstrap", "gui/501", plistPath] },
    ]);
    rmSync(dir, { recursive: true, force: true });
  });
});

describe("uninstallSwiftbarAutostart", () => {
  test("removes plist + boots out; no-op when absent", () => {
    const dir = mkdtempSync(join(tmpdir(), "sb-auto-"));
    const plistPath = join(dir, "io.siltpoke.swiftbar.plist");
    writeFileSync(plistPath, "<plist/>");
    const { calls, exec } = spyExec();
    expect(uninstallSwiftbarAutostart({ exec, plistPath, uid: 501 })).toEqual({ removed: true });
    expect(existsSync(plistPath)).toBe(false);
    expect(calls).toEqual([
      { cmd: "launchctl", args: ["bootout", "gui/501/io.siltpoke.swiftbar"] },
    ]);
    // absent → no-op
    const again = spyExec();
    expect(uninstallSwiftbarAutostart({ exec: again.exec, plistPath, uid: 501 })).toEqual({
      removed: false,
    });
    expect(again.calls).toEqual([]);
    rmSync(dir, { recursive: true, force: true });
  });
});
