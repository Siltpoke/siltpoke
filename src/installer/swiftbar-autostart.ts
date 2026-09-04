// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
// Copyright (c) 2026 Jiaqi Duan

import { spawnSync } from "node:child_process";
import { mkdirSync, existsSync as realExistsSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { type ExecSyncFn, loadLaunchAgent } from "./launchd";

const SWIFTBAR_APP_PATH = "/Applications/SwiftBar.app";
const SWIFTBAR_LABEL = "io.siltpoke.swiftbar";

/**
 * SwiftBar login-item plist. Static: `open -a SwiftBar` at every login, no
 * KeepAlive (open exits after handing off to SwiftBar.app; KeepAlive would
 * treat that as a crash and relaunch-loop).
 */
export function renderSwiftbarPlist(): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>io.siltpoke.swiftbar</string>
  <key>ProgramArguments</key>
  <array>
    <string>/usr/bin/open</string>
    <string>-a</string>
    <string>SwiftBar</string>
  </array>
  <key>RunAtLoad</key><true/>
</dict>
</plist>`;
}

export type SwiftbarAutostartReason = "not-darwin" | "swiftbar-absent" | "ok";

export interface SwiftbarAutostartResult {
  installed: boolean;
  reason: SwiftbarAutostartReason;
}

export interface SwiftbarAutostartOptions {
  platform?: NodeJS.Platform;
  exec?: ExecSyncFn;
  existsSync?: (p: string) => boolean;
  home?: string;
  plistPath?: string;
  uid?: number;
  writeFile?: (p: string, c: string) => void;
  /** Directory-creation seam — injectable so callers can route it through their
   * own exec/fs adapter instead of touching the real filesystem. Defaults to
   * `mkdirSync(dir, { recursive: true })`. */
  mkdirSync?: (dir: string) => void;
}

function defaultPlistPath(home: string): string {
  return join(home, "Library", "LaunchAgents", "io.siltpoke.swiftbar.plist");
}

const realExec: ExecSyncFn = (cmd, args) => spawnSync(cmd, args, { stdio: "ignore" });

/**
 * Register SwiftBar to auto-launch at login (AC20). Guard (AC21): only if
 * SwiftBar.app is actually installed — otherwise skip, never write a dangling
 * `open -a` login item. macOS-only.
 */
export function installSwiftbarAutostart(
  opts: SwiftbarAutostartOptions = {},
): SwiftbarAutostartResult {
  const platform = opts.platform ?? process.platform;
  if (platform !== "darwin") {
    return { installed: false, reason: "not-darwin" };
  }
  const existsSync = opts.existsSync ?? realExistsSync;
  if (!existsSync(SWIFTBAR_APP_PATH)) {
    return { installed: false, reason: "swiftbar-absent" };
  }
  const home = opts.home ?? homedir();
  const plistPath = opts.plistPath ?? defaultPlistPath(home);
  const writeFile = opts.writeFile ?? ((p: string, c: string) => writeFileSync(p, c));
  const exec = opts.exec ?? realExec;
  const uid = opts.uid ?? process.getuid?.() ?? 0;
  const mkdir = opts.mkdirSync ?? ((dir: string) => mkdirSync(dir, { recursive: true }));

  mkdir(dirname(plistPath));
  writeFile(plistPath, renderSwiftbarPlist());
  loadLaunchAgent(plistPath, SWIFTBAR_LABEL, uid, exec);
  return { installed: true, reason: "ok" };
}

export function uninstallSwiftbarAutostart(
  opts: { exec?: ExecSyncFn; existsSync?: (p: string) => boolean; plistPath?: string; uid?: number } = {},
): { removed: boolean } {
  const existsSync = opts.existsSync ?? realExistsSync;
  const plistPath = opts.plistPath ?? defaultPlistPath(homedir());
  if (!existsSync(plistPath)) {
    return { removed: false };
  }
  const exec = opts.exec ?? realExec;
  const uid = opts.uid ?? process.getuid?.() ?? 0;
  exec("launchctl", ["bootout", `gui/${uid}/${SWIFTBAR_LABEL}`]);
  try {
    rmSync(plistPath, { force: true });
  } catch {
    // best-effort — never block uninstall
  }
  return { removed: true };
}
