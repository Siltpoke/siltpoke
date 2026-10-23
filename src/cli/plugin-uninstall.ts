// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
// Copyright (c) 2026 Jiaqi Duan
import { existsSync, lstatSync, readFileSync, unlinkSync } from "node:fs";
import { rm } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { setDaemonEnabled } from "../config/write-daemon-enabled";
import { isSiltpokedPing, resolveDaemonPort } from "../daemon/port";
import { type AgyUnwireOutcome, unwireAgyStatusline } from "../installer/agy-statusline";
import { uninstallAutostartForPlatform } from "../installer/autostart";
import { settingsJsonPath, siltpokeRoot } from "../installer/paths";
import { claudeUninstallCommands, codexListsPlugin, type HostAnswer, hostsWithPlugin } from "../installer/plugin-hosts";
import { isSiltpokeShim } from "../installer/receipt-sites";
import {
  isOurStatusLine,
  readSettingsObject,
  restoreUserStatusLine,
  type StatusLineRestore,
} from "../installer/statusline-restore";
import { uninstallSwiftbarAutostart } from "../installer/swiftbar-autostart";
import { isSourceWrapper } from "./uninstall-disk";

/**
 * Uninstall for a PLUGIN install (defect [61]).
 *
 * `runUninstall` (./uninstall.ts) is the source-checkout path and is wrong for
 * a plugin user twice over: it copies a whole `settings.json` backup back over
 * the live file, and it looks for hooks a plugin install never wrote.
 *
 * This one undoes, piece by piece, what setup and the optional surfaces wrote
 * OUTSIDE the plugin directory. It does not remove the plugin itself — only the
 * host can do that — and it runs in either order relative to the host's own
 * uninstall: from `/siltpoke:siltpoke-uninstall` while the plugin is still there, or from
 * `~/.siltpoke/bin/uninstall.sh` after it is gone.
 */

/** The steps that touch the machine. Required, so a test cannot reach it by omission. */
export interface UninstallEffects {
  removeAutostart: () => Promise<"removed" | "not-installed" | "skipped">;
  stopDaemon: () => Promise<"stopping" | "not-running">;
  /**
   * Exactly the targets, and a listed shim only while it is still a siltpoke
   * shim (`kept` names the ones that were not). It never looks for a shim on
   * its own: the removal plan does the looking (uninstall-disk.ts).
   */
  removeMenubar: (targets: MenubarTargets) => Promise<MenubarOutcome>;
  /** Codex has no registry file to read; it has to be asked (it may not exist). */
  codexListsPlugin: () => HostAnswer;
}

/** What the removal plan listed as removable in the menu-bar group. */
export interface MenubarTargets {
  shims: string[];
  loginItem: boolean;
}

interface MenubarOutcome {
  shim: boolean;
  loginItem: boolean;
  /** Listed shims left in place because they are no longer siltpoke's. */
  kept?: string[];
}

/** The pieces of wiring this run can take back; the removal plan asks for them one group at a time. */
export type UninstallStep = "status-line" | "agy-status-line" | "dashboard" | "menubar";

export interface PluginUninstallOptions {
  /** Also delete ~/.siltpoke. Honoured only when nothing can write it back. */
  purge?: boolean;
  /** Which steps to run. A step left out reports "not-asked". */
  steps: ReadonlySet<UninstallStep>;
  /** The plan's menu-bar items: the menu-bar step removes these and nothing else. Omitted ⇒ nothing. */
  menubar?: MenubarTargets;
  /** A receipt-backed claim on Claude's status line beyond the plugin shim (the source wrapper). */
  statusLineIsOurs?: (command: unknown) => boolean;
  /** How the folder is deleted once the purge is allowed. Omitted ⇒ all of it. */
  deleteData?: () => void | Promise<void>;
  /** What `deleteData` leaves behind in receipt.json: entries, and roots of `.siltpoke/` folders still on disk. */
  receiptKept?: number;
  projectsKept?: number;
}

