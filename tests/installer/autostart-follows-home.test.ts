// Defect [66]: every autostart install / uninstall path must write and remove
// under the `home` it is given, never os.homedir(). Bun's os.homedir() does not
// follow a runtime HOME change, so each test passes the home explicitly.
// launchctl / systemctl are never called: installAutostart takes an exec seam
// (launchd), uninstalls take `exec`, and the dispatcher takes module loaders.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, mkdirSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { siltpokeRoot } from "../../src/installer/paths";
import { installAutostartForPlatform, uninstallAutostartForPlatform } from "../../src/installer/autostart";
import { defaultPlistPath, installAutostart, renderPlist, uninstallAutostart as uninstallLaunchd } from "../../src/installer/launchd";
import { uninstallSwiftbarAutostart } from "../../src/installer/swiftbar-autostart";
import { defaultUnitPath, renderUnit, uninstallAutostart as uninstallSystemd } from "../../src/installer/systemd";

const unit = { bunPath: "/x", daemonScript: "/y", daemonPath: "/bin" };

function spyExec() {
  const calls: Array<{ cmd: string; args: string[] }> = [];
  return {
    calls,
    exec: (cmd: string, args: string[]) => {
      calls.push({ cmd, args });
      return { status: 0 };
    },
  };
}

/** existence + mtime of a path in the REAL home, so a leak shows as a change. */
function snapshot(p: string): string {
  return existsSync(p) ? `present:${statSync(p).mtimeMs}` : "absent";
}

let tmpHome: string;
let savedSiltpokeHome: string | undefined;
beforeEach(() => {
  tmpHome = mkdtempSync(join(tmpdir(), "siltpoke-home66-"));
  savedSiltpokeHome = process.env.SILTPOKE_HOME;
  delete process.env.SILTPOKE_HOME;
});
afterEach(() => {
  if (savedSiltpokeHome === undefined) delete process.env.SILTPOKE_HOME;
  else process.env.SILTPOKE_HOME = savedSiltpokeHome;
  rmSync(tmpHome, { recursive: true, force: true });
});

describe("default paths follow the home they are given", () => {
  test("plist / unit path are computed from home", () => {
    expect(defaultPlistPath(tmpHome)).toBe(join(tmpHome, "Library", "LaunchAgents", "io.siltpoke.daemon.plist"));
    expect(defaultUnitPath(tmpHome, {})).toBe(join(tmpHome, ".config", "systemd", "user", "siltpoked.service"));
  });

  test('empty home (HOME="") is treated as unset — the real-home path, never a relative one', () => {
    expect(defaultPlistPath("")).toBe(defaultPlistPath(homedir()));
    expect(defaultUnitPath("", {})).toBe(defaultUnitPath(homedir(), {}));
    expect(renderPlist(unit, "")).toContain(`<string>${siltpokeRoot()}/logs/daemon.log</string>`);
    expect(renderUnit(unit, "")).toContain(`append:${siltpokeRoot()}/logs/daemon.log`);
  });

  test("no home → still the real home (production unchanged)", () => {
    expect(defaultPlistPath()).toBe(defaultPlistPath(homedir()));
    expect(defaultUnitPath(undefined, {})).toBe(defaultUnitPath(homedir(), {}));
  });
});

describe("log paths inside the plist / unit follow home", () => {
  test("renderPlist logs under <home>/.siltpoke", () => {
    const xml = renderPlist(unit, tmpHome);
    expect(xml).toContain(`<string>${tmpHome}/.siltpoke/logs/daemon.log</string>`);
    expect(xml).toContain(`<string>${tmpHome}/.siltpoke/logs/daemon.err</string>`);
  });

  test("renderUnit logs under <home>/.siltpoke", () => {
    const text = renderUnit(unit, tmpHome);
    expect(text).toContain(`StandardOutput=append:${tmpHome}/.siltpoke/logs/daemon.log`);
    expect(text).toContain(`StandardError=append:${tmpHome}/.siltpoke/logs/daemon.err`);
  });

  test("SILTPOKE_HOME override still wins", () => {
    process.env.SILTPOKE_HOME = "/custom/root";
    expect(renderPlist(unit, tmpHome)).toContain("<string>/custom/root/logs/daemon.log</string>");
    expect(renderUnit(unit, tmpHome)).toContain("append:/custom/root/logs/daemon.log");
  });
});

