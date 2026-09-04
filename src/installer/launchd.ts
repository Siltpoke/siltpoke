// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
// Copyright (c) 2026 Jiaqi Duan
import { writeFileSync, mkdirSync, existsSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { homedir } from "node:os";
import { spawnSync } from "node:child_process";
import { resolveDaemonEntry, resolveDaemonLauncher, resolveDaemonPath } from "./daemon-path";
import { siltpokeRoot } from "./paths";

/** Minimal exec seam (status is all we read). Defaults to real spawnSync. */
export type ExecSyncFn = (
  cmd: string,
  args: string[],
) => { status: number | null };

interface PlistInput {
  /**
   * The program the unit execs. `bun` for a repo install; `/bin/sh` when the
   * daemon is reached through ~/.siltpoke/bin/daemon.sh (plugin install) —
   * see resolveDaemonLauncher.
   */
  bunPath: string;
  /** Its argument: the repo's src/cli/daemon.ts, or the daemon shim. */
  daemonScript: string;
  /** PATH injected into the daemon's launchd env (see resolveDaemonPath). */
  daemonPath: string;
}

/**
 * Canonical LaunchAgent plist location. Shared by installAutostart /
 * uninstallAutostart and the doctor autostart-presence check (track #6 T5).
 */
export function defaultPlistPath(): string {
  return join(homedir(), "Library", "LaunchAgents", "io.siltpoke.daemon.plist");
}

function xmlEscape(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

export function renderPlist({
  bunPath,
  daemonScript,
  daemonPath,
}: PlistInput): string {
  const logRoot = xmlEscape(siltpokeRoot());
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>io.siltpoke.daemon</string>
  <key>ProgramArguments</key>
  <array>
    <string>${xmlEscape(bunPath)}</string>
    <string>${xmlEscape(daemonScript)}</string>
    <string>start</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key><string>${xmlEscape(daemonPath)}</string>
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>10</integer>
  <key>StandardOutPath</key><string>${logRoot}/logs/daemon.log</string>
  <key>StandardErrorPath</key><string>${logRoot}/logs/daemon.err</string>
</dict>
</plist>`;
}

/**
 * Shared launchctl (re)load: bootout by label (ignore not-loaded failure) then
 * bootstrap the plist. Used by both the daemon autostart and the SwiftBar
 * login-item. Throws if bootstrap fails.
 */
export function loadLaunchAgent(
  plistPath: string,
  label: string,
  uid: number,
  exec: ExecSyncFn,
): void {
  exec("launchctl", ["bootout", `gui/${uid}/${label}`]);
  const r = exec("launchctl", ["bootstrap", `gui/${uid}`, plistPath]);
  if (r.status !== 0) {
    throw new Error("launchctl bootstrap failed");
  }
}

export async function installAutostart(home: string = homedir()): Promise<void> {
  if (process.platform !== "darwin") {
    process.stderr.write(
      "installAutostart (launchd) requires macOS. For Linux use installer/systemd.ts.\n",
    );
    process.exit(2);
  }
  const which = spawnSync("which", ["bun"], { encoding: "utf8" });
  const bunPath = (which.stdout || "").trim();
  if (!bunPath) {
    throw new Error("bun not found in PATH");
  }
  // Plugin install ⇒ exec the shim (version-proof); repo install ⇒ exec the
  // checkout's daemon entry directly, as before. `home` is threaded from the
  // caller (cli/configure.ts writes the shim under the SAME home) rather than
  // re-derived here.
  // resolveDaemonEntry, NOT `new URL("../cli/daemon.ts", import.meta.url)`:
  // this file is inlined into dist/siltpoke-configure.js and
  // dist/siltpoke-daemon.js, where that expression drops `src/` and bakes a
  // path that exists nowhere into the plist. Normally masked because a plugin
  // install takes the shim branch below — but `cmdInstallAutostart` reaches
  // here with no shim written, so the repo branch was live and broken.
  const launcher = resolveDaemonLauncher(bunPath, resolveDaemonEntry(import.meta.dir), home);
  // Resolve the daemon's PATH at install time (mirrors the `which bun` above) so
  // the launchd-spawned daemon can find `claude`/`bun` by bare name. A failed
  // `which claude` does not abort — resolveDaemonPath falls back + warns.
  const { path: daemonPath, warnings } = resolveDaemonPath();
  for (const w of warnings) {
    process.stderr.write(`warning: ${w}\n`);
  }
  const xml = renderPlist({
    bunPath: launcher.program,
    daemonScript: launcher.script,
    daemonPath,
  });

  const plistPath = defaultPlistPath();
  mkdirSync(dirname(plistPath), { recursive: true });
  writeFileSync(plistPath, xml);

  // Ensure log dir exists for StandardOutPath/StandardErrorPath.
  mkdirSync(join(siltpokeRoot(), "logs"), { recursive: true });

  const exec: ExecSyncFn = (cmd, args) =>
    spawnSync(cmd, args, { stdio: "ignore" });
  loadLaunchAgent(plistPath, "io.siltpoke.daemon", process.getuid?.() ?? 0, exec);
  process.stdout.write(`Installed LaunchAgent at ${plistPath}\n`);
}

export interface UninstallAutostartOptions {
  /** Injectable exec — tests never touch launchctl. Defaults to real spawnSync. */
  exec?: ExecSyncFn;
  /** Defaults to ~/Library/LaunchAgents/io.siltpoke.daemon.plist. */
  plistPath?: string;
  /** Defaults to process.getuid() — the gui/<uid> launchd domain. */
  uid?: number;
}

export interface UninstallAutostartResult {
  removed: boolean;
}

/**
 * Remove the siltpoke LaunchAgent (track #6 T4, AC10).
 * Silent no-op when the plist is absent (nothing installed → no launchctl
 * call at all). `launchctl bootout` failure is ignored — the service may not
 * be loaded; the plist removal is the part that matters.
 */
export async function uninstallAutostart(
  opts: UninstallAutostartOptions = {},
): Promise<UninstallAutostartResult> {
  const plistPath = opts.plistPath ?? defaultPlistPath();
  if (!existsSync(plistPath)) {
    return { removed: false };
  }
  const exec: ExecSyncFn =
    opts.exec ?? ((cmd, args) => spawnSync(cmd, args, { stdio: "ignore" }));
  const uid = opts.uid ?? process.getuid?.();
  // Unload by label (ignore failure — not loaded is fine).
  exec("launchctl", ["bootout", `gui/${uid}/io.siltpoke.daemon`]);
  try {
    rmSync(plistPath, { force: true });
  } catch {
    // best-effort cleanup — never block uninstall
  }
  return { removed: true };
}
