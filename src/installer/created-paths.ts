// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
// Copyright (c) 2026 Jiaqi Duan
import { lstatSync } from "node:fs";
import { dirname, resolve, sep } from "node:path";

/**
 * `[80]` — which files and folders an install is ABOUT to create.
 *
 * Called by `recordBefore` while the receipt entry is written, before the
 * install acts, so "not there yet" is observed, never guessed afterwards.
 * Uninstall later deletes a recorded path only while it is still empty
 * (`created-sweep.ts`).
 *
 * Only paths strictly inside the home folder are ever listed: never the home
 * itself, never anything above or outside it.
 */

/** Kinds whose `target` is a host file Siltpoke may create and then only empty out (not delete). */
const FILE_KINDS: ReadonlySet<string> = new Set(["host-hook", "statusline"]);

/** Kinds whose `target` is a path at all (a pref domain or a tool name is not). */
const PATH_KINDS: ReadonlySet<string> = new Set(["host-hook", "statusline", "file", "launch-agent"]);

function missing(path: string): boolean {
  try {
    lstatSync(path);
    return false;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "ENOENT";
  }
}

/**
 * The folders above `target` that do not exist yet (deepest first), then the
 * target itself when it is a host file that does not exist. Command links,
 * shims and login-item files are not listed themselves: their own receipt
 * entries undo them. Empty when `target` is not a path inside `home`.
 */
export function newlyCreated(target: string, kind: string, home: string): string[] {
  if (!PATH_KINDS.has(kind)) return [];
  const root = resolve(home);
  const file = resolve(target);
  if (!file.startsWith(root + sep)) return [];
  const out: string[] = [];
  for (let dir = dirname(file); dir.startsWith(root + sep) && missing(dir); dir = dirname(dir)) out.push(dir);
  if (FILE_KINDS.has(kind) && missing(file)) out.push(file);
  return out;
}
