// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
// Copyright (c) 2026 Jiaqi Duan
import { createHash } from "node:crypto";
import { lstatSync, readFileSync, readlinkSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { homeDir } from "./paths";
import type { AutostartDispatchResult } from "./autostart";
import { defaultPlistPath } from "./launchd";
import { defaultUnitPath } from "./systemd";
import { markDone, type NewReceiptEntry, recordBefore } from "./receipt";

/**
 * Receipt entry builders shared by the install paths — `[61]` PR 2, plan P1.3
 * (spec an internal design note §2.2–§2.3).
 *
 * Why a module of its own: the same thing is written by more than one path
 * (the plugin's `configure` and the source `install` both swap Claude Code's
 * status line; both agy paths write agy's) and both must leave the SAME entry
 * id, or a machine that ran both would show two records of one fact. The
 * `undo` objects are the contract with the planner (plan P2.1): they say how
 * to take the thing back; the planner reads `kind` + `undo`, never the prose.
 */

/** Claude Code's status line points at siltpoke's wrapper; the old one lives in `inner.txt`. */
export function claudeStatuslineEntry(settingsPath: string, innerTxtPath: string): NewReceiptEntry {
  return {
    id: "statusline:claude-code",
    kind: "statusline",
    target: settingsPath,
    // The wrapper is siltpoke's own. What was there before is kept in inner.txt
    // and put back on undo, so there is nothing "of the user's" to mark here.
    byUs: true,
    level: "uninstall",
    undo: { type: "restore-statusline", inner: innerTxtPath },
  };
}

/** agy's status line (plugin path and source path write the same slot). */
export function agyStatuslineEntry(settingsPath: string): NewReceiptEntry {
  return {
    id: "statusline:antigravity",
    kind: "statusline",
    target: settingsPath,
    byUs: true,
    level: "uninstall",
    undo: { type: "unwire-agy-statusline" },
  };
}

/**
 * Stop + SessionStart hook entries in a settings.json-shaped host file
 * (Claude Code on the source path; codebuddy / qoder). `match` is the repo
 * root: every command siltpoke registers contains `<repo>/src/hooks/`.
 */
export function settingsHooksEntry(hostId: string, settingsPath: string, repoRoot: string): NewReceiptEntry {
  return {
    id: `hook:${hostId}`,
    kind: "host-hook",
    target: settingsPath,
    byUs: true,
    level: "uninstall",
    undo: { type: "remove-hook-entries", events: ["Stop", "SessionStart"], match: repoRoot },
  };
}

/** codex's own hooks.json (different schema; same removal rule). */
export function codexHooksEntry(hooksPath: string, repoRoot: string): NewReceiptEntry {
  return {
    id: "hook:codex",
    kind: "host-hook",
    target: hooksPath,
    byUs: true,
    level: "uninstall",
    undo: { type: "remove-hook-entries", events: ["Stop", "SessionStart"], match: repoRoot },
  };
}

/** agy's name-keyed hooks.json: one top-level key is ours. */
export function agyHooksEntry(hooksPath: string, key: string): NewReceiptEntry {
  return {
    id: "hook:antigravity",
    kind: "host-hook",
    target: hooksPath,
    byUs: true,
    level: "uninstall",
    undo: { type: "remove-json-key", key },
  };
}

/**
 * A tool siltpoke installed (or found) in the user's machine, outside its own
 * folders. `purge` level, and the planner offers removal only for the
 * siltpoke-specific ones (spec §5: Ollama model, PLC, SwiftBar app).
 */
export function outsideToolEntry(
  id: string,
  target: string,
  byUs: boolean,
  undo: Record<string, unknown>,
): NewReceiptEntry {
  return { id, kind: "outside-tool", target, byUs, level: "purge", undo };
}

/** Daemon autostart: a launchd plist (macOS) or a systemd user unit (Linux). */
function launchAgentEntry(unitPath: string): NewReceiptEntry {
  return {
    id: "launch-agent:daemon",
    kind: "launch-agent",
    target: unitPath,
    // The file name is siltpoke's (`io.siltpoke.daemon` / `siltpoked`): content
    // names siltpoke, so it is ours even when no receipt saw it written (D-A).
    byUs: true,
    level: "uninstall",
    undo: { type: "unload-and-delete" },
  };
}

/**
 * Run `act` between `recordBefore` and `markDone` (spec §2.1). An action that
 * throws, or that `isDone` rejects, leaves the entry `pending` — the planner
 * checks the disk for those. Returns whatever `act` returns.
 */
export async function recorded<T>(
  env: NodeJS.ProcessEnv,
  entry: NewReceiptEntry,
  act: () => T | Promise<T>,
  isDone: (result: T) => boolean = () => true,
): Promise<T> {
  recordBefore(entry, env);
  const result = await act();
  if (isDone(result)) markDone(entry.id, env);
  return result;
}

/**
 * Where the daemon unit lives for this platform under the install's home; null
 * where autostart is not supported. The same functions launchd.ts / systemd.ts
 * write with, so the recorded path and the written path cannot drift.
 */
export function autostartUnitPath(platform: string, env: NodeJS.ProcessEnv): string | null {
  const home = homeDir(env);
  if (platform === "darwin") return defaultPlistPath(home);
  if (platform === "linux") return defaultUnitPath(home, env);
  return null;
}

/** The SwiftBar app, when the menu-bar setup brews it (or finds it). Offered at purge only if ours. */
export function swiftbarAppEntry(appPath: string, byUs: boolean): NewReceiptEntry {
  return outsideToolEntry("tool:swiftbar", appPath, byUs, { type: "brew-uninstall-cask", cask: "swiftbar" });
}

/** SwiftBar's `PluginDirectory` pref: ours only when it was unset and the setup wrote it. */
export function swiftbarPrefEntry(domain: string, key: string, byUs: boolean): NewReceiptEntry {
  return {
    id: `pref:${domain}.${key}`,
    kind: "macos-pref",
    target: domain,
    byUs,
    level: "uninstall",
    undo: { type: "defaults-delete", domain, key },
  };
}

/** What every siltpoke menu-bar shim has looked like: `exec "<bun>" "<renderer>" --menubar`. */
const SILTPOKE_SHIM = /^#!\/bin\/bash\nexec "[^"\n]*" "[^"\n]*(?:wrapper\.ts|siltpoke-card\.js)" --menubar\n?$/;

/** True for a file siltpoke's menu-bar setup wrote, whichever install wrote it. */
export function isSiltpokeShim(content: string): boolean {
  return SILTPOKE_SHIM.test(content);
}

/**
 * The menu-bar shim, built BEFORE the file is written (spec §2.1). Ours =
 * nothing there, or a siltpoke shim from an earlier install — the bun path and
 * the renderer path differ between installs, so an exact-bytes match would
 * call our own stale shim the user's. Anything else at that name is the
 * user's — including something there that cannot be read (no permission, a
 * directory): unknown is not ours. Undo deletes only while the bytes are
 * still the ones written now.
 */
export function menubarShimEntry(
  shimPath: string,
  prior: { content: string } | "absent" | "unreadable",
  written: string,
): NewReceiptEntry {
  return {
    id: `file:${shimPath}`,
    kind: "file",
    target: shimPath,
    byUs: prior === "absent" || (prior !== "unreadable" && isSiltpokeShim(prior.content)),
    level: "uninstall",
    undo: { type: "remove-if-hash", sha256: sha256(Buffer.from(written)) },
  };
}

/** The SwiftBar login item (`io.siltpoke.swiftbar`): the name is siltpoke's, so it is ours. */
export function swiftbarLoginItemEntry(plistPath: string): NewReceiptEntry {
  return {
    id: "launch-agent:swiftbar",
    kind: "launch-agent",
    target: plistPath,
    byUs: true,
    level: "uninstall",
    undo: { type: "unload-and-delete" },
  };
}

/**
 * Wrap an autostart install: record the unit before it is written, done only
 * when the dispatcher says `installed`. Unsupported platforms record nothing —
 * there is nothing on disk to take back.
 */
export async function recordedAutostart(
  env: NodeJS.ProcessEnv,
  run: () => Promise<AutostartDispatchResult>,
  platform: string = process.platform,
): Promise<AutostartDispatchResult> {
  const unitPath = autostartUnitPath(platform, env);
  if (unitPath === null) return run();
  return recorded(env, launchAgentEntry(unitPath), run, (r) => r.status === "installed");
}

function sha256(text: Buffer): string {
  return createHash("sha256").update(text).digest("hex");
}

/**
 * Entry for one slash-command file, built BEFORE the destination is replaced
 * so `byUs` reflects what was there (spec §2.1). Ours = nothing there, or a
 * link from an earlier install that points into `pluginCommandsDir`; on win32
 * (files are copies, spec §2.2) = nothing there, or the same bytes. Anything
 * else is the user's own file that the install is about to overwrite — kept
 * as `byUs: false` so uninstall never deletes it. An older siltpoke copy that
 * differs byte-for-byte also lands here: conservative on purpose.
 */
export function commandFileEntry(
  src: string,
  dest: string,
  pluginCommandsDir: string,
  platform: NodeJS.Platform,
): NewReceiptEntry {
  const base = { id: `file:${dest}`, kind: "file" as const, target: dest, level: "uninstall" as const };
  if (platform === "win32") {
    const mine = sha256(readFileSync(src));
    let byUs = true;
    try {
      byUs = sha256(readFileSync(dest)) === mine;
    } catch {
      // nothing there yet
    }
    return { ...base, byUs, undo: { type: "remove-if-hash", sha256: mine } };
  }
  let byUs = true;
  try {
    const prior = lstatSync(dest);
    byUs =
      prior.isSymbolicLink() &&
      dirname(resolve(dirname(dest), readlinkSync(dest))) === resolve(pluginCommandsDir);
  } catch {
    // nothing there yet
  }
  return { ...base, byUs, undo: { type: "remove-link", under: pluginCommandsDir } };
}
