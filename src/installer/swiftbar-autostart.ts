// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
// Copyright (c) 2026 Jiaqi Duan

import { spawnSync } from "node:child_process";
import { mkdirSync, existsSync as realExistsSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { type ExecSyncFn, loadLaunchAgent } from "./launchd";
import { leftRunningNote, otherAccountHome, realAccountProbe } from "./account-home";
import { markDone, recordBefore } from "./receipt";
import { swiftbarLoginItemEntry } from "./receipt-sites";

/**
 * The only place this literal lives. `menubar-setup` re-exports it, and
 * `/siltpoke:siltpoke-menubar status` now shows it to the user, so a second hand-typed
 * copy would drift somewhere visible.
 */
export const SWIFTBAR_APP_PATH = "/Applications/SwiftBar.app";
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
  /** Env for the install receipt (`~/.siltpoke/receipt.json`); defaults to process.env. */
  env?: NodeJS.ProcessEnv;
}

/** Where the SwiftBar login item lives under this home. */
export function swiftbarPlistPath(home: string): string {
  return join(home || homedir(), "Library", "LaunchAgents", "io.siltpoke.swiftbar.plist");
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
  const home = opts.home || homedir();
  const plistPath = opts.plistPath ?? swiftbarPlistPath(home);
  const writeFile = opts.writeFile ?? ((p: string, c: string) => writeFileSync(p, c));
  const exec = opts.exec ?? realExec;
  const uid = opts.uid ?? process.getuid?.() ?? 0;
  const mkdir = opts.mkdirSync ?? ((dir: string) => mkdirSync(dir, { recursive: true }));

  // Receipt (spec §2.1): pending before the plist is written, done after it is loaded.
  const receiptEnv = opts.env ?? process.env;
  const entry = swiftbarLoginItemEntry(plistPath);
  recordBefore(entry, receiptEnv);
  mkdir(dirname(plistPath));
  writeFile(plistPath, renderSwiftbarPlist());
  loadLaunchAgent(plistPath, SWIFTBAR_LABEL, uid, exec);
  markDone(entry.id, receiptEnv);
  return { installed: true, reason: "ok" };
}

export function uninstallSwiftbarAutostart(
  opts: {
    exec?: ExecSyncFn;
    existsSync?: (p: string) => boolean;
    /** Home to remove from. Defaults to os.homedir(). Ignored when plistPath is set. */
    home?: string;
    plistPath?: string;
    uid?: number;
    /** `id -P` seam: decides whether `home` is this account's own. Defaults to the real one. */
    probe?: (cmd: string, args: string[]) => { status: number; stdout: string };
  } = {},
): { removed: boolean } {
  const existsSync = opts.existsSync ?? realExistsSync;
  const plistPath = opts.plistPath ?? swiftbarPlistPath(opts.home || homedir());
  if (!existsSync(plistPath)) {
    return { removed: false };
  }
  const exec = opts.exec ?? realExec;
  const uid = opts.uid ?? process.getuid?.() ?? 0;
  // launchd answers for the ACCOUNT: under another home, leave the real login item running (`[86]`).
  const home = opts.home || homedir();
  const account = otherAccountHome(home, opts.probe ?? realAccountProbe);
  if (account === null) exec("launchctl", ["bootout", `gui/${uid}/${SWIFTBAR_LABEL}`]);
  else process.stdout.write(leftRunningNote("login item", home, account));
  try {
    rmSync(plistPath, { force: true });
  } catch {
    // best-effort — never block uninstall
  }
  return { removed: true };
}
