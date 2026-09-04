// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
// Copyright (c) 2026 Jiaqi Duan
//
// Shared platform dispatch for daemon autostart (track #6 T2).
// darwin → installer/launchd.ts, linux → installer/systemd.ts, else skip.
// Used by both `siltpoked install-autostart` (src/cli/daemon.ts) and the
// setup wizard's autostart question (src/cli/install.ts).

/** Shape both platform installers export. */
export interface AutostartModule {
  /**
   * `home` is the home dir the CALLER is installing into — cli/configure.ts
   * takes it as an argument and writes the shim under it, so the unit must be
   * rendered against the SAME home rather than re-deriving os.homedir(). They
   * coincide on POSIX today; a test home (or a HOME override) makes them differ,
   * and then the unit would point at a shim that isn't the one just written.
   */
  installAutostart(home?: string): Promise<void>;
}

export type AutostartDispatchResult =
  | { status: "installed"; platform: string }
  | { status: "skipped"; platform: string }
  | { status: "unavailable"; platform: string; module: "launchd" | "systemd" };

export interface InstallAutostartForPlatformOptions {
  /** Defaults to process.platform. Injectable for tests. */
  platform?: string;
  /** Home dir to install into. Defaults (in the platform module) to os.homedir(). */
  home?: string;
  /** Module loaders — injectable so tests never touch launchctl/systemctl. */
  loadLaunchd?: () => Promise<AutostartModule | null>;
  loadSystemd?: () => Promise<AutostartModule | null>;
}

async function dispatch(
  moduleName: "launchd" | "systemd",
  platform: string,
  load: () => Promise<AutostartModule | null>,
  home?: string,
): Promise<AutostartDispatchResult> {
  const mod = await load();
  if (!mod || typeof mod.installAutostart !== "function") {
    return { status: "unavailable", platform, module: moduleName };
  }
  await mod.installAutostart(home);
  return { status: "installed", platform };
}

/**
 * Install daemon autostart for the current (or injected) platform.
 * Never throws for unsupported platforms or missing installer modules —
 * those come back as `skipped` / `unavailable` results. Installer failures
 * (e.g. `launchctl bootstrap failed`) DO propagate so callers can decide
 * (daemon.ts crashes loudly; the wizard catches + warns + continues).
 */
export async function installAutostartForPlatform(
  opts: InstallAutostartForPlatformOptions = {},
): Promise<AutostartDispatchResult> {
  const platform = opts.platform ?? process.platform;
  if (platform === "darwin") {
    const load =
      opts.loadLaunchd ?? (() => import("./launchd").catch(() => null));
    return dispatch("launchd", platform, load, opts.home);
  }
  if (platform === "linux") {
    const load =
      opts.loadSystemd ?? (() => import("./systemd").catch(() => null));
    return dispatch("systemd", platform, load, opts.home);
  }
  return { status: "skipped", platform };
}

/** Shape both platform uninstallers export (track #6 T4). */
export interface AutostartUninstallModule {
  uninstallAutostart(): Promise<{ removed: boolean }>;
}

export type AutostartUninstallResult =
  | { status: "removed"; platform: string }
  | { status: "not-installed"; platform: string }
  | { status: "skipped"; platform: string }
  | { status: "unavailable"; platform: string; module: "launchd" | "systemd" };

export interface UninstallAutostartForPlatformOptions {
  /** Defaults to process.platform. Injectable for tests. */
  platform?: string;
  /** Module loaders — injectable so tests never touch launchctl/systemctl. */
  loadLaunchd?: () => Promise<AutostartUninstallModule | null>;
  loadSystemd?: () => Promise<AutostartUninstallModule | null>;
}

async function dispatchUninstall(
  moduleName: "launchd" | "systemd",
  platform: string,
  load: () => Promise<AutostartUninstallModule | null>,
): Promise<AutostartUninstallResult> {
  const mod = await load();
  if (!mod || typeof mod.uninstallAutostart !== "function") {
    return { status: "unavailable", platform, module: moduleName };
  }
  const r = await mod.uninstallAutostart();
  return { status: r.removed ? "removed" : "not-installed", platform };
}

/**
 * Remove daemon autostart for the current (or injected) platform (AC10).
 * Mirrors installAutostartForPlatform: unsupported platform / missing module
 * come back as `skipped` / `unavailable`, never a throw. `not-installed` =
 * silent no-op (nothing was on disk). Uninstaller errors DO propagate —
 * cli/uninstall.ts catches and continues (cleanup must never block uninstall).
 */
export async function uninstallAutostartForPlatform(
  opts: UninstallAutostartForPlatformOptions = {},
): Promise<AutostartUninstallResult> {
  const platform = opts.platform ?? process.platform;
  if (platform === "darwin") {
    const load =
      opts.loadLaunchd ?? (() => import("./launchd").catch(() => null));
    return dispatchUninstall("launchd", platform, load);
  }
  if (platform === "linux") {
    const load =
      opts.loadSystemd ?? (() => import("./systemd").catch(() => null));
    return dispatchUninstall("systemd", platform, load);
  }
  return { status: "skipped", platform };
}
