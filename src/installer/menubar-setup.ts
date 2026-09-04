// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
// Copyright (c) 2026 Jiaqi Duan

import { spawnSync } from "node:child_process";
import { existsSync as realExistsSync, writeFileSync } from "node:fs";
import { basename, join, normalize } from "node:path";
import { installSwiftbarAutostart } from "./swiftbar-autostart";
import type { WizardIO } from "./wizard";
import { askYesNo } from "./wizard";

const SWIFTBAR_APP_PATH = "/Applications/SwiftBar.app";
const SWIFTBAR_DOWNLOAD_URL = "https://github.com/swiftbar/SwiftBar/releases/latest";
const SHIM_NAME = "siltpoke.1m.sh";
const SWIFTBAR_DEFAULTS_DOMAIN = "com.ameba.SwiftBar";
const SWIFTBAR_PLUGIN_DIR_KEY = "PluginDirectory";

export interface MenubarSetupDeps {
  io: WizardIO;
  platform?: string;
  home?: string;
  exec?: (cmd: string, args: string[]) => { status: number; stdout: string };
  writeFile?: (path: string, contents: string) => void;
  existsSync?: (path: string) => boolean;
  /**
   * Skip the interactive "Install SwiftBar with Homebrew?" prompt. Used by the
   * `/siltpoke-menubar` slash command, which has no TTY — running the command
   * IS the consent. When SwiftBar isn't already installed, a non-interactive
   * run does NOT auto-brew (too invasive without a prompt); it prints the
   * download link and returns `no-swiftbar` instead.
   */
  nonInteractive?: boolean;
  /**
   * Absolute path the SwiftBar shim should invoke to render the pet. Defaults
   * to the source `src/face/wrapper.ts` (from-source installs). A plugin
   * install has no `src/`, so `/siltpoke-menubar` passes the bundled
   * `${CLAUDE_PLUGIN_ROOT}/dist/siltpoke-card.js` here.
   */
  rendererPath?: string;
}

export type MenubarSetupReason =
  | "not-darwin"
  | "declined"
  | "no-brew"
  | "no-swiftbar"
  | "ok";

export interface MenubarSetupResult {
  installed: boolean;
  wroteShim: boolean;
  reason?: MenubarSetupReason;
  autostart?: boolean;
}

function defaultExec(cmd: string, args: string[]): { status: number; stdout: string } {
  const r = spawnSync(cmd, args, { encoding: "utf8" });
  return { status: r.status ?? 1, stdout: r.stdout ?? "" };
}

/**
 * Resolve the card renderer the SwiftBar shim will exec, from the directory
 * THIS module is running from.
 *
 * Seventh site of the ships-two-ways family (see `resolveDaemonEntry` in
 * daemon-path.ts for the canonical statement of the rule). menubar-setup.ts is
 * reachable from plugin-cli.ts's `menubar` verb, which is bundled into
 * dist/siltpoke-cli.js — where the previous `join(import.meta.dir, "..",
 * "face", "wrapper.ts")` produced `<parent-of-dist>/face/wrapper.ts`, a path
 * that exists in no plugin cache.
 *
 * This one is the DEGRADED-build fallback rather than a mainline path: the
 * caller passes `rendererPath` explicitly whenever `resolveCardPath()` finds
 * dist/siltpoke-card.js, which a well-formed build always emits. It is fixed
 * anyway because "the primary resolver normally works" is the same reasoning
 * that left the other six unfixed — and the shim it writes reports success
 * while pointing nowhere.
 *
 * Exported for unit test; the parameter defaults to this module's own dir.
 */
export function resolveWrapperPath(hereDir: string = import.meta.dir): string {
  if (basename(hereDir) === "dist") {
    return normalize(join(hereDir, "siltpoke-card.js"));
  }
  return normalize(join(hereDir, "..", "face", "wrapper.ts"));
}

function resolveBunPath(exec: (cmd: string, args: string[]) => { status: number; stdout: string }): string {
  const which = exec("which", ["bun"]);
  const trimmed = which.stdout.trim();
  return trimmed || "bun";
}

function renderShim(bunPath: string, wrapperPath: string): string {
  return `#!/bin/bash\nexec "${bunPath}" "${wrapperPath}" --menubar\n`;
}

