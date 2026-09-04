// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
// Copyright (c) 2026 Jiaqi Duan
import { readFileSync, statSync } from "node:fs";
import { chmod, mkdir, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

/**
 * The statusLine command and the daemon autostart unit can only hold an absolute
 * path, but the plugin cache directory carries the version in its name — so any
 * path written into them dies at the next plugin upgrade. Both point at THIS
 * shim instead; it reads ~/.siltpoke/plugin-root, which the plugin's SessionStart
 * hook refreshes every session.
 *
 * Fail-soft by construction: pointer missing, or pointing at an uninstalled
 * plugin ⇒ print nothing, exit 0. A blank statusline, never an error.
 */
export function renderStatuslineShim(): string {
  return `#!/bin/sh
set -u
# Guarded with :- (not bare \${HOME}) — under set -u a bare reference to an
# unset HOME is a hard "unbound variable" crash straight to the session's
# statusline. Same bug class session-start.sh already guards against.
HOME="\${HOME:-}"
ROOT_FILE="\${HOME}/.siltpoke/plugin-root"
[ -f "$ROOT_FILE" ] || exit 0
ROOT="$(cat "$ROOT_FILE" 2>/dev/null)" || exit 0
CARD="\${ROOT}/dist/siltpoke-card.js"
[ -f "$CARD" ] || exit 0
command -v bun > /dev/null 2>&1 || exit 0
exec bun "$CARD" "$@" 2>/dev/null
`;
}

/**
 * Same versioned-path problem, second surface: the launchd plist / systemd unit
 * stores ONE absolute path to the daemon entry, and that path is inside the
 * versioned plugin cache dir. Hardcode it and the daemon silently stops coming
 * back after the first `/plugin update`. So the unit execs THIS shim, which
 * resolves the daemon bundle through ~/.siltpoke/plugin-root at every start.
 *
 * Unresolvable (pointer missing, plugin mid-upgrade, bun gone) ⇒ sleep, do NOT
 * exit immediately: both unit types are keep-alive (launchd KeepAlive / systemd
 * Restart=always), so an instant exit turns into a respawn storm every
 * ThrottleInterval seconds, forever. Idling instead makes the failure cheap and
 * self-healing — the next session's SessionStart hook rewrites the pointer and
 * the next restart picks it up.
 */
export function renderDaemonShim(): string {
  return `#!/bin/sh
set -u
HOME="\${HOME:-}"
ROOT_FILE="\${HOME}/.siltpoke/plugin-root"
DAEMON=""
if [ -f "$ROOT_FILE" ]; then
  ROOT="$(cat "$ROOT_FILE" 2>/dev/null || true)"
  if [ -n "$ROOT" ] && [ -f "\${ROOT}/dist/siltpoke-daemon.js" ]; then
    DAEMON="\${ROOT}/dist/siltpoke-daemon.js"
  fi
fi
if [ -n "$DAEMON" ] && command -v bun > /dev/null 2>&1; then
  exec bun "$DAEMON" "$@"
fi
# Cannot resolve the daemon right now. Idle rather than exit — a keep-alive unit
# would otherwise respawn us every few seconds forever.
sleep 300
exit 0
`;
}

/** Where the daemon autostart unit's exec target lives. Stable across upgrades. */
export function daemonShimPath(home: string): string {
  return join(home, ".siltpoke", "bin", "daemon.sh");
}

/** The pointer file the PLUGIN's hooks/session-start.sh writes. */
export function pluginRootPointerPath(home: string): string {
  return join(home, ".siltpoke", "plugin-root");
}

/**
 * The plugin bundle the pointer currently names — or null when there isn't one.
 *
 * Both shims are USELESS without this pointer: they resolve the daemon /
 * statusline bundle through it, and only the plugin's SessionStart hook ever
 * writes it. A repo-checkout user has no pointer, so a unit routed through the
 * daemon shim could never resolve anything — it would idle and be respawned
 * forever while reporting "installed" (the shim's own file existing proves
 * nothing; a prior `configure --daemon` leaves it behind).
 *
 * Hence: the pointer RESOLVING — present, non-empty, and naming a real
 * directory — is the only honest test for "this is a plugin install".
 */
export function resolvePluginRoot(home: string): string | null {
  let root: string;
  try {
    root = readFileSync(pluginRootPointerPath(home), "utf8").trim();
  } catch {
    return null; // no pointer file at all ⇒ not a plugin install
  }
  if (root.length === 0) return null;
  try {
    return statSync(root).isDirectory() ? root : null;
  } catch {
    return null; // pointer names something that isn't there (uninstalled plugin)
  }
}

/** Where the statusLine command's exec target lives. Stable across upgrades. */
export function statuslineShimPath(home: string): string {
  return join(home, ".siltpoke", "bin", "statusline.sh");
}

/**
 * Tmp-file + rename (mirrors hooks/session-start.sh's write to plugin-root):
 * these paths get rewritten by every plugin install/upgrade while remaining live
 * as an exec target, so a write interrupted mid-flight must never leave a
 * truncated script for a concurrently-firing render (or daemon restart) to run.
 *
 * mode: 0o755 on create is umask-masked; chmod after is not — belt and
 * suspenders so the shim is executable regardless of the caller's umask.
 */
async function writeExecutable(path: string, body: string): Promise<string> {
  await mkdir(dirname(path), { recursive: true });
  const tmpPath = `${path}.tmp`;
  await writeFile(tmpPath, body, { encoding: "utf8", mode: 0o755 });
  await chmod(tmpPath, 0o755);
  await rename(tmpPath, path);
  return path;
}

export async function writeShim(home: string): Promise<string> {
  return writeExecutable(statuslineShimPath(home), renderStatuslineShim());
}

export async function writeDaemonShim(home: string): Promise<string> {
  return writeExecutable(daemonShimPath(home), renderDaemonShim());
}
