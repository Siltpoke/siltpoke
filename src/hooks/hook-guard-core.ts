// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
// Copyright (c) 2026 Jiaqi Duan
/**
 * The hook guard's DECISIONS — what should happen, with no process started and
 * nothing written but the nudge marker. The runtime half lives in
 * `hook-guard.ts`, which is the bundle entrypoint.
 *
 * The split is not filing: the property that matters most about this guard is
 * that it never writes into the user's session, and that property belongs to
 * the wrapper. Keeping the decisions pure is what lets every branch be reached
 * from a test without a real `$HOME`, and keeping the wrapper small is what
 * lets a test assert the silence directly rather than by reading the code.
 *
 * Read `hook-guard.ts`'s header first — it carries the why.
 */
import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveBunPath } from "../installer/bun-path";
import { PathError, siltpokeRoot } from "../installer/paths";
import { atomicWrite } from "../utils/atomic-write";

/**
 * Which hook this run is. The two `codex-` modes are codex's own events, started
 * by the `commandWindows` entries in the plugin-root `hooks.json`: on Windows
 * they stand in for `hooks/codex-stop.sh` and `hooks/codex-session-start.sh`,
 * which cannot start there because native Windows has no `sh`.
 */
export type GuardMode = "stop" | "session-start" | "codex-stop" | "codex-session-start";

const GUARD_MODES: readonly GuardMode[] = ["stop", "session-start", "codex-stop", "codex-session-start"];

/** The bundle each mode hands the payload to, mirroring the four `.sh` guards. */
const BUNDLE_FOR_MODE: Record<GuardMode, string> = {
  stop: "siltpoke-stop.js",
  "session-start": "handle-session-start.js",
  "codex-stop": "codex-stop.js",
  "codex-session-start": "handle-session-start.js",
};

/** The mode named in argv. Anything unrecognised is `stop`, the hook that matters. */
export function parseGuardMode(argv: readonly string[]): GuardMode {
  return GUARD_MODES.find((m) => argv.includes(m)) ?? "stop";
}

/**
 * Printed once, ever, when the plugin is live but setup has not run.
 *
 * Byte-identical to `hooks/stop.sh`'s line on purpose: two platforms disagreeing
 * about the wording of the one message a new user sees is a support question
 * nobody needs.
 */
export const NUDGE_TEXT =
  "Siltpoke installed. Run /siltpoke:siltpoke-setup to meet your pet (express or custom).";

/**
 * The once-ever marker, under the siltpoke home. Same name in `hooks/stop.sh`.
 *
 * Renamed from `.nudged` with the fix for defect [33]. Every Claude Code user
 * who installed without running setup already has a `.nudged` — written by a
 * nudge that reached no one. Keeping that name would leave exactly the users
 * the fix is for without the line forever. A new name gives each of them one
 * visible nudge; the old file is simply ignored.
 */
export const NUDGE_MARKER = ".setup-nudged";

/**
 * The nudge as the host must receive it: one line of JSON on STDOUT.
 *
 * Defect [33]: this used to be the bare text on stderr, and it never reached a
 * session. Claude Code sends an exit-0 hook's stderr to the debug log only
 * (the same fact `tests/hooks/windows-launcher.test.ts` already relied on to
 * keep `powershell: command not found` out of the transcript), and on Windows
 * the launcher discarded stderr on top of that. `systemMessage` is the field a
 * hook uses to show the user a line — measured 2026-09-29, install audit §46.5:
 * a stderr hook provably ran and its text appeared 0 times; a sibling hook's
 * `systemMessage` appeared once. Byte-identical to `hooks/stop.sh`'s line.
 */
export function nudgeLine(text: string): string {
  return `${JSON.stringify({ systemMessage: text })}\n`;
}

export interface GuardDeps {
  env: NodeJS.ProcessEnv;
  /** Injected so every branch is reachable without a real `$HOME`. */
  resolveBun?: (home: string) => string | null;
  fileExists?: (path: string) => boolean;
  /**
   * Write the once-ever nudge marker. Returns whether it actually landed.
   *
   * The return value is load-bearing: on a permanently unwritable siltpoke home
   * the write fails every single turn, and a guard that printed regardless would
   * turn a once-ever nudge into a per-turn nag — the exact spam the marker
   * exists to prevent (`hooks/stop.sh:28-34`).
   */
  writeNudgeMarker?: (path: string) => boolean;
  /** This module's own directory, for the last rung of the plugin-root ladder. */
  guardDir?: string;
}

export type GuardOutcome =
  | {
      action: "exit";
      reason: "no-home" | "no-config" | "no-bun" | "no-plugin-root" | "no-bundle" | "internal-error";
      /** The text to print, or null. Only ever non-null for `no-config`. */
      nudge: string | null;
    }
  | {
      action: "run";
      bun: string;
      bundle: string;
      /** Empty when unresolved — brain-config then falls back to claude. */
      hostFamily: string;
    };