/**
 * Resolve the plugin directory SwiftBar will actually read.
 *
 * SwiftBar stores its plugin folder in the `com.ameba.SwiftBar PluginDirectory`
 * preference, chosen by the user on first launch — so we must NOT assume the
 * default path. If the pref is already set (existing SwiftBar user), write the
 * shim into THAT folder. If unset (fresh install), point SwiftBar at our
 * default folder via `defaults write` BEFORE launching, so it comes up reading
 * our plugin instead of prompting the user with a folder picker.
 */
function resolvePluginDir(
  exec: (cmd: string, args: string[]) => { status: number; stdout: string },
  home: string,
): string {
  const read = exec("defaults", ["read", SWIFTBAR_DEFAULTS_DOMAIN, SWIFTBAR_PLUGIN_DIR_KEY]);
  const existing = read.status === 0 ? read.stdout.trim() : "";
  if (existing) {
    return existing.startsWith("~") ? join(home, existing.slice(1)) : existing;
  }
  const fallback = join(home, "Library", "Application Support", "SwiftBar", "plugins");
  exec("defaults", ["write", SWIFTBAR_DEFAULTS_DOMAIN, SWIFTBAR_PLUGIN_DIR_KEY, fallback]);
  return fallback;
}

/**
 * Consent-driven SwiftBar installer (macOS only). ZERO silent side-effects:
 * every disk write / package install is explicitly consented (default N).
 * Declining writes/installs nothing.
 */
export async function runMenubarSetup(deps: MenubarSetupDeps): Promise<MenubarSetupResult> {
  const platform = deps.platform ?? process.platform;
  if (platform !== "darwin") {
    return { installed: false, wroteShim: false, reason: "not-darwin" };
  }

  const { io } = deps;
  const home = deps.home ?? process.env.HOME ?? "";
  const exec = deps.exec ?? defaultExec;
  const writeFile = deps.writeFile ?? ((p: string, c: string) => writeFileSync(p, c));
  const existsSync = deps.existsSync ?? realExistsSync;

  const swiftBarAppPresent = existsSync(SWIFTBAR_APP_PATH);
  const swiftBarCaskInstalled =
    swiftBarAppPresent || exec("brew", ["list", "--cask", "swiftbar"]).status === 0;

  if (!swiftBarCaskInstalled) {
    if (deps.nonInteractive) {
      // No TTY (slash command). Don't auto-brew without a prompt — just point
      // the user at the download and bail. They re-run once SwiftBar is there.
      io.write(
        `SwiftBar isn't installed — the menu-bar pet needs it. Install it, then re-run:\n  ${SWIFTBAR_DOWNLOAD_URL}\n`,
      );
      return { installed: false, wroteShim: false, reason: "no-swiftbar" };
    }
    const consented = await askYesNo(io, "Install SwiftBar with Homebrew?", { default: "no" });
    if (!consented) {
      return { installed: false, wroteShim: false, reason: "declined" };
    }
    const brewOnPath = exec("which", ["brew"]).status === 0;
    if (!brewOnPath) {
      io.write(
        `Homebrew not found on PATH. Install SwiftBar manually: ${SWIFTBAR_DOWNLOAD_URL}\n`,
      );
      return { installed: false, wroteShim: false, reason: "no-brew" };
    }
    exec("brew", ["install", "--cask", "swiftbar"]);
  }

  const pluginDir = resolvePluginDir(exec, home);
  exec("mkdir", ["-p", pluginDir]);

  const shimPath = join(pluginDir, SHIM_NAME);
  const bunPath = resolveBunPath(exec);
  const wrapperPath = deps.rendererPath ?? resolveWrapperPath();
  writeFile(shimPath, renderShim(bunPath, wrapperPath));
  exec("chmod", ["+x", shimPath]);

  // Restart SwiftBar so a already-running instance re-reads the (possibly
  // just-set) plugin directory + picks up the new shim. killall is a harmless
  // no-op when SwiftBar isn't running (fresh install → open launches it fresh).
  exec("killall", ["SwiftBar"]);
  exec("open", ["-a", "SwiftBar"]);

  // Register the login-item so SwiftBar returns after a reboot (AC20/AC21).
  // Guard is inside installSwiftbarAutostart (SwiftBar.app presence).
  const auto = installSwiftbarAutostart({
    platform,
    exec: (cmd, argv) => ({ status: exec(cmd, argv).status }),
    existsSync,
    home,
    writeFile,
    mkdirSync: (dir) => {
      exec("mkdir", ["-p", dir]);
    },
  });

  return { installed: true, wroteShim: true, reason: "ok", autostart: auto.installed };
}
