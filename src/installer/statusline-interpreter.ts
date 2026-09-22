// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
// Copyright (c) 2026 Jiaqi Duan
import { existsSync } from "node:fs";

/**
 * Which interpreter runs `~/.siltpoke/bin/statusline.sh`, and how the resulting
 * `statusLine.command` string is spelled.
 *
 * Defect [10] (install audit 2026-09-16 §11.1 / §17.1): the plugin install path
 * wrote `sh <shim>` unconditionally. Windows has no bare `sh`, so the statusline
 * command could never start and the pet never appeared — with no error surface,
 * because a statusLine command that fails to spawn just renders nothing. Measured
 * on a real Windows box: hand-editing the command to Git Bash's `bash.exe` made
 * the pet render immediately.
 *
 * The shim itself stays a POSIX `sh` script. This module only decides what to
 * exec it WITH.
 */

/** Resolve a binary to its absolute path, or null when it is not on PATH. */
export type WhichFn = (bin: string) => string | null;

export interface StatuslineInterpreterDeps {
  /** Defaults to `process.platform`. */
  platform?: NodeJS.Platform;
  /** Defaults to `Bun.which`. */
  which?: WhichFn;
  /** Defaults to `existsSync`. */
  exists?: (path: string) => boolean;
  /** Defaults to `process.env` — read for `LOCALAPPDATA` (per-user Git installs). */
  env?: Record<string, string | undefined>;
}

export interface StatuslineCommand {
  /** The full `statusLine.command` string to write into settings.json. */
  command: string;
  /** The interpreter half alone, unquoted — what doctor checks for. */
  interpreter: string;
  /** True when the interpreter was confirmed to exist. */
  resolved: boolean;
  /** Why it could not be confirmed. Null when `resolved`. */
  reason: string | null;
}

/**
 * Where a system-wide Git for Windows puts `bash.exe`, most-likely first.
 * The per-user (non-elevated) installer does NOT land here — it lands under
 * `%LOCALAPPDATA%`, which `gitBashCandidates` appends from the environment.
 */
export const GIT_BASH_CANDIDATES: readonly string[] = [
  "C:\\Program Files\\Git\\bin\\bash.exe",
  "C:\\Program Files (x86)\\Git\\bin\\bash.exe",
  "C:\\Program Files\\Git\\usr\\bin\\bash.exe",
];

/** `%LOCALAPPDATA%\\Programs\\Git\\bin\\bash.exe` — where a non-elevated install lands. */
export function localAppDataGitBash(
  env: Record<string, string | undefined>,
): string | null {
  const base = env.LOCALAPPDATA;
  if (typeof base !== "string" || base.trim().length === 0) return null;
  // Built by concatenation, not path.join: this is a Windows path and the code
  // must produce the same string when a test runs it on macOS.
  return `${base.replace(/[\\/]+$/, "")}\\Programs\\Git\\bin\\bash.exe`;
}

/** Every place to look on disk, most-likely first. Internal — the exported
 * pieces are GIT_BASH_CANDIDATES (which tests assert ordering against) and
 * localAppDataGitBash (which tests drive directly). */
function gitBashCandidates(
  env: Record<string, string | undefined>,
): readonly string[] {
  const perUser = localAppDataGitBash(env);
  return perUser === null ? GIT_BASH_CANDIDATES : [...GIT_BASH_CANDIDATES, perUser];
}

function defaultWhich(bin: string): string | null {
  try {
    return Bun.which(bin);
  } catch {
    return null;
  }
}

/**
 * `where bash` on a stock Windows 10/11 finds `C:\Windows\System32\bash.exe`
 * — the WSL launcher, not a shell that can read `C:\Users\…`. Running the shim
 * through it resolves the path against the WSL root and silently finds nothing,
 * which looks exactly like the bug we are fixing.
 */
function isWslLauncher(path: string): boolean {
  return /[\\/]system32[\\/]bash\.exe$/i.test(path);
}

/** Git Bash takes forward slashes; a backslash path reaches it as escapes. */
function toPosixish(path: string): string {
  return path.replace(/\\/g, "/");
}