type NotAsked = "not-asked";

export interface PluginUninstallReport {
  statusLine: StatusLineRestore | "failed" | NotAsked;
  agyStatusLine: AgyUnwireOutcome | "failed" | NotAsked;
  autostart: "removed" | "not-installed" | "skipped" | "failed" | NotAsked;
  daemon: "stopping" | "not-running" | "failed" | NotAsked;
  menubar: MenubarOutcome | "failed" | NotAsked;
  /** Hosts that still list the plugin. Their hooks can still write ~/.siltpoke. */
  hosts: string[];
  /** False when no registry could be read — then `hosts` being empty proves nothing. */
  hostsKnown: boolean;
  purged: boolean;
  /** Left in ~/.siltpoke/receipt.json by a purge: entries for things of ours still on the machine, and project folders still on disk. */
  receiptKept: number;
  projectsKept: number;
  /** False only when settings.json exists and cannot be parsed. */
  settingsReadable: boolean;
  /** Why a requested purge did not happen, or null. */
  purgeRefused: "plugin-installed" | "unknown-install-state" | "status-line-not-restored" | null;
}

/** Status-line outcomes after which settings.json no longer needs ~/.siltpoke. */
const STATUS_LINE_SETTLED: ReadonlySet<PluginUninstallReport["statusLine"]> = new Set([
  "restored",
  "removed",
  "not-ours",
  "no-settings",
]);

const STATUS_LINE_DONE: Partial<Record<PluginUninstallReport["statusLine"], string>> = {
  restored: "status line: your own status line is back",
  removed: "status line: Siltpoke's was removed (you had none before it)",
  "not-ours": "status line: not Siltpoke's — left as it is",
  "no-settings": "status line: no settings.json — nothing to change",
};

/** One step, isolated: a failure is recorded and the next step still runs. */
async function step<T>(errors: string[], label: string, run: () => Promise<T> | T): Promise<T | "failed"> {
  try {
    return await run();
  } catch (err) {
    errors.push(`${label}: ${err instanceof Error ? err.message : String(err)}`);
    return "failed";
  }
}

/**
 * What one call changed. The caller prints it: `done` and `errors` one line
 * each, and `next` — what is left for the user, in the order they have to do
 * it — only after a purge that was asked for and did not happen.
 */
export interface PluginUninstallResult {
  report: PluginUninstallReport;
  exitCode: number;
  done: string[];
  errors: string[];
  next: string[];
}