describe("launchd installAutostart(home)", () => {
  test.skipIf(process.platform !== "darwin")("writes the plist + log dir under home, not the real home", async () => {
    const real = defaultPlistPath();
    const before = snapshot(real);
    const { calls, exec } = spyExec();
    await installAutostart(tmpHome, exec);

    const plist = join(tmpHome, "Library", "LaunchAgents", "io.siltpoke.daemon.plist");
    expect(existsSync(plist)).toBe(true);
    expect(readFileSync(plist, "utf8")).toContain(`${tmpHome}/.siltpoke/logs/daemon.log`);
    expect(existsSync(join(tmpHome, ".siltpoke", "logs"))).toBe(true);
    // launchctl was pointed at the temp plist, via the seam only.
    expect(calls.at(-1)?.args).toEqual(["bootstrap", `gui/${process.getuid?.() ?? 0}`, plist]);
    // The real LaunchAgents plist was neither created nor touched.
    expect(snapshot(real)).toBe(before);
  });
});

// A fake `id -P` saying the account home IS the temp home: these tests are about
// which home is read, not about [86] (see uninstall-other-home-leaves-account-alone).
const ownHome = () => ({ status: 0, stdout: `me:*:501:20::0:0:Me:${tmpHome}:/bin/zsh\n` });

describe("uninstalls remove from the given home only", () => {
  test("launchd uninstallAutostart({home})", async () => {
    const plist = defaultPlistPath(tmpHome);
    mkdirSync(dirname(plist), { recursive: true });
    writeFileSync(plist, "<plist/>");
    const real = defaultPlistPath();
    const before = snapshot(real);
    const { calls, exec } = spyExec();
    expect(await uninstallLaunchd({ home: tmpHome, exec, uid: 501, probe: ownHome })).toEqual({ removed: true });
    expect(existsSync(plist)).toBe(false);
    expect(calls).toHaveLength(1);
    expect(snapshot(real)).toBe(before);
  });

  test("launchd uninstallAutostart({home}) with nothing under home: no-op, no launchctl", async () => {
    const { calls, exec } = spyExec();
    expect(await uninstallLaunchd({ home: tmpHome, exec })).toEqual({ removed: false });
    expect(calls).toEqual([]);
  });

  test("systemd uninstallAutostart({home})", async () => {
    const unitPath = defaultUnitPath(tmpHome, {});
    mkdirSync(dirname(unitPath), { recursive: true });
    writeFileSync(unitPath, "[Unit]");
    const real = defaultUnitPath(undefined, {});
    const before = snapshot(real);
    const { exec } = spyExec();
    expect(await uninstallSystemd({ home: tmpHome, env: {}, exec })).toEqual({ removed: true });
    expect(existsSync(unitPath)).toBe(false);
    expect(snapshot(real)).toBe(before);
  });

  test("uninstallSwiftbarAutostart({home})", () => {
    const plist = join(tmpHome, "Library", "LaunchAgents", "io.siltpoke.swiftbar.plist");
    mkdirSync(dirname(plist), { recursive: true });
    writeFileSync(plist, "<plist/>");
    const { calls, exec } = spyExec();
    expect(uninstallSwiftbarAutostart({ home: tmpHome, exec, uid: 501, probe: ownHome })).toEqual({ removed: true });
    expect(existsSync(plist)).toBe(false);
    expect(calls).toEqual([{ cmd: "launchctl", args: ["bootout", "gui/501/io.siltpoke.swiftbar"] }]);
  });

  test("uninstallSwiftbarAutostart({home}) nothing under home → no-op even if the real home has one", () => {
    const { calls, exec } = spyExec();
    expect(uninstallSwiftbarAutostart({ home: tmpHome, exec })).toEqual({ removed: false });
    expect(calls).toEqual([]);
  });
});

describe("platform dispatcher hands home to the platform module", () => {
  test("install", async () => {
    let got: string | undefined = "unset";
    await installAutostartForPlatform({
      platform: "darwin",
      home: tmpHome,
      loadLaunchd: async () => ({
        installAutostart: async (h?: string) => {
          got = h;
        },
      }),
    });
    expect(got).toBe(tmpHome);
  });

  test("uninstall (launchd and systemd)", async () => {
    const seen: Array<string | undefined> = [];
    const mod = {
      uninstallAutostart: async (o?: { home?: string }) => {
        seen.push(o?.home);
        return { removed: false };
      },
    };
    await uninstallAutostartForPlatform({ platform: "darwin", home: tmpHome, loadLaunchd: async () => mod });
    await uninstallAutostartForPlatform({ platform: "linux", home: tmpHome, loadSystemd: async () => mod });
    expect(seen).toEqual([tmpHome, tmpHome]);
  });
});
