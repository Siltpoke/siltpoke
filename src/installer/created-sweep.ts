// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
// Copyright (c) 2026 Jiaqi Duan
import { lstatSync, readdirSync, readFileSync, realpathSync, rmdirSync, rmSync } from "node:fs";
import { resolve, sep } from "node:path";
import { homeDir } from "./paths";
import { readReceipt, replaceCreated } from "./receipt";

/**
 * `[80]` — take back the empty files and folders the install created.
 *
 * Deletes a path only when ALL of these hold: the receipt recorded it as
 * created by an install (`receipt.created`); it is strictly inside the home
 * folder with no link anywhere on the way out of it; it is itself not a link;
 * and it is empty right now (a folder with nothing in it, or a file holding
 * only an empty JSON object or nothing). Anything the user has put in since
 * keeps it. Files go first, then folders deepest-first, so a chain created
 * together goes together.
 *
 * A receipt from before this existed has no list, so nothing is deleted:
 * those machines keep today's behaviour.
 */

/** Longer than any hand-written "empty" host file; keeps the read tiny and the rule conservative. */
const MAX_SHELL_BYTES = 64;

/** True for text that says nothing: whitespace only, or exactly one empty JSON object. */
export function isEmptyShellFile(text: string): boolean {
  if (text.length > MAX_SHELL_BYTES) return false;
  const body = text.replace(/^﻿/, "").trim();
  if (body === "") return true;
  try {
    const parsed: unknown = JSON.parse(body);
    return !!parsed && typeof parsed === "object" && !Array.isArray(parsed) && Object.keys(parsed).length === 0;
  } catch {
    return false;
  }
}

function insideHome(path: string, home: string): boolean {
  return path.startsWith(home + sep);
}

/**
 * Whether `path` reaches the disk through no link: its real location is exactly
 * where its name says (home's own real location plus the rest of the name).
 */
function viaNoLink(path: string, home: string, realHome: string): boolean {
  try {
    return realpathSync(path) === realHome + path.slice(home.length);
  } catch {
    return false;
  }
}

function tryRemove(path: string, home: string, realHome: string): boolean {
  try {
    const stat = lstatSync(path);
    if (stat.isSymbolicLink() || !viaNoLink(path, home, realHome)) return false;
    if (stat.isDirectory()) {
      if (readdirSync(path).length > 0) return false;
      rmdirSync(path);
      return true;
    }
    if (!stat.isFile() || stat.size > MAX_SHELL_BYTES || !isEmptyShellFile(readFileSync(path, "utf8"))) return false;
    rmSync(path);
    return true;
  } catch {
    return false;
  }
}

/** Paths removed this call. Never throws; the receipt's list keeps only what is still on the disk. */
export function sweepCreated(env: NodeJS.ProcessEnv): string[] {
  const listed = readReceipt(env)?.created;
  if (!listed || listed.length === 0) return [];
  let home: string;
  let realHome: string;
  try {
    home = resolve(homeDir(env));
    realHome = realpathSync(home);
  } catch {
    return [];
  }
  const candidates = [...new Set(listed.map((p) => resolve(p)))].filter((p) => insideHome(p, home));
  const depth = (p: string) => p.split(sep).length;
  const ordered = [
    ...candidates.filter((p) => !isDir(p)),
    ...candidates.filter(isDir).sort((a, b) => depth(b) - depth(a)),
  ];
  const removed = ordered.filter((p) => tryRemove(p, home, realHome));
  const stillThere = candidates.filter((p) => exists(p));
  try {
    replaceCreated(stillThere, env);
  } catch {
    // The receipt could not be rewritten: the list stays longer than it needs to, which only costs a re-check.
  }
  return removed;
}

function exists(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch {
    return false;
  }
}

function isDir(path: string): boolean {
  try {
    return lstatSync(path).isDirectory();
  } catch {
    return false;
  }
}
