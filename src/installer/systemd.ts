// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
// Copyright (c) 2026 Jiaqi Duan
import { writeFileSync, mkdirSync, existsSync, rmSync } from "node:fs";
import { bunForCommandString } from "./bun-path";
import { join, dirname, isAbsolute } from "node:path";
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
 *
 * systemd searches `$XDG_CONFIG_HOME/systemd/user` (fallback
 * `~/.config/systemd/user`), so a unit written anywhere else never takes
 * effect for a user with XDG_CONFIG_HOME set (defect [72]). Per the XDG Base
 * Directory spec an empty or non-absolute value is invalid and ignored.
 * `env` is threaded from the caller like `home`; it defaults to the process env.
 */
export function defaultUnitPath(
  home: string = homedir(),
  env: NodeJS.ProcessEnv = process.env,
): string {
  const xdg = env.XDG_CONFIG_HOME;
  const configHome = xdg && isAbsolute(xdg) ? xdg : join(home || homedir(), ".config");
  return join(configHome, "systemd", "user", "siltpoked.service");
}

/**
 * Where the daemon's logs go. SILTPOKE_HOME still wins (a deliberate override);
 * otherwise `<home>/.siltpoke` for the home being installed into (defect [66]).
 */
function logRootFor(home?: string): string {
  return !home ? siltpokeRoot() : siltpokeRoot({ ...process.env, HOME: home });
}

function escapeExecPath(s: string): string {
  // systemd `ExecStart` splits on space; replace with literal escaped form.
  return s.replace(/ /g, "\\x20");
}

export function renderUnit(
  { bunPath, daemonScript, daemonPath }: UnitInput,
  home?: string,
): string {
  const logRoot = logRootFor(home);
  return `[Unit]
Description=Siltpoke daemon
After=default.target

[Service]
Type=simple
ExecStart=${escapeExecPath(bunPath)} ${escapeExecPath(daemonScript)} start
Environment="PATH=${daemonPath}"
Restart=always
RestartSec=10
StandardOutput=append:${logRoot}/logs/daemon.log
StandardError=append:${logRoot}/logs/daemon.err

[Install]
WantedBy=default.target
`;
}

export async function installAutostart(
  home: string = homedir(),
  env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  // An empty home (HOME="") means unset, not "the current directory".
  home = home || homedir();
  if (process.platform !== "linux") {
    process.stderr.write(
      "installAutostart (systemd-user) requires Linux. For macOS use installer/launchd.ts.\n",
    );
    process.exit(2);
  }
  // `which bun` was wrong twice over (defect [22] family). It asks the
  // INSTALLER's shell where bun is, so launching setup by absolute path from a
  // shell with no bun on PATH threw "bun not found in PATH" while bun was
  // plainly the process running the code. And the answer it produced is only as
  // good as that shell. The code writing this unit runs under bun: the
  // interpreter it wants is the one executing it.
  const bunPath = bunForCommandString();
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
  const unit = renderUnit(
    {
      bunPath: launcher.program,
      daemonScript: launcher.script,
      daemonPath,
    },
    home,
  );

  // Under the `home` we were given, never os.homedir() (defect [66]).
  const unitPath = defaultUnitPath(home, env);
  mkdirSync(dirname(unitPath), { recursive: true });
  writeFileSync(unitPath, unit);

  mkdirSync(join(logRootFor(home), "logs"), { recursive: true });

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
  /** Home to remove from. Defaults to os.homedir(). Ignored when unitPath is set. */
  home?: string;
  /** Env for XDG_CONFIG_HOME. Defaults to process.env. Ignored when unitPath is set. */
  env?: NodeJS.ProcessEnv;
  /** Defaults to $XDG_CONFIG_HOME (or <home>/.config)/systemd/user/siltpoked.service. */
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
  const unitPath = opts.unitPath ?? defaultUnitPath(opts.home, opts.env);
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
