// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
// Copyright (c) 2026 Jiaqi Duan
/**
 * `/siltpoke-menubar <install|status|remove>` CLI (track #7 T7).
 *
 * Thin wrapper around the consent-driven `runMenubarSetup` (track #6):
 *   - `install` — runs the same SwiftBar setup flow the wizard offers
 *     (zero silent side-effects; every install/write step asks first).
 *   - `status`  — reports whether the SwiftBar plugin shim exists.
 *   - `remove`  — deletes the shim if present. Running `remove` explicitly
 *     IS the consent (same one-shot-command convention as
 *     `/siltpoke-mute` / `/siltpoke-unmute` — no extra y/n prompt).
 *
 * Usage:
 *   bun src/cli/menubar.ts install
 *   bun src/cli/menubar.ts status
 *   bun src/cli/menubar.ts remove
 */
import { existsSync as realExistsSync, unlinkSync } from "node:fs";
import {
  probeExec,
  resolveObeyedShimPath,
  runMenubarSetup,
  strandedShimPath,
  SWIFTBAR_APP_PATH,
  SWIFTBAR_DOWNLOAD_URL,
  type MenubarSetupDeps,
  type MenubarSetupResult,
  type ProbeExec,
} from "../installer/menubar-setup";
import { realWizardIO, type WizardIO } from "../installer/wizard";

export interface MenubarCliDeps {
  home?: string;
  platform?: string;
  existsSync?: (p: string) => boolean;
  write?: (s: string) => void;
  rm?: (p: string) => void;
  /** Injectable for tests — defaults to real stdin/stdout (track #7 T7). */
  io?: WizardIO;
  exec?: MenubarSetupDeps["exec"];
  writeFile?: MenubarSetupDeps["writeFile"];
  /** Non-interactive install (no askYesNo) — set by the `/siltpoke-menubar` slash command (no TTY). */
  nonInteractive?: boolean;
  /** Renderer path the SwiftBar shim invokes — plugin installs pass the bundled `dist/siltpoke-card.js`. */
  rendererPath?: string;
  /** Injectable dispatch — defaults to the real `runMenubarSetup` (track #7 T7). */
  runMenubarSetupFn?: (deps: MenubarSetupDeps) => Promise<MenubarSetupResult>;
}

/**
 * The shim path SwiftBar obeys, asked without writing anything.
 *
 * Delegates to the installer's own resolver rather than rebuilding a path
 * here — a hand-built copy is exactly what made `install` and `status`
 * disagree for anyone whose SwiftBar points at a custom plugin folder.
 */
function obeyedShimPath(deps: MenubarCliDeps): string {
  const home = deps.home ?? process.env.HOME ?? "";
  return resolveObeyedShimPath(deps.exec ?? probeExec, home);
}

/**
 * `pgrep -x` exits 0 when a process matches and 1 when none does. It also
 * exits 2 on a usage error and 3 on a fatal one, and those are NOT "the app
 * is closed" — collapsing them into `false` is how `status` would end up
 * telling someone to start an app that is already running. Anything other
 * than a clean yes/no is reported as unknown.
 */
function swiftBarRunState(exec: ProbeExec): "running" | "stopped" | "unknown" {
  const { status } = exec("pgrep", ["-x", "SwiftBar"]);
  if (status === 0) {
    return "running";
  }
  return status === 1 ? "stopped" : "unknown";
}

const USAGE = "usage: siltpoke-menubar <install|status|remove>\n";

async function handleInstall(deps: MenubarCliDeps, write: (s: string) => void): Promise<number> {
  const runSetup = deps.runMenubarSetupFn ?? runMenubarSetup;
  const result = await runSetup({
    io: deps.io ?? realWizardIO(),
    platform: deps.platform,
    home: deps.home,
    exec: deps.exec,
    writeFile: deps.writeFile,
    existsSync: deps.existsSync,
    nonInteractive: deps.nonInteractive,
    rendererPath: deps.rendererPath,
  });
  if (result.reason === "not-darwin") {
    write("siltpoke-menubar: the menu-bar pet is macOS-only.\n");
    return 0;
  }
  if (result.installed) {
    write("✓ menu-bar pet installed.\n");
    return 0;
  }
  // `no-swiftbar` already printed the download link via io.write; keep the
  // trailing line short and non-alarming for every not-installed reason.
  write(`menu-bar pet not installed (${result.reason}).\n`);
  return 0;
}

