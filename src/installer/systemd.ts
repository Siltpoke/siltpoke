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

interface UnitInput {
  /**
   * The program the unit execs. `bun` for a repo install; `/bin/sh` when the
   * daemon is reached through ~/.siltpoke/bin/daemon.sh (plugin install) —
   * see resolveDaemonLauncher.
   */
  bunPath: string;
  /** Its argument: the repo's src/cli/daemon.ts, or the daemon shim. */
  daemonScript: string;
  /** PATH injected into the daemon's systemd env (see resolveDaemonPath). */
  daemonPath: string;
}

/**
 * Canonical systemd user-unit location. Shared by installAutostart /
 * uninstallAutostart and the doctor autostart-presence check (track #6 T5).
 */
export function defaultUnitPath(): string {
  return join(homedir(), ".config", "systemd", "user", "siltpoked.service");
}

function escapeExecPath(s: string): string {
  // systemd `ExecStart` splits on space; replace with literal escaped form.
  return s.replace(/ /g, "\\x20");
}

export function renderUnit({
  bunPath,
  daemonScript,
  daemonPath,
}: UnitInput): string {
  return `[Unit]
Description=Siltpoke daemon
After=default.target

[Service]
Type=simple
ExecStart=${escapeExecPath(bunPath)} ${escapeExecPath(daemonScript)} start
Environment="PATH=${daemonPath}"
Restart=always
RestartSec=10
StandardOutput=append:${siltpokeRoot()}/logs/daemon.log
StandardError=append:${siltpokeRoot()}/logs/daemon.err

[Install]
WantedBy=default.target
`;
}

export async function installAutostart(home: string = homedir()): Promise<void> {
  if (process.platform !== "linux") {
    process.stderr.write(
      "installAutostart (systemd-user) requires Linux. For macOS use installer/launchd.ts.\n",
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
  // resolveDaemonEntry, NOT `new URL("../cli/daemon.ts", import.meta.url)` —
  // see the identical note in launchd.ts. Bundled, that expression drops `src/`
  // and writes a nonexistent ExecStart into the unit.
  const launcher = resolveDaemonLauncher(bunPath, resolveDaemonEntry(import.meta.dir), home);
  // Resolve the daemon's PATH at install time (mirrors the `which bun` above) so
  // the systemd-spawned daemon can find `claude`/`bun` by bare name. A failed
  // `which claude` does not abort — resolveDaemonPath falls back + warns.
  const { path: daemonPath, warnings } = resolveDaemonPath();
  for (const w of warnings) {
    process.stderr.write(`warning: ${w}\n`);
  }
  const unit = renderUnit({
    bunPath: launcher.program,
    daemonScript: launcher.script,
    daemonPath,
  });

  const unitPath = defaultUnitPath();
  mkdirSync(dirname(unitPath), { recursive: true });
  writeFileSync(unitPath, unit);

  mkdirSync(join(siltpokeRoot(), "logs"), { recursive: true });

  spawnSync("systemctl", ["--user", "daemon-reload"], { stdio: "inherit" });
  const r = spawnSync(
    "systemctl",
    ["--user", "enable", "--now", "siltpoked.service"],
    { stdio: "inherit" },
  );
  if (r.status !== 0) {
    throw new Error("systemctl --user enable --now failed");
  }
  process.stdout.write(`Installed systemd-user unit at ${unitPath}\n`);
}

export interface UninstallAutostartOptions {
  /** Injectable exec — tests never touch systemctl. Defaults to real spawnSync. */
  exec?: ExecSyncFn;
  /** Defaults to ~/.config/systemd/user/siltpoked.service. */
  unitPath?: string;
}

export interface UninstallAutostartResult {
  removed: boolean;
}

/**
 * Remove the siltpoke systemd user unit (track #6 T4, AC10).
 * Silent no-op when the unit file is absent (nothing installed → no
 * systemctl call at all). `systemctl` failures are ignored — unit removal +
 * daemon-reload are best-effort.
 */
export async function uninstallAutostart(
  opts: UninstallAutostartOptions = {},
): Promise<UninstallAutostartResult> {
  const unitPath = opts.unitPath ?? defaultUnitPath();
  if (!existsSync(unitPath)) {
    return { removed: false };
  }
  const exec: ExecSyncFn =
    opts.exec ?? ((cmd, args) => spawnSync(cmd, args, { stdio: "ignore" }));
  // Stop + disable (ignore failure — may not be enabled/running).
  exec("systemctl", ["--user", "disable", "--now", "siltpoked.service"]);
  try {
    rmSync(unitPath, { force: true });
  } catch {
    // best-effort cleanup — never block uninstall
  }
  exec("systemctl", ["--user", "daemon-reload"]);
  return { removed: true };
}