export async function runPluginUninstall(
  env: NodeJS.ProcessEnv,
  opts: PluginUninstallOptions,
  effects: UninstallEffects,
): Promise<PluginUninstallResult> {
  const dataDir = siltpokeRoot(env);
  const errors: string[] = [];
  const runs = (s: UninstallStep) => opts.steps.has(s);

  // settings.json first: it reads ~/.siltpoke/inner.txt, which --purge deletes.
  const statusLine = runs("status-line")
    ? await step(errors, "status line", () => restoreUserStatusLine(env, opts.statusLineIsOurs))
    : "not-asked";
  if (statusLine === "unreadable") {
    errors.push("status line: settings.json is not valid JSON — left untouched. Fix the file and run this again.");
  }
  const agyStatusLine = runs("agy-status-line")
    ? await step(errors, "Antigravity status line", () => unwireAgyStatusline(env))
    : "not-asked";
  if (agyStatusLine === "unwritable") {
    errors.push("Antigravity status line: its settings file could not be read or written — left untouched.");
  }

  // The purge is decided here, before anything that exists only to make it
  // possible. The data goes only when nothing can write it back and nothing
  // still needs it:
  //  - any host that still lists the plugin keeps hooks that recreate the folder;
  //  - a settings.json that still points at ~/.siltpoke/bin/statusline.sh needs
  //    inner.txt (the only copy of the user's own status line) to be repaired.
  // Only a purge needs to know: asking codex spawns a process.
  const asked = opts.purge
    ? await step(errors, "plugin check", () => hostsWithPlugin(env, effects.codexListsPlugin))
    : { hosts: [], known: false };
  const { hosts, known: hostsKnown } = asked === "failed" ? { hosts: [], known: false } : asked;
  let purgeRefused: PluginUninstallReport["purgeRefused"] = null;
  if (opts.purge) {
    // The status line is checked FIRST. Its refusal is the one that protects
    // inner.txt, and the "unknown" refusal's advice is to delete the folder by
    // hand — which must never be printed while that file is still needed.
    const settled = statusLine === "not-asked" ? !claudeStatusLineStillOurs(env) : STATUS_LINE_SETTLED.has(statusLine);
    if (!settled) purgeRefused = "status-line-not-restored";
    else if (hosts.length > 0) purgeRefused = "plugin-installed";
    else if (!hostsKnown) purgeRefused = "unknown-install-state";
  }
  // Deleting the data means stopping what writes it — but only when the data
  // will in fact be deleted: a refused purge runs none of these steps (review
  // round 1, I1).
  const dashboard = runs("dashboard") || (opts.purge === true && purgeRefused === null);
  // Autostart before the daemon: a keep-alive unit restarts what was just stopped.
  const autostart = dashboard ? await step(errors, "daemon autostart", effects.removeAutostart) : "not-asked";
  // The Stop hook of a session that is still open revives the daemon whenever
  // daemon.enabled is on (src/hooks/on-stop.ts) — switch it off before stopping.
  if (dashboard && existsSync(join(dataDir, "config.json"))) {
    await step(errors, "daemon config", () => setDaemonEnabled(dataDir, false));
  }
  const daemon = dashboard ? await step(errors, "daemon", effects.stopDaemon) : "not-asked";
  const menubar = runs("menubar")
    ? await step(errors, "menu bar", () => effects.removeMenubar(opts.menubar ?? { shims: [], loginItem: false }))
    : "not-asked";
  if (typeof menubar === "object") {
    for (const path of menubar.kept ?? []) {
      errors.push(`menu bar: ${path} is no longer the file Siltpoke wrote — left as it is.`);
    }
  }

  let purged = false;
  if (opts.purge && purgeRefused === null) {
    const done = await step(errors, "delete ~/.siltpoke", opts.deleteData ?? (() => rm(dataDir, { recursive: true, force: true })));
    purged = done !== "failed";
  }

  const report: PluginUninstallReport = {
    statusLine,
    agyStatusLine,
    autostart,
    daemon,
    menubar,
    hosts,
    hostsKnown,
    purged,
    receiptKept: purged ? (opts.receiptKept ?? 0) : 0,
    projectsKept: purged ? (opts.projectsKept ?? 0) : 0,
    settingsReadable: !existsSync(settingsJsonPath(env)) || readSettingsObject(settingsJsonPath(env)) !== null,
    purgeRefused,
  };
  // Non-zero whenever the run did not do what was asked — a step failed, or a
  // requested purge was refused. Same as the shell fallback in uninstall.sh.
  const exitCode = errors.length > 0 || purgeRefused !== null ? 1 : 0;
  return { report, exitCode, done: doneLines(report), errors, next: opts.purge ? nextSteps(report, env) : [] };
}

/**
 * For a purge that did not run the status-line step itself: does settings.json
 * still point into ~/.siltpoke? A file that cannot be read counts as "yes" —
 * unknown is not settled.
 */
function claudeStatusLineStillOurs(env: NodeJS.ProcessEnv): boolean {
  const path = settingsJsonPath(env);
  if (!existsSync(path)) return false;
  const settings = readSettingsObject(path);
  if (settings === null) return true;
  const command = (settings.statusLine as { command?: unknown } | undefined)?.command;
  // The source wrapper reads inner.txt as well (src/face/wrapper.ts), so it
  // counts here whether or not a receipt recorded it: this gate protects the
  // file, and over-refusing costs one message (review round 2, I-1).
  return isOurStatusLine(command) || isSourceWrapper(command);
}

