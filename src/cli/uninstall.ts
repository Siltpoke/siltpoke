// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
// Copyright (c) 2026 Jiaqi Duan
import { unlink, readdir, rm } from "node:fs/promises";
import { existsSync, realpathSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  resolveClaudeHome,
  siltpokeRoot,
  settingsJsonPath,
  commandsDirPath,
} from "../installer/paths";
import {
  uninstallAutostartForPlatform,
  type AutostartUninstallResult,
} from "../installer/autostart";
import { findLatestBackup } from "../installer/backup";
import { unregisterStopHookPair } from "../installer/settings-mutator";
import { unregisterSessionStartHook } from "../installer/register-session-start";
import {
  isOurStatusLine,
  readSettingsObject,
  undoStatusLine,
  writeSettingsInPlace,
} from "../installer/statusline-restore";
import {
  askYesNo,
  realWizardIO,
  type WizardIO,
} from "../installer/wizard";

export interface UninstallOptions {
  env?: NodeJS.ProcessEnv;
  io?: WizardIO;
  repoRoot?: string;
  noninteractive?: boolean;
  purge?: boolean;
  /** Injectable autostart cleanup — tests never touch launchctl/systemctl. */
  uninstallAutostartFn?: () => Promise<AutostartUninstallResult>;
}

export interface UninstallResult {
  status:
    | "uninstalled"
    | "no_settings"
    | "internal_subprocess";
  /** What was taken out of settings.json, in order. Empty when nothing was ours or the file could not be read. */
  settings_changed: SettingsChange[];
  /** The setup-time backup, left on disk and never copied back (defect [62]). */
  backup_kept: string | null;
  symlinks_removed: number;
  autostart_removed: boolean;
  siltpoke_home_purged: boolean;
}

function detectRepoRoot(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  return resolve(here, "..", "..");
}

export type SettingsChange =
  | "statusLine restored"
  | "statusLine removed"
  | "Stop hook removed"
  | "SessionStart hook removed";

interface SourceCommands {
  wrapperCommand: string;
  hookCommand: string;
  sessionStartCommand: string;
}

/**
 * Remove exactly the three things a source install writes into settings.json —
 * the status line, the Stop hook pair, the SessionStart hook — and leave every
 * other key as it is now. A file that is not valid JSON is not touched.
 */
function undoSettingsKeys(
  settingsPath: string,
  env: NodeJS.ProcessEnv,
  io: WizardIO,
  cmds: SourceCommands,
): SettingsChange[] {
  const before = readSettingsObject(settingsPath);
  if (before === null) {
    io.write(`  ! ${settingsPath} is not valid JSON — left exactly as it was; remove siltpoke's statusLine and hooks by hand\n`);
    return [];
  }

  const changes: SettingsChange[] = [];
  const isOurs = (c: unknown) => isOurStatusLine(c) || c === cmds.wrapperCommand;
  const status = undoStatusLine(before, env, isOurs);
  if (status.outcome === "restored") changes.push("statusLine restored");
  if (status.outcome === "removed") changes.push("statusLine removed");

  // The pair matcher also takes out the curl fast-path entry and any old
  // type:"http" entry; the secret is not needed to recognise them.
  const withoutStop = unregisterStopHookPair(status.next, {
    httpUrl: "",
    command: cmds.hookCommand,
    secret: "",
  });
  if (JSON.stringify(withoutStop) !== JSON.stringify(status.next)) changes.push("Stop hook removed");

  const after = unregisterSessionStartHook(withoutStop, cmds.sessionStartCommand);
  if (JSON.stringify(after) !== JSON.stringify(withoutStop)) changes.push("SessionStart hook removed");

  if (changes.length > 0) writeSettingsInPlace(settingsPath, after);
  if (status.outcome === "not-ours") {
    io.write(`  statusLine is not siltpoke's — left as it is\n`);
  }
  for (const c of changes) io.write(`  settings.json: ${c}\n`);
  return changes;
}

function closingLine(changed: SettingsChange[]): string {
  if (changed.some((c) => c === "statusLine restored" || c === "statusLine removed")) {
    return `  done. Restart Claude Code so the status line change takes effect.\n`;
  }
  if (changed.length > 0) return `  done. Restart Claude Code so the removed hooks stop running.\n`;
  return `  done. Nothing in Claude Code needed changing, so no restart is needed.\n`;
}

