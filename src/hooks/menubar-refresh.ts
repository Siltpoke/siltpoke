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
import { existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";

export interface MenubarSideEffectDeps {
  /** Defaults to `process.platform`. Test seam — never shell out in tests. */
  platform?: string;
  /** Defaults to a real `spawnSync` wrapped in try/catch. Test seam. */
  exec?: (cmd: string, args: string[]) => void;
  /**
   * Defaults to a real `existsSync` check of the SwiftBar plugin shim path
   * (`~/Library/Application Support/SwiftBar/plugins/siltpoke.1m.sh`, using
   * `process.env.HOME`). Test seam. Only `notifyReview` gates on this —
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

function defaultShimExists(): boolean {
  const home = process.env.HOME ?? "";
  const shimPath = join(
    home,
    "Library",
    "Application Support",
    "SwiftBar",
    "plugins",
    "siltpoke.1m.sh",
  );
  return existsSync(shimPath);
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