/** `n` of something, as a list of one phrase; empty when there is none. */
const counted = (n: number, one: string, many: string): string[] => (n > 0 ? [`${n} ${n === 1 ? one : many}`] : []);
/** What the run actually changed — one line each, nothing for a step that found nothing. */
function doneLines(r: PluginUninstallReport): string[] {
  const done: string[] = [];
  const statusLine = STATUS_LINE_DONE[r.statusLine];
  if (statusLine) done.push(statusLine);
  if (r.agyStatusLine === "removed") done.push("Antigravity status line: Siltpoke's was removed");
  if (r.autostart === "removed") done.push("start-at-login for the dashboard: removed");
  if (r.daemon === "stopping") done.push("dashboard server: told to stop");
  if (typeof r.menubar === "object" && (r.menubar.shim || r.menubar.loginItem)) done.push("menu-bar pet: removed");
  const still = [...counted(r.receiptKept, "thing Siltpoke installed that is", "things Siltpoke installed that are"), ...counted(r.projectsKept, "project folder", "project folders")];
  const kept = still.map((what) => `${what} still on this machine`);
  if (r.purged) done.push(`your Siltpoke data (~/.siltpoke): deleted${kept.length > 0 ? `, except receipt.json: it still records ${kept.join(" and ")}` : ""}`);
  return done;
}

const DATA_STILL_THERE = "Your pet, its memory and its review history are still in ~/.siltpoke.";
const PURGE_COMMAND = "sh ~/.siltpoke/bin/uninstall.sh --purge";

const PURGE_REFUSED_TEXT: Record<NonNullable<PluginUninstallReport["purgeRefused"]>, string> = {
  "plugin-installed":
    " They were NOT deleted: while the plugin is installed its hooks would write the folder straight back.",
  "unknown-install-state":
    " They were NOT deleted: Siltpoke could not tell whether the plugin is still installed, and if it is, its hooks would write the folder straight back.",
  "status-line-not-restored":
    " They were NOT deleted: your settings still point into that folder, and it holds the only copy of your own status line.",
};

/** For a purge that did not run the status-line step: what to do first, named by what the user can see. */
function statusLineAdvice(settingsReadable: boolean): string {
  return settingsReadable
    ? " Put your own status line back first: remove the [claude-code] group if the list shows it, or run `bun run uninstall` in the source checkout if you installed from source."
    : " Claude Code's settings.json cannot be read, so Siltpoke cannot tell. Fix that file first.";
}

/** After a purge that was asked for: what is left for the user, in the order they have to do it. */
function nextSteps(r: PluginUninstallReport, env: NodeJS.ProcessEnv): string[] {
  const next: string[] = [];
  for (const host of r.hosts) {
    next.push(
      host === "Claude Code"
        ? `Remove the plugin from Claude Code (only the host can do this):\n      ${claudeUninstallCommands(env).join("\n      ")}`
        : `Siltpoke is still installed in ${host}. Uninstall it there too, with ${host}'s own plugin command.`,
    );
  }
  if (r.purged) return next;
  let refused = r.purgeRefused ? PURGE_REFUSED_TEXT[r.purgeRefused] : "";
  if (r.purgeRefused === "status-line-not-restored") {
    // Point at something that is on the screen: the failed step, or the group not yet removed.
    refused += r.statusLine === "not-asked" ? statusLineAdvice(r.settingsReadable) : ' Fix what is marked "could not finish" above first.';
  }
  next.push(`${DATA_STILL_THERE}${refused}\n    ${howToDelete(r)}`);
  return next;
}

