// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
// Copyright (c) 2026 Jiaqi Duan
/**
 * Menu-bar-pet T5 — guarded, bounded side effects invoked from the Stop
 * hook's fired path (handle-stop.ts): tell SwiftBar to re-render instantly,
 * and pop a gated desktop notification. Both are macOS-only (SwiftBar +
 * osascript notifications have no equivalent elsewhere) and both MUST NEVER
 * crash or stall the hook — a side-effect failure (or a hung `open`/
 * `osascript` process) here must never take the pet review down with it,
 * same discipline as appendJsonLine's swallow-and-continue.
 */
import { existsSync as realExistsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { anyInstalledShimPath, probeExec } from "../installer/menubar-setup";

export interface MenubarSideEffectDeps {
  /** Defaults to `process.platform`. Test seam — never shell out in tests. */
  platform?: string;
  /** Defaults to a real `spawnSync` wrapped in try/catch. Test seam. */
  exec?: (cmd: string, args: string[]) => void;
  /**
   * Defaults to `defaultShimExists` — the SwiftBar plugin shim, looked up in
   * the default folder first and then in SwiftBar's configured
   * `PluginDirectory`. Test seam. Only `notifyReview` gates on this —
   * notifications should only fire for users who actually installed the
   * menu-bar plugin.
   */
  shimExists?: () => boolean;
}

const NOTIFICATION_COMMENT_MAX_LEN = 120;
// Bound how long a hung `open`/`osascript` child process can block the Stop
// hook. spawnSync with a timeout sends SIGTERM to the child on expiry;
// the try/catch below still swallows whatever spawnSync reports.
const EXEC_TIMEOUT_MS = 3000;

/**
 * Did this user opt into the menu-bar pet — in EITHER folder?
 *
 * Previously this rebuilt the DEFAULT plugin path by hand while `install`
 * wrote into SwiftBar's configured folder, so anyone who had pointed SwiftBar
 * elsewhere installed the pet and then silently received no notifications.
 *
 * Consent is the only question here, deliberately NOT "which copy does
 * SwiftBar render" — this runs on the Stop hook's fired path, and the cheap
 * check is the right one for a gate. Cost, stated plainly rather than implied:
 * zero subprocesses for a pet installed in the default folder, and one bounded
 * `defaults read` for everyone else — which includes the majority who never
 * installed it. At 0.00–0.01s per call that is a wasted spawn, not a stall.
 *
 * Non-throwing by construction AND by catch: the review must survive a broken
 * lookup, same swallow-and-continue discipline as every other side effect in
 * this file.
 *
 * Exported for unit test; every parameter defaults to the real thing.
 */
export function defaultShimExists(deps: {
  home?: string;
  existsSync?: (p: string) => boolean;
  exec?: (cmd: string, args: string[]) => { status: number; stdout: string };
} = {}): boolean {
  const home = deps.home ?? process.env.HOME ?? "";
  const existsSync = deps.existsSync ?? realExistsSync;
  const exec = deps.exec ?? probeExec;
  try {
    return anyInstalledShimPath(exec, home, existsSync) !== null;
  } catch {
    return false;
  }
}

function defaultExec(cmd: string, args: string[]): void {
  try {
    spawnSync(cmd, args, { stdio: "ignore", timeout: EXEC_TIMEOUT_MS });
  } catch {
    // Side-effect failures must never crash the hook.
  }
}

/**
 * Sanitize a Brain-generated comment for embedding inside a double-quoted
 * AppleScript string literal: strip the characters that would break out of
 * the quotes (`"` closes the string, `\` starts an escape), collapse any
 * newlines to spaces (a raw newline inside `-e '...'` would prematurely
 * terminate the osascript one-liner), and cap the length so a verbose
 * critique doesn't turn into a wall-of-text toast.
 */
function sanitizeForAppleScript(comment: string): string {
  return comment
    .replace(/["\\]/g, "")
    .replace(/\r?\n/g, " ")
    .slice(0, NOTIFICATION_COMMENT_MAX_LEN);
}

/**
 * Tell SwiftBar to re-render the menu bar immediately rather than waiting for
 * its next poll interval. No-op on non-macOS — SwiftBar is macOS-only.
 *
 * The `-g` flag opens the URL in the background: without it, `open` activates
 * SwiftBar and yanks keyboard focus away from whatever window the user is
 * typing in on every Stop hook — forcing them to re-click their window before
 * they can type again. `-g` keeps focus where it is (the refresh still fires).
 */
export function refreshMenubar(deps: MenubarSideEffectDeps = {}): void {
  const platform = deps.platform ?? process.platform;
  if (platform !== "darwin") return;
  (deps.exec ?? defaultExec)("open", [
    "-g",
    "swiftbar://refreshplugin?name=siltpoke",
  ]);
}

/**
 * Pop a macOS desktop notification for a fired review. Gated by mute state
 * (mute beats notification, same as it beats the bubble write), platform
 * (macOS-only — `osascript display notification` has no cross-platform
 * equivalent here), and the SwiftBar plugin shim actually being installed
 * — a user who never opted into the menu-bar pet shouldn't get surprise
 * desktop notifications (I3).
 */
export function notifyReview(
  comment: string,
  muted: boolean,
  deps: MenubarSideEffectDeps = {},
): void {
  const platform = deps.platform ?? process.platform;
  if (muted || platform !== "darwin") return;
  if (!(deps.shimExists ?? defaultShimExists)()) return;
  const safe = sanitizeForAppleScript(comment);
  (deps.exec ?? defaultExec)("osascript", [
    "-e",
    `display notification "${safe}" with title "Siltpoke"`,
  ]);
}