export async function runUninstall(
  opts: UninstallOptions = {},
): Promise<UninstallResult> {
  const env = opts.env ?? process.env;

  if (env.SILTPOKE_INTERNAL === "1") {
    return {
      status: "internal_subprocess",
      settings_changed: [],
      backup_kept: null,
      symlinks_removed: 0,
      autostart_removed: false,
      siltpoke_home_purged: false,
    };
  }

  const repoRoot = opts.repoRoot ?? detectRepoRoot();
  // Same three commands setup writes (install.ts).
  const wrapperCommand = `bun ${join(repoRoot, "src", "face", "wrapper.ts")}`;
  const hookCommand = `bun ${join(repoRoot, "src", "hooks", "on-stop.ts")}`;
  const sessionStartCommand = `bun ${join(repoRoot, "src", "hooks", "handle-session-start.ts")}`;

  const claudeHome = resolveClaudeHome(env);
  const settingsPath = settingsJsonPath(env);
  const home = siltpokeRoot(env);
  const claudeCommandsDir = commandsDirPath(env);
  const pluginCommandsDir = join(repoRoot, ".claude-plugin", "commands");

  const noninteractive =
    opts.noninteractive ?? !(process.stdin as { isTTY?: boolean }).isTTY;
  const io = opts.io ?? realWizardIO();

  if (!existsSync(settingsPath)) {
    io.write(`! No settings.json at ${settingsPath}\n`);
    return {
      status: "no_settings",
      settings_changed: [],
      backup_kept: null,
      symlinks_removed: 0,
      autostart_removed: false,
      siltpoke_home_purged: false,
    };
  }

  io.write(`\n=== Siltpoke uninstaller ===\n`);

  // 1. Take out of settings.json only what setup put in (defect [62]). The
  //    pre-siltpoke backup is a copy of the WHOLE file from setup time, so
  //    copying it back erased every change the user made since. It is kept on
  //    disk and named, never restored.
  const settingsChanged = undoSettingsKeys(settingsPath, env, io, {
    wrapperCommand,
    hookCommand,
    sessionStartCommand,
  });
  // findLatestBackup may return the `settings.json.pre-siltpoke` pointer; name
  // the real file. A dangling pointer means there is no backup to name.
  const latest = await findLatestBackup(claudeHome);
  let backupKept: string | null = null;
  try {
    backupKept = latest ? realpathSync(latest) : null;
  } catch {
    backupKept = null;
  }
  if (backupKept) {
    io.write(`  kept your settings backup from setup time (not copied back): ${backupKept}\n`);
  }

  // 3. Remove slash command symlinks.
  let symlinksRemoved = 0;
  if (existsSync(pluginCommandsDir) && existsSync(claudeCommandsDir)) {
    try {
      const ours = await readdir(pluginCommandsDir);
      for (const name of ours) {
        if (!name.endsWith(".md")) continue;
        const target = join(claudeCommandsDir, name);
        if (existsSync(target)) {
          try {
            await unlink(target);
            symlinksRemoved += 1;
          } catch {
            // skip
          }
        }
      }
    } catch {
      // dir read failed — non-fatal
    }
  }
  io.write(`  removed ${symlinksRemoved} slash command symlinks\n`);

  // 4. Remove daemon autostart (LaunchAgent plist / systemd user unit) if
  //    present. Silent no-op when nothing installed; failures never block
  //    the rest of the uninstall (AC10).
  let autostartRemoved = false;
  const uninstallAutostart =
    opts.uninstallAutostartFn ??
    (() => uninstallAutostartForPlatform({ home: env.HOME ?? env.USERPROFILE, env }));
  try {
    const autostartResult = await uninstallAutostart();
    if (autostartResult.status === "removed") {
      autostartRemoved = true;
      io.write(`  removed daemon autostart (${autostartResult.platform})\n`);
    }
  } catch {
    // best-effort cleanup — never block uninstall
  }

  // 5. Optionally purge ~/.siltpoke/.
  let purged = false;
  if (opts.purge) {
    purged = true;
  } else if (!noninteractive) {
    purged = await askYesNo(
      io,
      "Delete ~/.siltpoke/ data too (config, memory, critiques, usage logs)?",
      { default: "no" },
    );
  }
  if (purged && existsSync(home)) {
    await rm(home, { recursive: true, force: true });
    io.write(`  purged ${home}\n`);
  } else {
    io.write(`  ~/.siltpoke/ preserved (use --purge or answer yes to delete)\n`);
  }

  // The closing line says what this run did to Claude Code. A restart is only
  // worth asking for when settings.json changed; Claude Code reads the status
  // line and hooks at start-up.
  io.write(closingLine(settingsChanged));

  return {
    status: "uninstalled",
    settings_changed: settingsChanged,
    backup_kept: backupKept,
    symlinks_removed: symlinksRemoved,
    autostart_removed: autostartRemoved,
    siltpoke_home_purged: purged,
  };
}

if (import.meta.main) {
  const noninteractive = process.argv.includes("--noninteractive");
  const purge = process.argv.includes("--purge");
  const result = await runUninstall({ noninteractive, purge });
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  process.exit(0);
}