/** Never the command that just refused: each refusal gets the step that unblocks it. */
function howToDelete(r: PluginUninstallReport): string {
  if (r.purgeRefused === "unknown-install-state") {
    // No host answered, so running the same command again refuses again. The
    // user is the only one who can know; give them the direct way.
    return "If you are sure no coding agent still has the Siltpoke plugin, delete the folder yourself:\n      rm -rf ~/.siltpoke";
  }
  if (r.purgeRefused === "status-line-not-restored") {
    return `After that is fixed, run:\n      ${PURGE_COMMAND}`;
  }
  if (r.hosts.length > 0) {
    return `To delete them, uninstall the plugin first, close your coding agent, then run:\n      ${PURGE_COMMAND}\n    (If a host is listed above by mistake, delete the folder yourself: rm -rf ~/.siltpoke)`;
  }
  return `To delete them:\n      ${PURGE_COMMAND}`;
}

/**
 * The pid it is safe to stop, or null.
 *
 * TWO independent sources must name the same process:
 *  - the pidfile, which only something that can write ~/.siltpoke can forge;
 *  - the answer on the daemon port, which proves that process is alive and is
 *    siltpoked right now.
 * The pidfile alone may name a pid the OS has since given to something else.
 * The port alone can be answered by ANY local process, which would then choose
 * what gets killed. Neither is enough; together they are.
 */
export function daemonPidToStop(pingBody: unknown, pidfileText: string | null): number | null {
  if (pidfileText === null || !isSiltpokedPing(pingBody)) return null;
  const answered = (pingBody as { pid?: unknown }).pid;
  const recorded = Number(pidfileText.trim());
  if (typeof answered !== "number" || !Number.isInteger(recorded) || recorded <= 0) return null;
  return answered === recorded ? recorded : null;
}

/** The real machine. Built only by the CLI entry — never inside a test. */
export function realUninstallEffects(
  env: NodeJS.ProcessEnv,
  // Injectable because the real one reaches the account's launchd domain, not `home`'s.
  removeLoginItem: (home: string) => boolean = (home) => uninstallSwiftbarAutostart({ home }).removed,
): UninstallEffects {
  return {
    removeAutostart: async () => {
      const result = await uninstallAutostartForPlatform({ home: env.HOME ?? homedir(), env });
      return result.status === "removed" ? "removed" : result.status === "skipped" ? "skipped" : "not-installed";
    },

    stopDaemon: async () => {
      let body: unknown;
      try {
        const res = await fetch(`http://127.0.0.1:${resolveDaemonPort(env)}/api/ping`, {
          signal: AbortSignal.timeout(1500),
        });
        if (!res.ok) return "not-running";
        body = await res.json();
      } catch {
        return "not-running";
      }
      const pidPath = join(siltpokeRoot(env), "siltpoked.pid");
      const pid = daemonPidToStop(body, existsSync(pidPath) ? readFileSync(pidPath, "utf8") : null);
      if (pid === null) return "not-running";
      process.kill(pid, "SIGTERM");
      return "stopping";
    },

    codexListsPlugin,

    removeMenubar: async (targets) => {
      if (process.platform !== "darwin") return { shim: false, loginItem: false };
      const home = env.HOME ?? homedir();
      // Exactly what the plan listed. A listed file that is no longer a
      // siltpoke shim is the user's now (the hash check proper is plan P3.4).
      const kept: string[] = [];
      let shim = false;
      for (const path of targets.shims) {
        // lstat, like the plan's presence check: a dangling link is still there.
        if (lstatSync(path, { throwIfNoEntry: false }) === undefined) continue;
        let content: string | null = null;
        try {
          content = readFileSync(path, "utf8");
        } catch {
          // Unreadable (a dangling link, a directory, no permission): not ours to judge.
        }
        if (content !== null && isSiltpokeShim(content)) {
          unlinkSync(path);
          shim = true;
        } else kept.push(path);
      }
      const loginItem = targets.loginItem ? removeLoginItem(home) : false;
      return { shim, loginItem, kept };
    },
  };
}