/**
 * Answer "is the pet showing", not "does a file exist".
 *
 * The shim being on disk is a necessary condition, never a sufficient one:
 * SwiftBar is what draws the menu bar, so with SwiftBar absent or merely not
 * running, an installed shim shows the user nothing. Reporting a bare
 * "installed" in that state is true and useless — it hands someone staring at
 * an empty menu bar no next action. Each branch below names the one thing
 * that is missing and what to do about it.
 */
function handleStatus(deps: MenubarCliDeps, write: (s: string) => void): number {
  const platform = deps.platform ?? process.platform;
  if (platform !== "darwin") {
    write("siltpoke-menubar: the menu-bar pet is macOS-only.\n");
    return 0;
  }
  const existsSync = deps.existsSync ?? realExistsSync;
  const exec = deps.exec ?? probeExec;
  const home = deps.home ?? process.env.HOME ?? "";

  // Resolved ONCE: each call shells out to `defaults read`, and this function
  // needs the answer in up to three places.
  const obeyed = obeyedShimPath(deps);
  if (!existsSync(obeyed)) {
    const stranded = strandedShimPath(obeyed, home, existsSync);
    if (stranded) {
      // Installed, in a folder SwiftBar was later pointed away from. Saying
      // "not installed" here sends someone to re-run an install that already
      // succeeded; saying "installed" would repeat the bug this file fixes.
      write(
        `menu-bar pet: installed at ${stranded}, but SwiftBar is now reading ${obeyed} — the menu bar stays empty. Re-run install to put it where SwiftBar looks.\n`,
      );
      return 0;
    }
    write("menu-bar pet: not installed\n");
    return 0;
  }

  const runState = swiftBarRunState(exec);
  if (runState === "running") {
    write("menu-bar pet: installed, SwiftBar running\n");
    return 0;
  }
  if (runState === "unknown") {
    write(
      "menu-bar pet: installed, but I could not tell whether SwiftBar is running — check your menu bar.\n",
    );
    return 0;
  }
  if (!existsSync(SWIFTBAR_APP_PATH)) {
    // Do NOT suggest starting an app that isn't there. The path is named
    // rather than asserted absent, because SwiftBar can be installed outside
    // /Applications and this check only ever looks there.
    write(
      `menu-bar pet: installed, but I cannot find SwiftBar at ${SWIFTBAR_APP_PATH} — nothing can draw the pet. If you don't have it:\n  ${SWIFTBAR_DOWNLOAD_URL}\n`,
    );
    return 0;
  }
  write(
    "menu-bar pet: installed, but SwiftBar is not running — the menu bar stays empty until it starts. Start it with: open -a SwiftBar\n",
  );
  return 0;
}

function handleRemove(deps: MenubarCliDeps, write: (s: string) => void): number {
  // Same platform guard `status` has: off macOS there is no SwiftBar pref to
  // read, and `defaults` is not a command, so probing for it is pure waste.
  const platform = deps.platform ?? process.platform;
  if (platform !== "darwin") {
    write("siltpoke-menubar: the menu-bar pet is macOS-only.\n");
    return 0;
  }
  const existsSync = deps.existsSync ?? realExistsSync;
  const exec = deps.exec ?? probeExec;
  const home = deps.home ?? process.env.HOME ?? "";
  const rm = deps.rm ?? ((p: string) => unlinkSync(p));

  // Remove whichever copy is actually on disk — the one SwiftBar obeys first,
  // and otherwise a copy stranded in the default folder. Deleting the obeyed
  // path unconditionally would report success having removed nothing.
  const obeyed = obeyedShimPath(deps);
  const path = existsSync(obeyed) ? obeyed : strandedShimPath(obeyed, home, existsSync);
  if (!path) {
    write("menu-bar pet: not installed (nothing to remove)\n");
    return 0;
  }
  rm(path);
  write("✓ menu-bar pet removed.\n");
  return 0;
}

export async function runMenubarCli(argv: string[], deps: MenubarCliDeps): Promise<number> {
  const write = deps.write ?? ((s: string) => process.stdout.write(s));
  const subcommand = argv[0];

  switch (subcommand) {
    case "install":
      return handleInstall(deps, write);
    case "status":
      return handleStatus(deps, write);
    case "remove":
      return handleRemove(deps, write);
    default:
      write(USAGE);
      return 1;
  }
}

if (import.meta.main) {
  process.exit(await runMenubarCli(process.argv.slice(2), {}));
}
