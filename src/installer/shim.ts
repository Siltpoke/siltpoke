// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
// Copyright (c) 2026 Jiaqi Duan
import { existsSync, readFileSync, statSync } from "node:fs";
import { chmod, mkdir, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

/**
 * The bun lookup both shims use, as ONE string so the two can never drift.
 *
 * Same three steps, same order as hooks/lib/resolve-bun.sh: PATH → the path
 * setup recorded in ~/.siltpoke/bun-path → bun's default install location.
 * Deliberately INLINE rather than sourcing that lib: these shims live in
 * ~/.siltpoke/bin and run at moments when the plugin root may be missing or
 * mid-upgrade, and the first draft — which sourced the lib and only fell back
 * to a PATH lookup — silently ignored the recorded pointer whenever the lib
 * could not be found, i.e. exactly when it was needed most.
 *
 * Two copies of three steps is the cost; tests/installer/bun-resolution-parity
 * .test.ts drives BOTH implementations over the same cases and asserts they
 * agree, which catches drift that sharing the code would only have hidden.
 *
 * Needs $HOME set; leaves $BUN empty when bun is unreachable — each caller
 * decides what to do about that, and they differ: the statusline says so out
 * loud, the daemon shim idles.
 */
const BUN_RESOLVE_SNIPPET = `# >>> siltpoke bun-resolve (sentinels: tests slice this block out and run it)
BUN="$(command -v bun 2>/dev/null || true)"
if [ -z "$BUN" ] && [ -f "\${HOME}/.siltpoke/bun-path" ]; then
  RECORDED="$(cat "\${HOME}/.siltpoke/bun-path" 2>/dev/null || true)"
  [ -n "$RECORDED" ] && [ -x "$RECORDED" ] && BUN="$RECORDED"
fi
[ -n "$BUN" ] || { [ -x "\${HOME}/.bun/bin/bun" ] && BUN="\${HOME}/.bun/bin/bun"; }
# <<< siltpoke bun-resolve`;

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
${BUN_RESOLVE_SNIPPET}
# Defect [21]: this used to be \`command -v bun … || exit 0\`, so a user whose bun
# PATH lives only in ~/.bash_profile got a BLANK statusline with no way to find
# out why — the pet simply never appeared. The statusline is the one surface the
# user looks at every turn, so it is where this gets said out loud (the hook
# guards stay silent by rule). One short line, no newline of its own.
[ -n "$BUN" ] || { printf '%s' "siltpoke: can't find bun (not on PATH) — run /siltpoke-doctor"; exit 0; }
exec "$BUN" "$CARD" "$@" 2>/dev/null
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
${BUN_RESOLVE_SNIPPET}
if [ -n "$DAEMON" ] && [ -n "$BUN" ]; then
  exec "$BUN" "$DAEMON" "$@"
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
/**
 * Monotonic suffix for the tmp names below. pid + timestamp alone is NOT unique:
 * two calls in the same process inside the same millisecond — which is exactly
 * what two shims refreshed in parallel look like — would collide.
 */
let tmpSeq = 0;

async function writeExecutable(path: string, body: string): Promise<string> {
  await mkdir(dirname(path), { recursive: true });
  // Unique tmp name, not a fixed `<path>.tmp`. This used to run once, at setup;
  // defect [25] made it run on every SessionStart, and this machine routinely
  // has two sessions open. With a shared tmp path the interleaving
  // A-writes-tmp / B-writes-tmp / A-renames publishes B's HALF-WRITTEN file as
  // the live shim — the one outcome the tmp+rename dance exists to prevent.
  // Same shape as utils/atomic-write.ts's tmp naming, for the same reason.
  const tmpPath = `${path}.tmp-${process.pid}-${Date.now()}-${++tmpSeq}`;
  try {
    await writeFile(tmpPath, body, { encoding: "utf8", mode: 0o755 });
    await chmod(tmpPath, 0o755);
    await rename(tmpPath, path);
  } catch (err) {
    // Never leave the scratch file behind for the next reader to trip over.
    await rm(tmpPath, { force: true }).catch(() => {});
    throw err;
  }
  return path;
}

/**
 * Bring existing shims back in step with the code that generates them.
 *
 * Defect [25]: `hooks/*.sh` ship with the plugin, so a `claude plugin update`
 * replaces them. The two shims do NOT ship — they are generated text, written
 * only by setup. So every upgrade left `~/.siltpoke/bin/` executing whatever
 * setup wrote, however long ago, and nothing said so. Measured on the
 * maintainer's own machine right after the bun-PATH fix (#804) merged: the
 * statusline shim was two months old and still carried the very line that fix
 * removed. The fix shipped; the machine kept the bug.
 *
 * Two constraints, both deliberate:
 *
 *   1. **Refresh only what already exists.** A user who never opted into the
 *      statusline must not find a shim appearing: `resolveDaemonLauncher` and
 *      the doctor rows change their answer when these files exist, so creating
 *      one speculatively would be a behaviour change dressed as a fix.
 *   2. **Write only on a real difference.** This is called from SessionStart,
 *      i.e. once per session forever; an unconditional write would be pure
 *      churn. Keying on CONTENT rather than a version stamp also self-corrects
 *      a hand-edited shim, and cannot be fooled by a stamp that lies.
 *
 * Fail-soft throughout: a read or write that fails is skipped, never thrown —
 * nothing here may break a SessionStart. Returns the paths actually rewritten.
 */
export async function refreshStaleShims(home: string): Promise<string[]> {
  const rewritten: string[] = [];
  const targets: Array<[string, string]> = [
    [statuslineShimPath(home), renderStatuslineShim()],
    [daemonShimPath(home), renderDaemonShim()],
  ];
  for (const [path, wanted] of targets) {
    try {
      // Constraint 1. Belt and braces: readFileSync below would throw into the
      // catch anyway, but relying on that means the guarantee lives in an
      // accident rather than in a line you can read.
      if (!existsSync(path)) continue;
      if (readFileSync(path, "utf8") === wanted) continue; // no churn — constraint 2
      await writeExecutable(path, wanted);
      rewritten.push(path);
    } catch {
      // Unreadable, unwritable, vanished mid-check: leave it and move on.
    }
  }
  return rewritten;
}

export async function writeShim(home: string): Promise<string> {
  return writeExecutable(statuslineShimPath(home), renderStatuslineShim());
}

export async function writeDaemonShim(home: string): Promise<string> {
  return writeExecutable(daemonShimPath(home), renderDaemonShim());
}
