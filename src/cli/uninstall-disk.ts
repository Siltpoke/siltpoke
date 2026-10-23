// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
// Copyright (c) 2026 Jiaqi Duan
import { lstatSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { accountHome as macAccountHome } from "../installer/account-home";
import { isOurAgyStatusLine } from "../installer/agy-statusline";
import { codebuddyAdapter, qoderAdapter } from "../installer/host-adapter";
import {
  type ProbeExec,
  resolveObeyedShimPath,
  SWIFTBAR_DEFAULTS_DOMAIN,
  SWIFTBAR_PLUGIN_DIR_KEY,
  strandedShimPath,
} from "../installer/menubar-setup";
import {
  codexHooksJsonPath,
  commandsDirPath,
  homeDir,
  resolveAgyHooksJsonPath,
  resolveAntigravityHome,
  settingsJsonPath,
  siltpokeRoot,
} from "../installer/paths";
import type { Receipt, ReceiptEntry } from "../installer/receipt";
import { autostartUnitPath, isSiltpokeShim } from "../installer/receipt-sites";
import { isOurStatusLine } from "../installer/statusline-restore";
import { swiftbarPlistPath } from "../installer/swiftbar-autostart";
import { holdsSiltpokeHooks, textNamesSiltpoke } from "./uninstall-hooks";
import type { DiskView, FoundOnDisk } from "./uninstall-plan";
import { findPurgeItems } from "./uninstall-purge";
import { isSiltpokeCommandLink, linkTarget } from "./uninstall-undo";

/**
 * What the removal plan is told about the disk — `[61]` PR 2, plan P2.1 (spec
 * §2.1, §8 D-A). Read-only: every probe asks a question and changes nothing.
 *
 * Two answers:
 *  - `present`: for each receipt entry, is the thing still there AND still
 *    siltpoke's? A status line the user has since replaced is not present.
 *  - `found`: what is on disk whose own content or name says siltpoke, receipt
 *    or no receipt. This is how a user who installed before receipts existed
 *    still gets the removals PR 1 already did.
 */

/** Every read goes through here, so a test can answer from a map. */
export interface DiskProbes {
  platform: NodeJS.Platform;
  /** True for anything at the path, a dangling link included. */
  exists: (path: string) => boolean;
  /** null when the file is missing or cannot be read. */
  readText: (path: string) => string | null;
  /** The symbolic links directly inside `dir`, each with where it points (absolute). Empty when `dir` is not there. */
  linksIn: (dir: string) => { path: string; target: string }[];
  /** The names directly inside `dir`. Empty when `dir` is not there. */
  namesIn: (dir: string) => string[];
  /** Read-only commands (`defaults read`, `git ls-files`). */
  exec: ProbeExec;
  /** Is this outside tool on the machine? null = the question could not be asked. */
  toolPresent: (tool: { id: string; target: string }) => boolean | null;
}

/** The source install's Claude command (`src/cli/install.ts`): `bun <repo>/src/face/wrapper.ts`. */
const SOURCE_WRAPPER = /^.+ .+[/\\]src[/\\]face[/\\]wrapper\.ts$/;

/** Ours only on a receipt's word: nothing in this command names siltpoke. */
export function isSourceWrapper(command: unknown): boolean {
  return typeof command === "string" && SOURCE_WRAPPER.test(command);
}

function readObject(probes: DiskProbes, path: string): Record<string, unknown> | null {
  const text = probes.readText(path);
  if (text === null) return null;
  try {
    const parsed: unknown = JSON.parse(text);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function statusLineCommand(probes: DiskProbes, settingsPath: string): unknown {
  return (readObject(probes, settingsPath)?.statusLine as { command?: unknown } | undefined)?.command;
}

function prefIsSet(probes: DiskProbes, domain: unknown, key: unknown): boolean {
  if (probes.platform !== "darwin" || typeof domain !== "string" || typeof key !== "string") return false;
  const read = probes.exec("defaults", ["read", domain, key]);
  return read.status === 0 && read.stdout.trim().length > 0;
}

/**
 * Does the host's file still hold a hook of siltpoke's? Judged inside the hook
 * events only: a source install's status line sits in the same file under the
 * same install root and is not a hook. A file that cannot be parsed falls back
 * to a search of its text for what the receipt recorded — "present" there is
 * what lets the removal say "could not finish" instead of "already gone".
 */
function hooksPresent(e: ReceiptEntry, probes: DiskProbes): boolean {
  const text = probes.readText(e.target);
  if (text === null) return false;
  const parsed = holdsSiltpokeHooks(text, e.undo, e.id);
  if (parsed !== null) return parsed;
  const recorded = e.undo.type === "remove-json-key" ? e.undo.key : e.undo.match;
  // Inside the file the value is a JSON string (a Windows backslash is doubled).
  return typeof recorded === "string" && recorded.length > 0 && text.includes(JSON.stringify(recorded).slice(1, -1));
}

/** Host files siltpoke's source install writes hooks into, by the id the receipt would use. */
function hookFiles(env: NodeJS.ProcessEnv): [id: string, path: string][] {
  return [
    ["hook:claude-code", settingsJsonPath(env)],
    ["hook:codex", codexHooksJsonPath(env)],
    [`hook:${codebuddyAdapter.id}`, codebuddyAdapter.settingsPath(env)],
    [`hook:${qoderAdapter.id}`, qoderAdapter.settingsPath(env)],
    ["hook:antigravity", resolveAgyHooksJsonPath(env)],
  ];
}

/** Still there, and still ours — per the entry's own undo type. */
function isPresent(e: ReceiptEntry, probes: DiskProbes): boolean {
  // Could not ask ⇒ present: a listed thing that is in fact gone costs one failed
  // command, while "already gone" for a 4.7 GB model that is still there hides it.
  if (e.kind === "outside-tool") return probes.toolPresent(e) !== false;
  switch (e.undo.type) {
    case "restore-statusline": {
      const command = statusLineCommand(probes, e.target);
      // The receipt says a siltpoke install wrote this slot, so the source
      // wrapper's shape is enough here. Without a receipt it is not (see `found`).
      return isOurStatusLine(command) || isSourceWrapper(command);
    }
    case "unwire-agy-statusline":
      return isOurAgyStatusLine(statusLineCommand(probes, e.target));
    case "remove-hook-entries":
    case "remove-json-key":
      return hooksPresent(e, probes);
    case "defaults-delete":
      return prefIsSet(probes, e.undo.domain, e.undo.key);
    case "unload-and-delete":
    case "remove-if-hash":
    case "remove-link":
      return probes.exists(e.target);
    default:
      // An undo type this version does not know: say present rather than
      // "already gone". Grouping is by id, not by undo type — an unknown ID
      // lands in "other" (never offered); a known id is offered as usual.
      return true;
  }
}

/** What names siltpoke on this disk (spec §8 D-A), in the plan's group order. */
function findNamed(env: NodeJS.ProcessEnv, probes: DiskProbes): FoundOnDisk[] {
  const found: FoundOnDisk[] = [];
  const home = homeDir(env);

  const claudeSettings = settingsJsonPath(env);
  if (isOurStatusLine(statusLineCommand(probes, claudeSettings))) {
    found.push({ id: "statusline:claude-code", kind: "statusline", target: claudeSettings });
  }
  const agySettings = join(resolveAntigravityHome(env), "settings.json");
  if (isOurAgyStatusLine(statusLineCommand(probes, agySettings))) {
    found.push({ id: "statusline:antigravity", kind: "statusline", target: agySettings });
  }
  // Hooks a source install wrote into a host's own file, where the file's own
  // text says they are siltpoke's (uninstall-hooks.ts).
  for (const [id, path] of hookFiles(env)) {
    const text = probes.readText(path);
    if (text === null) continue;
    // Unparseable (a settings file with comments): listed when its text carries
    // siltpoke's own string, so the removal says "could not finish" — not silence.
    const holds = holdsSiltpokeHooks(text, null, id) ?? textNamesSiltpoke(text, id);
    if (holds) found.push({ id, kind: "host-hook", target: path });
  }
  // Slash-command links a source install left in a host's commands folder.
  for (const dir of [commandsDirPath(env), codebuddyAdapter.commandsDir(env), qoderAdapter.commandsDir(env)]) {
    for (const link of probes.linksIn(dir)) {
      if (isSiltpokeCommandLink(link.path, link.target)) found.push({ id: `file:${link.path}`, kind: "file", target: link.path });
    }
  }
  const unit = autostartUnitPath(probes.platform, env);
  if (unit !== null && probes.exists(unit)) {
    found.push({ id: "launch-agent:daemon", kind: "launch-agent", target: unit });
  }
  // The server itself: a pidfile is what a running (or just-killed) daemon leaves.
  const dataDir = siltpokeRoot(env);
  const pidfile = join(dataDir, "siltpoked.pid");
  if (probes.exists(pidfile)) found.push({ id: "process:daemon", kind: "file", target: pidfile });
  // The data folder is siltpoke's by name. Purge level; the planner says so.
  if (probes.exists(dataDir)) found.push({ id: "data:home", kind: "user-data", target: dataDir });
  if (probes.platform !== "darwin") return found;

  // The shim SwiftBar reads, and one left behind in the default folder.
  const obeyed = resolveObeyedShimPath(probes.exec, home);
  const stranded = strandedShimPath(obeyed, home, probes.exists);
  for (const path of [obeyed, stranded]) {
    if (path !== null && isSiltpokeShim(probes.readText(path) ?? "")) {
      found.push({ id: `file:${path}`, kind: "file", target: path });
    }
  }
  const loginItem = swiftbarPlistPath(home);
  if (probes.exists(loginItem)) {
    found.push({ id: "launch-agent:swiftbar", kind: "launch-agent", target: loginItem });
  }
  if (prefIsSet(probes, SWIFTBAR_DEFAULTS_DOMAIN, SWIFTBAR_PLUGIN_DIR_KEY)) {
    found.push({
      id: `pref:${SWIFTBAR_DEFAULTS_DOMAIN}.${SWIFTBAR_PLUGIN_DIR_KEY}`,
      kind: "macos-pref",
      target: SWIFTBAR_DEFAULTS_DOMAIN,
    });
  }
  return found;
}

export function readDisk(receipt: Receipt | null, env: NodeJS.ProcessEnv, probes: DiskProbes): DiskView {
  const present = new Set((receipt?.entries ?? []).filter((e) => isPresent(e, probes)).map((e) => e.id));
  const purge = findPurgeItems(receipt, env, probes);
  return { present, found: [...findNamed(env, probes), ...purge.found], verdicts: purge.verdicts };
}

/** Probes over the real filesystem. `exec` and `toolPresent` stay with the caller: they leave the process. */
export function fsDiskProbes(
  exec: ProbeExec,
  platform: NodeJS.Platform,
  toolPresent: DiskProbes["toolPresent"],
): DiskProbes {
  return {
    platform,
    exists: (path) => {
      try {
        lstatSync(path);
        return true;
      } catch {
        return false;
      }
    },
    readText: (path) => {
      try {
        return readFileSync(path, "utf8");
      } catch {
        return null;
      }
    },
    namesIn: (dir) => {
      try {
        return readdirSync(dir);
      } catch {
        return [];
      }
    },
    linksIn: (dir) => {
      let names: string[];
      try {
        names = readdirSync(dir);
      } catch {
        return [];
      }
      return names.flatMap((name) => {
        const path = join(dir, name);
        const target = linkTarget(path);
        return target === null ? [] : [{ path, target }];
      });
    },
    exec,
    toolPresent,
  };
}

/**
 * `exec` for a given home. macOS `defaults` answers for the ACCOUNT, whatever
 * `HOME` says, so under any other home (a sandbox, a test, `HOME=… siltpoke`)
 * its answer is about a different home's SwiftBar — and following it listed,
 * and would have removed, the real home's menu-bar shim. There the question
 * is not asked: the pref reads as unset.
 */
export function homeScopedExec(
  exec: ProbeExec,
  env: NodeJS.ProcessEnv,
  // null (it cannot be read) means `defaults` is not followed.
  accountHome: (exec: ProbeExec) => string | null = macAccountHome,
): ProbeExec {
  let same: boolean | undefined;
  return (cmd, args) => {
    if (cmd !== "defaults") return exec(cmd, args);
    // Asked once, and only when a `defaults` question actually comes up.
    same ??= accountHome(exec) === homeDir(env).replace(/\/+$/, "");
    return same ? exec(cmd, args) : { status: 1, stdout: "" };
  };
}

