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
 * Fail-soft by construction: nothing here ever errors into the statusline.
 *
 * When the plugin is gone (defect [61]) this shim is the only siltpoke code
 * still being run — settings.json keeps pointing at it, and Claude Code has no
 * uninstall hook that could change that. So the repair lives here, in two
 * stages that match what \`claude plugin uninstall\` really does (measured
 * 2026-10-02, audit §70.4):
 *
 *   1. The cache directory is still on disk, marked \`.orphaned_at\`, and
 *      \`installed_plugins.json\` no longer lists the plugin. The bundle still
 *      runs, so it is asked ONCE to put the user's own statusLine back into
 *      settings.json; this render shows the user's line instead of the pet.
 *   2. The cache directory is gone. Nothing can edit settings.json any more,
 *      so the shim simply runs the user's saved command every time.
 *
 * "Uninstalled" needs BOTH signals. A plugin UPDATE orphans the old version
 * directory too, and the pointer keeps naming it until the next SessionStart;
 * \`.orphaned_at\` alone would take every update for an uninstall and remove a
 * pet the user still wants. A registry that is missing or cannot be read is
 * "unknown", and unknown is never treated as uninstalled.
 *
 * The registry asked is always Claude Code's own, whatever root the (shared)
 * pointer names — this script is only ever started from Claude Code's settings.
 *
 * Accepted, not fixed: someone who installed the plugin,
 * uninstalled it, and now runs with \`--plugin-dir\` looks exactly like an
 * uninstall (old mark on disk, no registry entry), so the pet goes away.
 * Recovery is documented in docs/MANUAL.md "Uninstall": delete the leftover
 * cache copy, then /siltpoke:siltpoke-setup.
 */
export function renderStatuslineShim(): string {
  return `#!/bin/sh
set -u
# Guarded with :- (not bare \${HOME}) — under set -u a bare reference to an
# unset HOME is a hard "unbound variable" crash straight to the session's
# statusline. Same bug class session-start.sh already guards against.
HOME="\${HOME:-}"
ROOT_FILE="\${HOME}/.siltpoke/plugin-root"
INNER_FILE="\${HOME}/.siltpoke/inner.txt"
# Hand this render to the status line the user had before siltpoke. stdin is
# left untouched so their command still receives Claude Code's JSON.
run_inner() {
  [ -f "$INNER_FILE" ] || exit 0
  INNER="$(cat "$INNER_FILE" 2>/dev/null || true)"
  [ -n "$INNER" ] || exit 0
  # A saved command that is this shim would call itself forever.
  case "$INNER" in *.siltpoke/bin/statusline.sh*) exit 0 ;; esac
  # bash first, as the card runs it (src/face/wrapper.ts); sh where there is none.
  if command -v bash >/dev/null 2>&1; then exec bash -c "$INNER"; fi
  exec sh -c "$INNER"
}
[ -f "$ROOT_FILE" ] || run_inner
ROOT="$(cat "$ROOT_FILE" 2>/dev/null)" || exit 0
CARD="\${ROOT}/dist/siltpoke-card.js"
[ -f "$CARD" ] || run_inner
${BUN_RESOLVE_SNIPPET}
# This shim is only ever started from CLAUDE CODE's settings.json, so the only
# uninstall it may act on is Claude Code's — and both signals are read from
# Claude Code's own plugin folder, never from wherever the pointer leads. The
# pointer is shared (qoder and codebuddy write the same file, with the same
# cache layout), so following it would let another host's uninstall take the
# pet out of Claude Code.
CLAUDE_PLUGINS="\${CLAUDE_HOME:-\${HOME}/.claude}/plugins"
REGISTRY="\${CLAUDE_PLUGINS}/installed_plugins.json"
# The orphan mark is looked for on Claude Code's CACHE COPY of the plugin, not
# at the pointer's root. With a directory marketplace the plugin runs from its
# source folder (which is what the pointer names) and the mark is still written
# to the cache copy — measured 2026-10-02, where looking only at the root left
# the pet in place after a real uninstall.
ORPHAN=""
for MARK in "$CLAUDE_PLUGINS"/cache/*/siltpoke/*/.orphaned_at; do
  [ -f "$MARK" ] && ORPHAN="$MARK"
done
UNINSTALLED=0
if [ -n "$ORPHAN" ] && [ -f "$REGISTRY" ]; then
  grep -q '"siltpoke@' "$REGISTRY" 2>/dev/null
  # Exactly 1 = grep ran and found no siltpoke. Anything else (found, or grep
  # itself unusable) leaves the pet alone.
  [ "$?" -eq 1 ] && UNINSTALLED=1
