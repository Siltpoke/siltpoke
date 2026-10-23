// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
// Copyright (c) 2026 Jiaqi Duan
/**
 * Defect [53]: someone who already has a pet and later installs the agy plugin
 * never got the pet in agy's statusline. The only caller of `wireAgyStatusline`
 * is `configure`, and setup does not run configure when config.json exists.
 *
 * The Stop hook (hooks/agy-stop.sh) is the one place that runs in agy on every
 * turn, so it calls this once config.json exists. Safety rules are
 * `wireAgyStatusline`'s own (empty slot or already ours; never the user's).
 *
 * Once-ish: the outcome is remembered in a marker, so later turns never start
 * bun at all (the shell tests the marker). Marked: wired, or someone else's
 * statusline (not nagged, not retried), or a symlinked settings.json. NOT
 * marked: an unreadable settings.json or a write that did not stick, so a
 * fixed file still gets the pet. A pet the user later deletes is not put back.
 */

import { join } from "node:path";
import { wireAgyStatusline } from "../installer/agy-statusline";
import { resolveAntigravityHome, siltpokeRoot } from "../installer/paths";
import { atomicWrite } from "../utils/atomic-write";
import { isSymlink } from "./agy-setup-hint";

export const WIRED_MARKER = ".agy-pet-wired";

function ensurePetWired(env: NodeJS.ProcessEnv, pluginRoot: string): void {
  if (!pluginRoot) return;
  const marker = join(siltpokeRoot(env), WIRED_MARKER);
  const done = (): void => {
    try {
      atomicWrite(marker, "");
    } catch {
      // Harmless: the next turn re-checks, and finds nothing to write.
    }
  };
  const linked = isSymlink(join(resolveAntigravityHome(env), "settings.json"));
  if (linked) {
    done();
    return;
  }
  // "no-agy" (no card under pluginRoot) is not final either: retry, don't mark.
  const outcome = wireAgyStatusline(env, process.execPath, pluginRoot);
  if (outcome !== "unwritable" && outcome !== "no-agy") done();
}

/** `bun dist/agy-stop.js --wire-pet <pluginRoot>`, called by hooks/agy-stop.sh. */
export function runWirePetCli(argv: string[], env: NodeJS.ProcessEnv): void {
  const at = argv.indexOf("--wire-pet");
  try {
    ensurePetWired(env, at >= 0 ? (argv[at + 1] ?? "") : "");
  } catch {
    // Silent by contract: nothing from a hook may reach the agy session.
  }
}
