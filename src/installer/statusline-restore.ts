// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
// Copyright (c) 2026 Jiaqi Duan
import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { join } from "node:path";
import { atomicWrite } from "../utils/atomic-write";
import { settingsJsonPath, siltpokeRoot } from "./paths";

/**
 * Giving the user's status line back (defect [61]).
 *
 * Setup points `statusLine.command` at `~/.siltpoke/bin/statusline.sh` and saves
 * what was there before in `~/.siltpoke/inner.txt`. Nothing undid that for a
 * plugin install: Claude Code has no uninstall hook, and a plugin cannot own
 * the main `statusLine`, so `claude plugin uninstall` leaves the line pointing
 * at us for good.
 *
 * This is deliberately NOT `restoreFromBackup`. A `settings.json.pre-siltpoke-*`
 * backup is a copy of the WHOLE file from the moment setup ran: copying it back
 * reverts every setting the user has changed since, and a backup taken on a
 * second setup run already holds our shim, so it would restore nothing. Only
 * the one key we changed is put back.
 */

/** The part of the command that is ours on every platform, slashes normalised. */
const SHIM_SUFFIX = ".siltpoke/bin/statusline.sh";

/**
 * True when a `statusLine.command` is the one setup wrote. Matched on the shim's
 * own path rather than on the word "siltpoke": a user's command may mention
 * siltpoke without being ours, and replacing it would destroy their line.
 */
export function isOurStatusLine(command: unknown): boolean {
  if (typeof command !== "string") return false;
  return command.replace(/\\/g, "/").includes(SHIM_SUFFIX);
}

/** The command setup saved, or null when there is none worth putting back. */
function savedOriginal(
  env: NodeJS.ProcessEnv,
  isOurs: (command: unknown) => boolean,
): string | null {
  let raw: string;
  try {
    raw = readFileSync(join(siltpokeRoot(env), "inner.txt"), "utf8");
  } catch {
    return null;
  }
  const command = raw.trim();
  if (command.length === 0) return null;
  // Writing our own command back would "restore" the very thing being removed.
  return isOurs(command) ? null : command;
}

export type StatusLineRestore =
  | "restored" // the user's own command is back
  | "removed" // there was no earlier command — the key is gone
  | "not-ours" // the status line is not siltpoke's; nothing was written
  | "no-settings" // no settings.json
  | "unreadable"; // settings.json is not valid JSON; left exactly as it was

/**
 * settings.json as an object, or null when it is not one. Same rule as setup
 * (configure.ts): a file we cannot parse is a file we cannot rewrite without
 * dropping every key in it.
 */
export function readSettingsObject(settingsPath: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(readFileSync(settingsPath, "utf8"));
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
    return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
}

/**
 * Write settings.json THROUGH a symlink (dotfile managers link it): a rename
 * onto the link itself would replace the link with a plain file.
 */
export function writeSettingsInPlace(settingsPath: string, settings: Record<string, unknown>): void {
  const target = realpathSync(settingsPath);
  atomicWrite(target, `${JSON.stringify(settings, null, 2)}\n`, { mode: statSync(target).mode & 0o777 });
}

/**
 * The status-line half of the undo, without touching disk. `isOurs` decides
 * which commands are siltpoke's: the plugin's shim always; a source install
 * adds its own `bun <repo>/src/face/wrapper.ts` command.
 */
export function undoStatusLine(
  settings: Record<string, unknown>,
  env: NodeJS.ProcessEnv,
  isOurs: (command: unknown) => boolean = isOurStatusLine,
): { next: Record<string, unknown>; outcome: "restored" | "removed" | "not-ours" } {
  const current = settings.statusLine as { command?: unknown } | undefined;
  if (!isOurs(current?.command)) return { next: settings, outcome: "not-ours" };

  const original = savedOriginal(env, isOurs);
  // Only `command` was ever ours. Setup replaced the whole object, so any other
  // sub-key in it now (`padding`, …) is one the user set since — keep it.
  if (original === null) {
    const { statusLine: _ours, ...rest } = settings;
    return { next: rest, outcome: "removed" };
  }
  return {
    next: { ...settings, statusLine: { ...current, type: "command", command: original } },
    outcome: "restored",
  };
}

export function restoreUserStatusLine(
  env: NodeJS.ProcessEnv = process.env,
  isOurs: (command: unknown) => boolean = isOurStatusLine,
): StatusLineRestore {
  const settingsPath = settingsJsonPath(env);
  if (!existsSync(settingsPath)) return "no-settings";

  const settings = readSettingsObject(settingsPath);
  if (settings === null) return "unreadable";

  const { next, outcome } = undoStatusLine(settings, env, isOurs);
  if (outcome === "not-ours") return outcome;
  writeSettingsInPlace(settingsPath, next);
  return outcome;
}
