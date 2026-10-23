// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
// Copyright (c) 2026 Jiaqi Duan
import { createHash } from "node:crypto";
import { lstatSync, readFileSync, readlinkSync, realpathSync, statSync, unlinkSync } from "node:fs";
import { basename, dirname, resolve, sep } from "node:path";
import type { ProbeExec } from "../installer/menubar-setup";
import { atomicWrite } from "../utils/atomic-write";
import { stripSiltpokeHooks } from "./uninstall-hooks";
import type { PlanItem } from "./uninstall-plan";

/**
 * The default level's executors — `[61]` PR 2, plan P3 (spec
 * an internal design note §2.2, §4).
 *
 * One plan item in, one outcome out. Every path comes from the plan item, so
 * an executor can touch nothing the plan did not show. Each one checks again,
 * at the moment of removal, that the thing is still siltpoke's: the plan may
 * be seconds old, and "it exists" is all the plan checked for a file.
 */

export interface UndoEffects {
  /**
   * Account-level commands (`defaults delete`). Injected because the real one
   * changes the real account whatever `HOME` says — the CLI entry passes one
   * that refuses under any other home (`homeScopedExec`).
   */
  exec: ProbeExec;
  platform: NodeJS.Platform;
}

export type UndoResult =
  | { outcome: "done"; line: string }
  /** Nothing of siltpoke's was there any more. */
  | { outcome: "nothing" }
  /** Not removed — changed since siltpoke wrote it, or the step failed. Exit code 1. */
  | { outcome: "not-done"; line: string };

const done = (line: string): UndoResult => ({ outcome: "done", line });
const notDone = (line: string): UndoResult => ({ outcome: "not-done", line });

function readText(path: string): string | null {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
}

function sha256Of(path: string): string | null {
  try {
    return createHash("sha256").update(readFileSync(path)).digest("hex");
  } catch {
    return null;
  }
}

/** Where a link points, as an absolute path; null when `path` is not a link. */
export function linkTarget(path: string): string | null {
  try {
    return lstatSync(path).isSymbolicLink() ? resolve(dirname(path), readlinkSync(path)) : null;
  } catch {
    return null;
  }
}

/**
 * A link with a siltpoke command's name that points at the same name in some
 * `.claude-plugin/commands` folder: the link itself says whose it is, so it
 * needs no receipt (spec §8 D-A).
 */
export function isSiltpokeCommandLink(path: string, target: string | null): boolean {
  const name = basename(path);
  return target !== null && /^siltpoke-.+\.md$/.test(name) && target.endsWith(`${sep}.claude-plugin${sep}commands${sep}${name}`);
}

function undoHooks(item: PlanItem): UndoResult | null {
  const text = readText(item.target);
  if (text === null) return { outcome: "nothing" };
  const stripped = stripSiltpokeHooks(text, item.undo, item.id);
  if (stripped.outcome === "unknown-undo") return null;
  if (stripped.outcome === "nothing") return { outcome: "nothing" };
  if (stripped.outcome === "unreadable") {
    return notDone(`${item.target} is not valid JSON — left untouched. Fix the file and run this again.`);
  }
  // Through a link (a dotfile manager's), keeping the file's own mode.
  const real = realpathSync(item.target);
  atomicWrite(real, stripped.next, { mode: statSync(real).mode & 0o777 });
  return done(`Siltpoke's hooks: removed from ${item.target}`);
}

function undoPref(item: PlanItem, effects: UndoEffects): UndoResult | null {
  const { type, domain, key } = item.undo ?? {};
  if (type !== "defaults-delete" || typeof domain !== "string" || typeof key !== "string") return null;
  // Deleted only on the receipt's word that siltpoke set it (AC11).
  if (item.byUs !== true || effects.platform !== "darwin") return { outcome: "nothing" };
  const r = effects.exec("defaults", ["delete", domain, key]);
  return r.status === 0
    ? done(`the macOS setting ${domain} ${key}: deleted`)
    : notDone(`the macOS setting ${domain} ${key} could not be deleted (\`defaults delete\` failed).`);
}

/** Is the file at `item.target` still the one siltpoke put there? null = no rule for this item. */
function fileStillOurs(item: PlanItem): boolean | null {
  const undo = item.undo;
  if (undo === null) return isSiltpokeCommandLink(item.target, linkTarget(item.target));
  if (undo.type === "remove-link") {
    const target = linkTarget(item.target);
    return target !== null && typeof undo.under === "string" && dirname(target) === resolve(undo.under);
  }
  if (undo.type === "remove-if-hash") return typeof undo.sha256 === "string" && sha256Of(item.target) === undo.sha256;
  return null;
}

function undoFile(item: PlanItem): UndoResult | null {
  if (lstatSync(item.target, { throwIfNoEntry: false }) === undefined) return { outcome: "nothing" };
  const ours = fileStillOurs(item);
  if (ours === null) return null;
  if (!ours) return notDone(`${item.target} is no longer the file Siltpoke wrote — left as it is.`);
  unlinkSync(item.target);
  return done(`${item.target}: deleted`);
}

/**
 * For a menu-bar shim the receipt recorded: are the bytes still the ones
 * written then? True when there is no recorded hash to compare (a shim found
 * on disk — the menu-bar step's own shape check is all there is for those).
 */
export function shimMatchesReceipt(item: PlanItem): boolean {
  const hash = item.undo?.type === "remove-if-hash" ? item.undo.sha256 : undefined;
  return typeof hash !== "string" || sha256Of(item.target) === hash;
}

/** Take one plan item back. null = this version has no executor for it. */
export function undoItem(item: PlanItem, effects: UndoEffects): UndoResult | null {
  try {
    if (item.kind === "host-hook") return undoHooks(item);
    if (item.kind === "macos-pref") return undoPref(item, effects);
    if (item.kind === "file") return undoFile(item);
    return null;
  } catch (err) {
    return notDone(`${item.target}: ${err instanceof Error ? err.message : String(err)}`);
  }
}