fi
if [ "$UNINSTALLED" -eq 1 ]; then
  # One repair attempt per uninstall, keyed on the orphan stamp — not one bun
  # start per render for as long as settings.json is stuck. The stamp is
  # recorded only once an attempt was actually made: a render that could not
  # reach bun must not use the attempt up.
  STAMP="$(cat "$ORPHAN" 2>/dev/null || true)"
  SEEN_FILE="\${HOME}/.siltpoke/.uninstall-seen"
  SEEN="$(cat "$SEEN_FILE" 2>/dev/null || true)"
  CLI="\${ROOT}/dist/siltpoke-cli.js"
  if [ -n "$BUN" ] && [ -f "$CLI" ]; then
    if [ ! -f "$SEEN_FILE" ] || [ "$STAMP" != "$SEEN" ]; then
      { printf '%s' "$STAMP" > "$SEEN_FILE"; } 2>/dev/null || true
      "$BUN" "$CLI" restore-statusline </dev/null >/dev/null 2>&1 || true
    fi
  fi
  run_inner
fi
# Defect [21]: this used to be \`command -v bun … || exit 0\`, so a user whose bun
# PATH lives only in ~/.bash_profile got a BLANK statusline with no way to find
# out why — the pet simply never appeared. The statusline is the one surface the
# user looks at every turn, so it is where this gets said out loud (the hook
# guards stay silent by rule). One short line, no newline of its own.
[ -n "$BUN" ] || { printf '%s' "siltpoke: can't find bun (not on PATH) — run /siltpoke:siltpoke-doctor"; exit 0; }
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

/**
 * The uninstall a user can still run AFTER `claude plugin uninstall` (defect
 * [61]). `/siltpoke:siltpoke-uninstall` leaves with the plugin, and most people uninstall
 * the plugin first — so the way out has to live outside the plugin directory,
 * next to the other two shims.
 *
 * It only finds the bundle and hands over: Claude Code keeps the cache
 * directory for a while after an uninstall, so the real code is normally still
 * there. When it is not, the script says what is left to do by hand, and it
 * will delete ~/.siltpoke on `--purge` only if settings.json no longer points
 * into that folder — deleting it earlier would take the saved original status
 * line (inner.txt) with it and leave a blank line nobody can repair.
 */
