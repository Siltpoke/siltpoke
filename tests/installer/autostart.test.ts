import { describe, test, expect } from "bun:test";
import {
  installAutostartForPlatform,
  uninstallAutostartForPlatform,
  type AutostartModule,
  type AutostartUninstallModule,
} from "../../src/installer/autostart";

function fakeModule(): { mod: AutostartModule; calls: () => number } {
  let n = 0;
  return {
    mod: {
      async installAutostart() {
        n++;
      },
    },
    calls: () => n,
  };
}

function mustNotLoad(name: string): () => Promise<AutostartModule | null> {
  return async () => {
    throw new Error(`${name} loader must not be called`);
  };
}

describe("installAutostartForPlatform", () => {
  test("darwin dispatches to the launchd installer (AC1)", async () => {
    const launchd = fakeModule();
    const result = await installAutostartForPlatform({
      platform: "darwin",
      loadLaunchd: async () => launchd.mod,
      loadSystemd: mustNotLoad("systemd"),
    });
    expect(result).toEqual({ status: "installed", platform: "darwin" });
    expect(launchd.calls()).toBe(1);
  });

  test("linux dispatches to the systemd installer (AC2)", async () => {
    const systemd = fakeModule();
    const result = await installAutostartForPlatform({
      platform: "linux",
      loadLaunchd: mustNotLoad("launchd"),
      loadSystemd: async () => systemd.mod,
    });
    expect(result).toEqual({ status: "installed", platform: "linux" });
    expect(systemd.calls()).toBe(1);
  });

  test("unsupported platform (win32) skips without throwing", async () => {
    const result = await installAutostartForPlatform({
      platform: "win32",
      loadLaunchd: mustNotLoad("launchd"),
      loadSystemd: mustNotLoad("systemd"),
    });
    expect(result).toEqual({ status: "skipped", platform: "win32" });
  });

  test("missing installer module reports unavailable (no throw)", async () => {
    const result = await installAutostartForPlatform({
      platform: "darwin",
      loadLaunchd: async () => null,
      loadSystemd: mustNotLoad("systemd"),
    });
    expect(result).toEqual({
      status: "unavailable",
      platform: "darwin",
      module: "launchd",
    });
  });

  test("second call dispatches again — no once-only latch (AC5 idempotency)", async () => {
    const launchd = fakeModule();
    const opts = {
      platform: "darwin",
      loadLaunchd: async () => launchd.mod,
      loadSystemd: mustNotLoad("systemd"),
    };
    await installAutostartForPlatform(opts);
    await installAutostartForPlatform(opts);
    expect(launchd.calls()).toBe(2);
  });

  test("installer failure propagates to the caller (wizard catches it)", async () => {
    const boom: AutostartModule = {
      async installAutostart() {
        throw new Error("launchctl bootstrap failed");
      },
    };
    await expect(
      installAutostartForPlatform({
        platform: "darwin",
        loadLaunchd: async () => boom,
        loadSystemd: mustNotLoad("systemd"),
      }),
    ).rejects.toThrow("launchctl bootstrap failed");
  });
});

function fakeUninstallModule(removed: boolean): {
  mod: AutostartUninstallModule;
  calls: () => number;
} {
  let n = 0;
  return {
    mod: {
      async uninstallAutostart() {
        n++;
        return { removed };
      },
    },
    calls: () => n,
  };
}

function mustNotLoadUninstall(
  name: string,
): () => Promise<AutostartUninstallModule | null> {
  return async () => {
    throw new Error(`${name} loader must not be called`);
  };
}

describe("uninstallAutostartForPlatform", () => {
  test("darwin dispatches to the launchd uninstaller (AC10)", async () => {
    const launchd = fakeUninstallModule(true);
    const result = await uninstallAutostartForPlatform({
      platform: "darwin",
      loadLaunchd: async () => launchd.mod,
      loadSystemd: mustNotLoadUninstall("systemd"),
    });
    expect(result).toEqual({ status: "removed", platform: "darwin" });
    expect(launchd.calls()).toBe(1);
  });

  test("linux dispatches to the systemd uninstaller (AC10)", async () => {
    const systemd = fakeUninstallModule(true);
    const result = await uninstallAutostartForPlatform({
      platform: "linux",
      loadLaunchd: mustNotLoadUninstall("launchd"),
      loadSystemd: async () => systemd.mod,
    });
    expect(result).toEqual({ status: "removed", platform: "linux" });
    expect(systemd.calls()).toBe(1);
  });

  test("nothing installed reports not-installed (silent no-op)", async () => {
    const launchd = fakeUninstallModule(false);
    const result = await uninstallAutostartForPlatform({
      platform: "darwin",
      loadLaunchd: async () => launchd.mod,
      loadSystemd: mustNotLoadUninstall("systemd"),
    });
    expect(result).toEqual({ status: "not-installed", platform: "darwin" });
  });

  test("unsupported platform (win32) skips without throwing", async () => {
    const result = await uninstallAutostartForPlatform({
      platform: "win32",
      loadLaunchd: mustNotLoadUninstall("launchd"),
      loadSystemd: mustNotLoadUninstall("systemd"),
    });
    expect(result).toEqual({ status: "skipped", platform: "win32" });
  });

  test("missing uninstaller module reports unavailable (no throw)", async () => {
    const result = await uninstallAutostartForPlatform({
      platform: "linux",
      loadLaunchd: mustNotLoadUninstall("launchd"),
      loadSystemd: async () => null,
    });
    expect(result).toEqual({
      status: "unavailable",
      platform: "linux",
      module: "systemd",
    });
  });
});