/**
 * Characters that are safe to hand a shell bare. An ALLOW-list, not a list of
 * things to escape: the first cut of this tested for a space and nothing else,
 * which left `$` and a backtick to be expanded by the invoking shell — the same
 * silent wrong-path-then-nothing-renders failure this whole module exists to
 * fix, just with a narrower trigger. An allow-list cannot be short by omission.
 *
 * `:` and `/` are in the set so an ordinary `C:/Users/x/...` or `/Users/x/...`
 * still goes through unquoted and no existing settings.json is churned.
 */
const SHELL_SAFE = /^[A-Za-z0-9_@%+=:,./-]*$/;

/**
 * Quote only when needed — an always-quoted `sh` would churn every
 * settings.json. When it IS needed, escape for POSIX double-quote semantics;
 * the shim is a POSIX script and on Windows it runs under Git Bash, so that is
 * the grammar at both ends. (Windows paths are forward-slashed before they get
 * here, so no backslash survives to be re-interpreted.)
 */
function quoteIfNeeded(token: string): string {
  if (SHELL_SAFE.test(token)) return token;
  return `"${token.replace(/(["\\$`])/g, "\\$1")}"`;
}

/**
 * Build the `statusLine.command` for this platform.
 *
 * POSIX keeps the historical bare `sh <shim>`. Windows resolves Git Bash: PATH
 * first (the user's own install wins), then the known install locations. When
 * nothing resolves we still emit a Git Bash command rather than `sh` — a wrong
 * path the user can see and correct beats a command that was never runnable on
 * their OS — and say so through `reason`, which the caller surfaces as a warning
 * and `/siltpoke-doctor` re-checks later.
 */
export function buildStatuslineCommand(
  shimPath: string,
  deps: StatuslineInterpreterDeps = {},
): StatuslineCommand {
  const platform = deps.platform ?? process.platform;
  const which = deps.which ?? defaultWhich;
  const exists = deps.exists ?? existsSync;

  if (platform !== "win32") {
    const found = which("sh");
    return {
      // The shim path is quoted when it needs it. A home directory with a space
      // in it would otherwise be split into two arguments by the spawning shell,
      // which is the same silent nothing-renders failure as defect [10] itself.
      command: `sh ${quoteIfNeeded(shimPath)}`,
      interpreter: "sh",
      resolved: found !== null,
      reason:
        found !== null
          ? null
          : "sh was not found on PATH at install time; the statusline will not render until it is",
    };
  }

  const env = deps.env ?? process.env;
  const onPath = which("bash");
  const fromPath = onPath !== null && !isWslLauncher(onPath) ? onPath : null;
  const fromDisk =
    fromPath === null ? (gitBashCandidates(env).find(exists) ?? null) : null;
  const found = fromPath ?? fromDisk;
  const interpreter = toPosixish(found ?? GIT_BASH_CANDIDATES[0]!);
  const shim = toPosixish(shimPath);

  return {
    // BOTH halves are quoted when they need it. Windows home directories very
    // commonly contain a space (the setup wizard suggests the account's full
    // name), so quoting only the interpreter would hand bash the first word of
    // the path as its script and render nothing — the Windows-statusline defect
    // reintroduced by its own fix.
    command: `${quoteIfNeeded(interpreter)} ${quoteIfNeeded(shim)}`,
    interpreter,
    resolved: found !== null,
    reason:
      found !== null
        ? null
        : "no Git Bash was found on PATH or in its usual install locations; " +
          "install Git for Windows, or point statusLine.command at your own bash.exe",
  };
}

/**
 * Read the interpreter back out of a `statusLine.command` string — the first
 * token, honouring one level of quoting so a path with spaces survives.
 * Returns null for an empty command or an unterminated quote (neither of which
 * is an interpreter we can check).
 */
export function splitInterpreter(command: string): string | null {
  const s = command.trimStart();
  if (s.length === 0) return null;
  const first = s[0];
  if (first === '"' || first === "'") {
    const end = s.indexOf(first, 1);
    if (end === -1) return null;
    const token = s.slice(1, end);
    return token.length > 0 ? token : null;
  }
  const token = s.split(/\s+/)[0] ?? "";
  return token.length > 0 ? token : null;
}