export function renderUninstallShim(): string {
  return `#!/bin/sh
set -u
HOME="\${HOME:-}"
ROOT="$(cat "\${HOME}/.siltpoke/plugin-root" 2>/dev/null || true)"
CLI="\${ROOT}/dist/siltpoke-cli.js"
${BUN_RESOLVE_SNIPPET}
if [ -n "$ROOT" ] && [ -f "$CLI" ]; then
  if [ -n "$BUN" ]; then
    exec "$BUN" "$CLI" uninstall "$@"
  fi
  # The bundle is here and only bun is missing. That is NOT "the files are
  # gone": falling through would let --purge delete the data of a plugin that
  # may still be installed.
  printf '%s\\n' \\
    "Siltpoke's uninstall needs bun and cannot find it (not on PATH, not in \${HOME}/.bun)." \\
    "Nothing was changed. Put bun on PATH and run this again."
  exit 1
fi
# From here on Siltpoke's own code is gone, so no removal plan can be computed
# and nothing can be asked item by item. Say where the record is, first: a
# --purge below deletes the folder it is in.
RECEIPT="\${HOME}/.siltpoke/receipt.json"
if [ -f "$RECEIPT" ]; then
  printf '%s\\n' \\
    "Siltpoke's own files are gone, so this script cannot ask about each thing it installed." \\
    "What it installed on this machine is recorded in:" \\
    "  $RECEIPT"
fi
CLAUDE_DIR="\${CLAUDE_HOME:-\${HOME}/.claude}"
SETTINGS="\${CLAUDE_DIR}/settings.json"
# Matches the Windows form too: in JSON the path is written with doubled backslashes.
if grep -q 'siltpoke.*bin.*statusline\\.sh' "$SETTINGS" 2>/dev/null; then
  printf '%s\\n' \\
    "Siltpoke's own files are gone, so this script cannot edit your settings for you." \\
    "One thing is left to do by hand:" \\
    "  1. Open $SETTINGS and find the \\"statusLine\\" block." \\
    "  2. If you had a status line before Siltpoke, its command is saved in" \\
    "     \${HOME}/.siltpoke/inner.txt - put it back as the \\"command\\"." \\
    "     If you had none, delete the whole \\"statusLine\\" block." \\
    "  3. Run this script again with --purge to delete \${HOME}/.siltpoke."
  exit 1
fi
case " $* " in
  *" --purge "*)
    # Same rule as the real uninstall (src/installer/plugin-hosts.ts): no
    # deleting while ANY host still lists the plugin, because its hooks would
    # write the folder straight back. The folder is shared by all of them.
    # Every match is kept, not just the last: the user must see every host
    # that still has it, and the codex hint below depends on knowing whether
    # codex was the only one.
    STILL=""
    add_still() { if [ -n "$STILL" ]; then STILL="$STILL; $1"; else STILL="$1"; fi; }
    for REG in \\
      "\${CLAUDE_DIR}/plugins/installed_plugins.json" \\
      "\${HOME}/.codebuddy/plugins/installed_plugins.json" \\
      "\${HOME}/.qoder/plugins/installed_plugins.json" \\
      "\${HOME}/.qoder/plugins/installed_plugins_v2.json"
    do
      if grep -q '"siltpoke@' "$REG" 2>/dev/null; then add_still "$REG"; fi
    done
    if [ -d "\${HOME}/.gemini/config/plugins/siltpoke" ]; then add_still "\${HOME}/.gemini/config/plugins/siltpoke"; fi
    # The plugin's exact NAME key in the JSON list, not a bare "siltpoke": that
    # also matches a marketplace of that name or a path that happens to contain
    # it, and such a refusal could never be cleared. The key is matched
    # ANYWHERE, including the "available" list: telling the two lists apart
    # needs a JSON parser this script does not have, and a wrong "not
    # installed" lets rm -rf through. So it blocks too often rather than miss,
    # and says how to finish by hand when that happens — but only when codex is
    # the ONLY host blocking, or the hand delete would hit a folder another
    # host's hooks write straight back.
    # A codex that fails or prints nothing is UNKNOWN, not "not installed" —
    # the same rule as the TS uninstall (plugin-hosts.ts returns null there).
    CODEX=""
    CODEX_ONLY=0
    if command -v codex >/dev/null 2>&1; then
      if LIST="$(codex plugin list --json 2>/dev/null)" && [ -n "$LIST" ]; then
        if printf '%s' "$LIST" | tr -d '[:space:]' | grep -q '"name":"siltpoke"'; then
          CODEX="codex plugin list"
        fi
      else
        CODEX="codex plugin list (could not be read)"
      fi
    fi
    if [ -n "$CODEX" ]; then
      [ -z "$STILL" ] && CODEX_ONLY=1
      add_still "$CODEX"
    fi
    if [ -n "$STILL" ]; then
      printf '%s\\n' \\
        "Siltpoke is still installed in a coding agent, so nothing was deleted." \\
        "Seen in: $STILL" \\
        "Uninstall it there (in Claude Code: claude plugin uninstall siltpoke), then run this again." \\
        "If you installed it for one project only, run that command in the project's folder" \\
        "and add the scope you installed with: --scope local   or   --scope project"
      if [ "$CODEX_ONLY" -eq 1 ]; then
        printf '%s\\n' \\
          "This script cannot always tell from codex whether Siltpoke is installed there:" \\
          "it may be listed only as available, or the list could not be read." \\
          "If 'codex plugin list' shows it is not installed, delete the folder yourself:" \\
          "  rm -rf \${HOME}/.siltpoke"
      fi
      exit 1
    fi
    rm -rf "\${HOME}/.siltpoke"
    printf '%s\\n' "Deleted \${HOME}/.siltpoke. Siltpoke has nothing left in your settings."
    ;;
  *)
    printf '%s\\n' \\
      "Siltpoke has nothing left in your settings." \\
      "Your pet, its memory and its review history are still in \${HOME}/.siltpoke." \\
      "To delete them: sh \${HOME}/.siltpoke/bin/uninstall.sh --purge"
    ;;
esac
`;
}

/** Where the post-uninstall script lives. Outside the plugin directory, by design. */
export function uninstallShimPath(home: string): string {
  return join(home, ".siltpoke", "bin", "uninstall.sh");
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
  // The uninstall script is the one file here that IS created on refresh —
  // but only beside a statusline shim, i.e. only for someone who ran setup. It
  // exists so that person has a way out after the plugin is gone; everyone who
  // set up before it existed would otherwise never get one (constraint 1 is
  // about not opting people INTO a surface, and this adds none).
  try {
    const path = uninstallShimPath(home);
    const wanted = renderUninstallShim();
    const current = existsSync(path) ? readFileSync(path, "utf8") : null;
    if (existsSync(statuslineShimPath(home)) && current !== wanted) {
      await writeExecutable(path, wanted);
      rewritten.push(path);
    }
  } catch {
    // Same rule as above: never break a SessionStart over this.
  }
  return rewritten;
}

export async function writeShim(home: string): Promise<string> {
  // Written together: whoever gets the statusline shim also gets the way out.
  await writeExecutable(uninstallShimPath(home), renderUninstallShim());
  return writeExecutable(statuslineShimPath(home), renderStatuslineShim());
}

export async function writeDaemonShim(home: string): Promise<string> {
  return writeExecutable(daemonShimPath(home), renderDaemonShim());
}
