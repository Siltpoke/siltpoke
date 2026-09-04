// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
// Copyright (c) 2026 Jiaqi Duan
import {
  unlink,
  readdir,
  readFile,
  rm,
  writeFile,
  rename,
  mkdir,
} from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { randomBytes } from "node:crypto";
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
import { findLatestBackup, restoreFromBackup } from "../installer/backup";
import {
  restoreStatusLine,
  unregisterStopHook,
} from "../installer/settings-mutator";
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
  backup_restored: string | null;
  inner_fallback_used: boolean;
  symlinks_removed: number;
  autostart_removed: boolean;
  siltpoke_home_purged: boolean;
}

function detectRepoRoot(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  return resolve(here, "..", "..");
}

async function atomicWriteJson(path: string, data: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.tmp.${process.pid}.${Date.now()}.${randomBytes(4).toString("hex")}`;
  await writeFile(tmp, JSON.stringify(data, null, 2), "utf8");
  await rename(tmp, path);
}

async function readJsonOrEmpty(path: string): Promise<Record<string, unknown>> {
  if (!existsSync(path)) return {};
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch {
    return {};
  }
}

export async function runUninstall(
  opts: UninstallOptions = {},
): Promise<UninstallResult> {
  const env = opts.env ?? process.env;

  if (env.SILTPOKE_INTERNAL === "1") {
    return {
      status: "internal_subprocess",
      backup_restored: null,
      inner_fallback_used: false,
      symlinks_removed: 0,
      autostart_removed: false,
      siltpoke_home_purged: false,
    };
  }

  const repoRoot = opts.repoRoot ?? detectRepoRoot();
  const wrapperCommand = `bun ${join(repoRoot, "src", "face", "wrapper.ts")}`;
  const hookCommand = `bun ${join(repoRoot, "src", "hooks", "on-stop.ts")}`;

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
      backup_restored: null,
      inner_fallback_used: false,
      symlinks_removed: 0,
      autostart_removed: false,
      siltpoke_home_purged: false,
    };
  }

  io.write(`\n=== Siltpoke uninstaller ===\n`);

  // 1. Try to restore settings.json from backup.
  let backupRestored: string | null = null;
  let innerFallbackUsed = false;
  const backupPath = await findLatestBackup(claudeHome);
  let backupFailed = false;
  if (backupPath) {
    try {
      await restoreFromBackup(claudeHome, backupPath);
      backupRestored = backupPath;
      io.write(`  restored settings.json from ${backupPath}\n`);
    } catch (err) {
      backupFailed = true;
      io.write(
        `  ! backup at ${backupPath} unreadable (${err instanceof Error ? err.message : String(err)}); falling through to inner.txt\n`,
      );
    }
  }
  if (!backupPath || backupFailed) {
    // Fall back: use inner.txt as the prior statusline command, manually
    // unregister hook, drop wrapper.
    io.write(`  no backup found — best-effort restore via inner.txt\n`);
    innerFallbackUsed = true;
    const innerPath = join(home, "inner.txt");
    let innerCommand: string | null = null;
    if (existsSync(innerPath)) {
      try {
        innerCommand = (await readFile(innerPath, "utf8")).trim();
      } catch {
        // ignore
      }
    }
    const current = await readJsonOrEmpty(settingsPath);
    const withRestoredStatus = restoreStatusLine(current, innerCommand);
    const next = unregisterStopHook(withRestoredStatus, hookCommand);
    await atomicWriteJson(settingsPath, next);
  }

  // 2. Idempotent hook unregister even if backup didn't include it.
  const afterBackup = await readJsonOrEmpty(settingsPath);
  const cleaned = unregisterStopHook(afterBackup, hookCommand);
  if (JSON.stringify(cleaned) !== JSON.stringify(afterBackup)) {
    await atomicWriteJson(settingsPath, cleaned);
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
    opts.uninstallAutostartFn ?? (() => uninstallAutostartForPlatform());
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

  // Wrapper unwrapper output — wrapper command not used here, but logged so the
  // user knows what command stopped firing.
  io.write(`  done. Restart Claude Code for ${wrapperCommand.split(" ")[0]} to stop wrapping the statusline.\n`);

  return {
    status: "uninstalled",
    backup_restored: backupRestored,
    inner_fallback_used: innerFallbackUsed,
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
