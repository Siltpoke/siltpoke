import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  loadLaunchAgent,
  renderPlist,
  uninstallAutostart,
} from "../../src/installer/launchd";

const PLIST_PATH =
  "/Users/x/.bun/bin:/Users/x/.local/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin";

describe("renderPlist", () => {
  test("includes absolute bun path", () => {
    const xml = renderPlist({
      bunPath: "/Users/x/.bun/bin/bun",
      daemonScript: "/abs/cli/daemon.ts",
      daemonPath: PLIST_PATH,
    });
    expect(xml).toContain("<string>/Users/x/.bun/bin/bun</string>");
    expect(xml).toContain("<string>/abs/cli/daemon.ts</string>");
  });

  test("sets ThrottleInterval to 10", () => {
    const xml = renderPlist({
      bunPath: "/x",
      daemonScript: "/y",
      daemonPath: PLIST_PATH,
    });
    expect(xml).toMatch(/<key>ThrottleInterval<\/key>\s*<integer>10<\/integer>/);
  });

  test("KeepAlive=true and RunAtLoad=true", () => {
    const xml = renderPlist({
      bunPath: "/x",
      daemonScript: "/y",
      daemonPath: PLIST_PATH,
    });
    expect(xml).toContain("<key>KeepAlive</key>");
    expect(xml).toContain("<key>RunAtLoad</key>");
    expect(xml).toMatch(/<key>KeepAlive<\/key>\s*<true\/>/);
    expect(xml).toMatch(/<key>RunAtLoad<\/key>\s*<true\/>/);
  });

  test("escapes XML special characters in paths", () => {
    const xml = renderPlist({
      bunPath: "/Users/a&b/bin/bun",
      daemonScript: "/abs/<dir>/daemon.ts",
      daemonPath: PLIST_PATH,
    });
    expect(xml).toContain("<string>/Users/a&amp;b/bin/bun</string>");
    expect(xml).toContain("<string>/abs/&lt;dir&gt;/daemon.ts</string>");
    // Raw unescaped characters must not appear in the path strings.
    expect(xml).not.toContain("<string>/Users/a&b/bin/bun</string>");
    expect(xml).not.toContain("<string>/abs/<dir>/daemon.ts</string>");
  });

  // --- T4 (🔌 launchd-PATH, ACs 8/9) ---

  test("injects EnvironmentVariables → PATH with the bun + fallback dirs (AC8)", () => {
    const xml = renderPlist({
      bunPath: "/Users/x/.bun/bin/bun",
      daemonScript: "/abs/cli/daemon.ts",
      daemonPath: PLIST_PATH,
    });
    expect(xml).toContain("<key>EnvironmentVariables</key>");
    expect(xml).toContain("<key>PATH</key>");
    expect(xml).toContain(`<string>${PLIST_PATH}</string>`);
    // bun dir + fallback dirs present in the PATH value.
    expect(xml).toContain("/Users/x/.bun/bin");
    expect(xml).toContain("/opt/homebrew/bin");
    expect(xml).toContain("/usr/local/bin");
  });

  test("does NOT add WorkingDirectory (daemon is machine-global)", () => {
    const xml = renderPlist({
      bunPath: "/x",
      daemonScript: "/y",
      daemonPath: PLIST_PATH,
    });
    expect(xml).not.toContain("WorkingDirectory");
  });

  test("escapes XML special characters in the PATH value", () => {
    const xml = renderPlist({
      bunPath: "/x",
      daemonScript: "/y",
      daemonPath: "/Users/a&b/bin:/usr/bin",
    });
    expect(xml).toContain("<string>/Users/a&amp;b/bin:/usr/bin</string>");
  });

  test("idempotent: same inputs render byte-identical output (AC9)", () => {
    const input = {
      bunPath: "/Users/x/.bun/bin/bun",
      daemonScript: "/abs/cli/daemon.ts",
      daemonPath: PLIST_PATH,
    };
    expect(renderPlist(input)).toBe(renderPlist(input));
  });

  test("SILTPOKE_HOME flows into StandardOutPath/StandardErrorPath", () => {
    const prev = process.env.SILTPOKE_HOME;
    process.env.SILTPOKE_HOME = "/scratch";
    try {
      const xml = renderPlist({
        bunPath: "/x",
        daemonScript: "/y",
        daemonPath: PLIST_PATH,
      });
      expect(xml).toContain(
        "<key>StandardOutPath</key><string>/scratch/logs/daemon.log</string>",
      );
      expect(xml).toContain(
        "<key>StandardErrorPath</key><string>/scratch/logs/daemon.err</string>",
      );
      expect(xml).not.toContain(".siltpoke/logs");
    } finally {
      if (prev === undefined) {
        delete process.env.SILTPOKE_HOME;
      } else {
        process.env.SILTPOKE_HOME = prev;
      }
    }
  });
});

function fakeExec(status = 0) {
  const calls: Array<{ cmd: string; args: string[] }> = [];
  return {
    calls,
    exec: (cmd: string, args: string[]) => {
      calls.push({ cmd, args });
      return { status };
    },
  };
}

describe("loadLaunchAgent", () => {
  test("boots out by label then bootstraps the plist (AC-shared)", () => {
    const { calls, exec } = fakeExec(0);
    loadLaunchAgent("/tmp/x.plist", "io.siltpoke.demo", 501, exec);
    expect(calls).toEqual([
      { cmd: "launchctl", args: ["bootout", "gui/501/io.siltpoke.demo"] },
      { cmd: "launchctl", args: ["bootstrap", "gui/501", "/tmp/x.plist"] },
    ]);
  });

  test("throws when bootstrap fails (bootout failure ignored)", () => {
    // exec returns non-zero for BOTH calls; bootout non-zero is ignored,
    // bootstrap non-zero must throw.
    const exec = (_cmd: string, _args: string[]) => ({ status: 1 });
    expect(() => loadLaunchAgent("/tmp/x.plist", "io.siltpoke.demo", 501, exec)).toThrow(
      "launchctl bootstrap failed",
    );
  });
});

describe("uninstallAutostart (launchd)", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "siltpoke-launchd-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  test("removes existing plist and boots out the gui/<uid> label (AC10)", async () => {
    const plistPath = join(dir, "io.siltpoke.daemon.plist");
    writeFileSync(plistPath, "<plist/>");
    const { calls, exec } = fakeExec();
    const r = await uninstallAutostart({ exec, plistPath, uid: 501 });
    expect(r).toEqual({ removed: true });
    expect(existsSync(plistPath)).toBe(false);
    expect(calls).toEqual([
      { cmd: "launchctl", args: ["bootout", "gui/501/io.siltpoke.daemon"] },
    ]);
  });

  test("no-op silently when plist absent — no launchctl call, removed:false", async () => {
    const { calls, exec } = fakeExec();
    const r = await uninstallAutostart({
      exec,
      plistPath: join(dir, "io.siltpoke.daemon.plist"),
      uid: 501,
    });
    expect(r).toEqual({ removed: false });
    expect(calls).toEqual([]);
  });

  test("launchctl bootout failure is ignored — plist still removed", async () => {
    const plistPath = join(dir, "io.siltpoke.daemon.plist");
    writeFileSync(plistPath, "<plist/>");
    const { exec } = fakeExec(3); // launchctl exits non-zero (not loaded)
    const r = await uninstallAutostart({ exec, plistPath, uid: 501 });
    expect(r).toEqual({ removed: true });
    expect(existsSync(plistPath)).toBe(false);
  });
});