/**
 * This module's own directory.
 *
 * `fileURLToPath`, NOT `new URL(...).pathname`: on Windows the raw pathname of a
 * `file://` URL keeps a leading slash before the drive letter (`/C:/…`), which
 * every later `join`/`resolve` then carries. This is the repo's recurring
 * bundled-path-arithmetic defect wearing a Windows hat. Caught in review.
 */
export function defaultGuardDir(): string {
  try {
    return dirname(fileURLToPath(import.meta.url));
  } catch {
    return "";
  }
}

function defaultFileExists(path: string): boolean {
  try {
    return existsSync(path);
  } catch {
    return false;
  }
}

function defaultWriteNudgeMarker(path: string): boolean {
  try {
    atomicWrite(path, "");
    return defaultFileExists(path);
  } catch {
    return false;
  }
}

/**
 * Resolve the plugin root through the same ladder as `hooks/stop.sh:86-89`:
 * CLAUDE first, then the fork-specific names, then this module's own location.
 *
 * ⚠️ **This order is NOT the same as `detectHostFamily`'s below, and the
 * difference is deliberate in the shell original.** `stop.sh` uses CLAUDE-first
 * for the plugin ROOT (86-89) and fork-first for the host FAMILY (99-102),
 * because they answer different questions: "where are the files" takes the
 * host's own answer whoever the host is, while "who built this run" wants the
 * most specific claim. The first draft of this port reused the fork-first order
 * for both, which would have resolved a DIFFERENT plugin root from Unix on any
 * fork that exports both variables — a stale `dist/`, or a `no-bundle` exit
 * where Unix succeeds. Caught in review, 2026-09-24.
 *
 * `resolve` rather than string concatenation: a Windows root arrives with
 * backslashes, sometimes a trailing separator, and this is the repo's recurring
 * defect class. Path arithmetic belongs in the module that has a path library —
 * never in the `.ps1`.
 */
export function resolvePluginRoot(env: NodeJS.ProcessEnv, guardDir: string): string | null {
  for (const key of ["CLAUDE_PLUGIN_ROOT", "QODER_PLUGIN_ROOT", "CODEBUDDY_PLUGIN_ROOT"]) {
    const value = env[key];
    if (typeof value === "string" && value.length > 0) return resolve(value);
  }
  // dist/siltpoke-hook-guard.js -> dist -> plugin root
  return guardDir.length > 0 ? resolve(guardDir, "..") : null;
}

/**
 * Record where this build of the plugin lives, for the surfaces that cannot
 * read `${CLAUDE_PLUGIN_ROOT}` — the statusline command and the daemon
 * autostart unit — so they still find the bundle after an upgrade moves the
 * plugin cache directory.
 *
 * `hooks/session-start.sh:12-34` does this **unconditionally, before any
 * gating**: no config.json, no bun and no bundle all still leave the pointer
 * refreshed. The first draft of this port gated it behind the same checks as
 * the bundle invocation, which on Windows would have left the pointer stale
 * after every upgrade until setup was re-run. Caught in review, 2026-09-24.
 *
 * Every failure is swallowed. An unwritable siltpoke home means no pointer, not
 * a message in the user's session.
 */
export function writePluginRootPointer(env: NodeJS.ProcessEnv, guardDir: string): boolean {
  try {
    const root = siltpokeRoot(env);
    const pluginRoot = resolvePluginRoot(env, guardDir);
    if (!pluginRoot) return false;
    const pointer = join(root, "plugin-root");
    if (keepsCurrentRoot(pointer, pluginRoot)) return false;
    atomicWrite(pointer, pluginRoot);
    return true;
  } catch {
    return false;
  }
}

/**
 * Whether the pointer should stay on the copy it names rather than move to
 * `candidate` — defect [91]. Several hosts each name their own copy, and the
 * daemon restarts from whichever wrote last, so an old copy kept winning.
 * Stay when the named copy still has its daemon bundle and that bundle's
 * mtime is newer than the candidate's, or the candidate has none. mtime is a
 * proxy for "installed or built more recently": a copy made with preserved
 * timestamps can mislead it. Equal age: move, so
 * the last writer wins as before. Same rule as `hooks/session-start.sh`.
 */
function keepsCurrentRoot(pointer: string, candidate: string): boolean {
  let current: string;
  try {
    current = readFileSync(pointer, "utf8").trim();
  } catch {
    return false;
  }
  if (current === "" || current === candidate) return false;
  const mtimeOf = (r: string): number | null => {
    try {
      return statSync(join(r, "dist", "siltpoke-daemon.js")).mtimeMs;
    } catch {
      return null;
    }
  };
  const held = mtimeOf(current);
  if (held === null) return false;
  const offered = mtimeOf(candidate);
  return offered === null || held > offered;
}

/**
 * Which CC-family host built this run, for brain-config's reviewer default.
 *
 * Fork-specific names FIRST (a fork could also export CLAUDE_PLUGIN_ROOT, and
 * the specific name wins), plain claude LAST. None present => empty => treated
 * as unknown => claude fallback => zero regression. Mirrors `stop.sh:99-102`.
 */
