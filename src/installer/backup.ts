// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Copyright (c) 2026 Jiaqi Duan
import {
  copyFile,
  mkdir,
  readdir,
  symlink,
  unlink,
} from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";

export interface BackupResult {
  path: string;
  symlink: string;
}

const SYMLINK_NAME = "settings.json.pre-siltpoke";

function backupFilename(now: Date): string {
  const iso = now.toISOString().replace(/[:.]/g, "-");
  return `settings.json.pre-siltpoke-${iso}.json`;
}

export async function backupSettings(
  claudeHome: string,
  now: Date = new Date(),
): Promise<BackupResult> {
  const src = join(claudeHome, "settings.json");
  if (!existsSync(src)) {
    throw new Error(`No settings.json at ${src} — refusing to back up nothing`);
  }
  await mkdir(claudeHome, { recursive: true });
  const filename = backupFilename(now);
  const destPath = join(claudeHome, filename);
  await copyFile(src, destPath);

  const symlinkPath = join(claudeHome, SYMLINK_NAME);
  try {
    await unlink(symlinkPath);
  } catch {
    // missing symlink is fine
  }
  await symlink(filename, symlinkPath);

  return { path: destPath, symlink: symlinkPath };
}

export async function restoreFromBackup(
  claudeHome: string,
  backupPath: string,
): Promise<void> {
  if (!existsSync(backupPath)) {
    throw new Error(`Backup not found: ${backupPath}`);
  }
  const dest = join(claudeHome, "settings.json");
  await copyFile(backupPath, dest);
}

export async function findLatestBackup(
  claudeHome: string,
): Promise<string | null> {
  const symlinkPath = join(claudeHome, SYMLINK_NAME);
  if (existsSync(symlinkPath)) return symlinkPath;
  // fall back to scanning
  try {
    const entries = await readdir(claudeHome);
    const matches = entries
      .filter((e) => e.startsWith("settings.json.pre-siltpoke-"))
      .sort();
    if (matches.length === 0) return null;
    return join(claudeHome, matches[matches.length - 1]!);
  } catch {
    return null;
  }
}
