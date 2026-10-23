// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
// Copyright (c) 2026 Jiaqi Duan
import { copyFile, mkdir, readdir, symlink, unlink } from "node:fs/promises";
import { join } from "node:path";
import { markDone, recordBefore, recordCreatedDir } from "./receipt";
import { commandFileEntry } from "./receipt-sites";

export async function symlinkCommands(
  pluginCommandsDir: string,
  claudeCommandsDir: string,
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
): Promise<string[]> {
  // `[80]`: note which of these folders are new, before they are made.
  recordCreatedDir(claudeCommandsDir, env);
  await mkdir(claudeCommandsDir, { recursive: true });
  const entries = await readdir(pluginCommandsDir);
  const linked: string[] = [];
  for (const name of entries) {
    if (!name.endsWith(".md")) continue;
    const src = join(pluginCommandsDir, name);
    const dest = join(claudeCommandsDir, name);
    // Receipt (spec §2.1): the entry is written pending BEFORE `dest` is replaced.
    const entry = commandFileEntry(src, dest, pluginCommandsDir, platform);
    recordBefore(entry, env);
    try {
      await unlink(dest);
    } catch {
      // missing dest is fine
    }
    if (platform === "win32") {
      // Windows symlink() needs elevation → EPERM. Copy the command file instead;
      // re-run of install re-copies (idempotent), matching plugin-update semantics.
      await copyFile(src, dest);
    } else {
      await symlink(src, dest);
    }
    markDone(entry.id, env);
    linked.push(name);
  }
  return linked;
}
