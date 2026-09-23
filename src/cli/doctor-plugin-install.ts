// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
// Copyright (c) 2026 Jiaqi Duan
import { realpathSync } from "node:fs";
import { homedir } from "node:os";
import { resolvePluginRoot } from "../installer/shim";
import { defaultRepoRoot, type DoctorOptions } from "./doctor";

/**
 * Is this a plugin install?
 *
 * Defect [24]: this used to be `Boolean(process.env.CLAUDE_PLUGIN_ROOT)` alone.
 * The host exports that variable to hooks and commands, but NOT to a doctor the
 * user starts themselves — so running `/siltpoke-doctor` by hand on a perfectly
 * healthy plugin install read as a from-source checkout, and two rows went red
 * about files that were never supposed to exist ("slash command symlinks
 * intact … repo layout is broken", and hooks.Stop[] being empty in
 * settings.json — the very report that opened defect [20]).
 *
 * The durable evidence is ~/.siltpoke/plugin-root RESOLVING: present,
 * non-empty, and naming a real directory. Only the plugin's SessionStart hook
 * writes it, and it survives the command that reads it having no env at all.
 * The env var stays as a second opinion for the very first session, before that
 * hook has ever run.
 */
export function isPluginInstall(opts: DoctorOptions): boolean {
  if (opts.pluginInstall !== undefined) return opts.pluginInstall;

  // The pointer must name THIS install, not merely "a plugin exists somewhere
  // on this machine". ~/.siltpoke/plugin-root is written once and persists, so
  // a developer with the plugin installed at B who runs doctor by hand inside a
  // from-source checkout at A would otherwise be told "plugin install — nothing
  // to verify" and the symlink check would skip silently. That is defect [24]'s
  // own failure class (a green row about a thing never looked at) wearing the
  // opposite mask, and it was caught in review of the [24] fix.
  const pointed = resolvePluginRoot(opts.home ?? homedir());
  if (pointed !== null) {
    const here = opts.repoRoot ?? defaultRepoRoot();
    try {
      if (realpathSync(pointed) === realpathSync(here)) return true;
    } catch {
      // Either path vanished mid-check — fall through to the env var.
    }
  }
  return Boolean(process.env.CLAUDE_PLUGIN_ROOT);
}