export function detectHostFamily(env: NodeJS.ProcessEnv): string {
  if (env.QODER_PLUGIN_ROOT) return "qoder";
  if (env.CODEBUDDY_PLUGIN_ROOT) return "codebuddy";
  if (env.CLAUDE_PLUGIN_ROOT) return "claude";
  return "";
}

/**
 * The family for this run. A `codex-` mode is codex by construction — only
 * codex's own manifest starts one — exactly as `codex-stop.sh` hard-codes
 * `SILTPOKE_HOST=codex`. Asking the environment instead would answer `claude`:
 * codex exports `CLAUDE_PLUGIN_ROOT` to plugin hooks for compatibility.
 */
export function hostFamilyFor(mode: GuardMode, env: NodeJS.ProcessEnv): string {
  return mode.startsWith("codex-") ? "codex" : detectHostFamily(env);
}

/**
 * The text to print when setup has not run, or null to stay silent.
 *
 * Two independent reasons this returns null more often than it returns text:
 *   - `hooks/session-start.sh` has no nudge at all, so a second copy of the
 *     same line from a second hook would double it on every turn of a fresh
 *     install.
 *   - The marker must actually LAND. On a permanently unwritable siltpoke home
 *     the write fails every turn, and printing regardless would turn a
 *     once-ever nudge into a per-turn nag (`hooks/stop.sh:28-34`).
 */
function nudgeFor(
  mode: GuardMode,
  root: string,
  fileExists: (path: string) => boolean,
  writeMarker: (path: string) => boolean,
): string | null {
  if (mode !== "stop") return null;
  const marker = join(root, NUDGE_MARKER);
  if (fileExists(marker)) return null;
  return writeMarker(marker) ? NUDGE_TEXT : null;
}

/**
 * Decide what should happen. Pure apart from the stats it needs — it starts no
 * process and writes nothing except the nudge marker, whose writer is injected.
 *
 * The split exists so every branch is testable without a real home directory,
 * and so the never-print property belongs to `main` — a small surface that a
 * test can assert directly — rather than being spread through the decisions.
 */
export function decide(mode: GuardMode, deps: GuardDeps): GuardOutcome {
  const env = deps.env;
  const fileExists = deps.fileExists ?? defaultFileExists;
  const writeMarker = deps.writeNudgeMarker ?? defaultWriteNudgeMarker;

  let root: string;
  try {
    root = siltpokeRoot(env);
  } catch (err) {
    // Neither HOME nor USERPROFILE is set. Nothing can be resolved from here,
    // and a PathError escaping would print — so it is swallowed like any other
    // missing precondition.
    if (!(err instanceof PathError)) throw err;
    return { action: "exit", reason: "no-home", nudge: null };
  }

  if (!fileExists(join(root, "config.json"))) {
    return {
      action: "exit",
      reason: "no-config",
      nudge: nudgeFor(mode, root, fileExists, writeMarker),
    };
  }

  const resolveBun = deps.resolveBun ?? ((home: string) => resolveBunPath(home));
  const bun = resolveBun(root);
  if (!bun) {
    // NO nudge on this path, deliberately (`hooks/stop.sh:72-76`). config.json
    // exists, so setup already succeeded, and "run /siltpoke:siltpoke-setup" would send
    // the user to redo the one step that worked. `/siltpoke:siltpoke-doctor` is the
    // surface that says this out loud — and on Windows it says it by RUNNING
    // this guard in `--self-test`, not by re-asking the same question.
    return { action: "exit", reason: "no-bun", nudge: null };
  }

  const guardDir = deps.guardDir ?? defaultGuardDir();
  const pluginRoot = resolvePluginRoot(env, guardDir);
  if (!pluginRoot) return { action: "exit", reason: "no-plugin-root", nudge: null };

  const bundle = join(pluginRoot, "dist", BUNDLE_FOR_MODE[mode]);
  if (!fileExists(bundle)) return { action: "exit", reason: "no-bundle", nudge: null };

  return { action: "run", bun, bundle, hostFamily: hostFamilyFor(mode, env) };
}

/**
 * Read all of stdin as BYTES.
 *
 * Bytes rather than a string, and not as a style preference: Windows PowerShell
 * 5.1 does not default to UTF-8 on its pipes, so a payload carrying CJK or emoji
 * — which this product's transcripts routinely do — can be mangled by a string
 * round-trip. The guard would then fail to parse the JSON and, obeying its own
 * never-print contract, exit 0 in silence: the very defect this file exists to
 * remove, reproduced by the fix for it. The launcher hands over bytes and they
 * are forwarded untouched.

/** The one line `--self-test` prints, and the only output this module ever emits. */
export function selfTestLine(outcome: GuardOutcome): string {
  if (outcome.action === "run") {
    return `siltpoke-guard ok bun=${outcome.bun} bundle=${outcome.bundle}`;
  }
  return `siltpoke-guard ${outcome.reason}`;
}
