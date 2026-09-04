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
import { join } from "node:path";
import {
  runMenubarSetup,
  type MenubarSetupDeps,
  type MenubarSetupResult,
} from "../installer/menubar-setup";
import { realWizardIO, type WizardIO } from "../installer/wizard";

const SHIM_RELATIVE_PATH = ["Library", "Application Support", "SwiftBar", "plugins", "siltpoke.1m.sh"];

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

function shimPath(home: string): string {
  return join(home, ...SHIM_RELATIVE_PATH);
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

function handleStatus(deps: MenubarCliDeps, write: (s: string) => void): number {
  const home = deps.home ?? process.env.HOME ?? "";
  const existsSync = deps.existsSync ?? realExistsSync;
  const installed = existsSync(shimPath(home));
  write(installed ? "menu-bar pet: installed\n" : "menu-bar pet: not installed\n");
  return 0;
}

function handleRemove(deps: MenubarCliDeps, write: (s: string) => void): number {
  const home = deps.home ?? process.env.HOME ?? "";
  const existsSync = deps.existsSync ?? realExistsSync;
  const rm = deps.rm ?? ((p: string) => unlinkSync(p));
  const path = shimPath(home);
  if (!existsSync(path)) {
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
