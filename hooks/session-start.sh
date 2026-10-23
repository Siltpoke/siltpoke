#!/bin/sh
# Records where this version of the plugin is installed, so surfaces that CANNOT
# use ${CLAUDE_PLUGIN_ROOT} — the statusLine command, the daemon autostart unit —
# can find the current bundle after a plugin upgrade moves the cache directory.
set -u
PAYLOAD="$(cat 2>/dev/null)"   # capture the SessionStart payload (carries session_id)

# Defect [73]: a `claude -p` / codex / agy child that siltpoke itself spawned
# (reviewer, explain, chat, distil) loads the user's installed plugin and fires
# THIS hook. Every spawn site sets SILTPOKE_INTERNAL=1 (src/router/router.ts
# isSiltpokeInternal); exit before anything below can write — the plugin-root
# pointer, the nudge marker, a telemetry row — so a review can never rewrite the
# user's real state. Payload is already drained above.
[ "${SILTPOKE_INTERNAL:-}" = "1" ] && exit 0

# Guarded with :- (not bare ${HOME}) — under `set -u` an unset HOME is a hard
# "unbound variable" crash, the same bug class as the unguarded
# ${CLAUDE_PLUGIN_ROOT} this script already defaults below.
HOME="${HOME:-}"
# Honour SILTPOKE_HOME exactly like siltpokeRoot() in src/installer/paths.ts
# (empty counts as unset, hence `:-`). A hard-coded $HOME/.siltpoke made an
# isolated run (and every hook fired inside one) write the REAL home (defect [73]).
SILTPOKE_DIR="${SILTPOKE_HOME:-${HOME}/.siltpoke}"
TMP_FILE="${SILTPOKE_DIR}/plugin-root.tmp"
FINAL_FILE="${SILTPOKE_DIR}/plugin-root"

mkdir -p "$SILTPOKE_DIR" 2>/dev/null || true

# CC exports CLAUDE_PLUGIN_ROOT; CC-fork hosts (qoder/codebuddy) may export a
# host-specific name or none. Try the known names, then fall back to resolving
# the plugin root from this script's own location (hooks/ -> plugin root). Each
# guarded with :- so an unset var never crashes under `set -u`.
PLUGIN_ROOT="${CLAUDE_PLUGIN_ROOT:-}"
[ -n "$PLUGIN_ROOT" ] || PLUGIN_ROOT="${QODER_PLUGIN_ROOT:-}"
[ -n "$PLUGIN_ROOT" ] || PLUGIN_ROOT="${CODEBUDDY_PLUGIN_ROOT:-}"
[ -n "$PLUGIN_ROOT" ] || PLUGIN_ROOT="$(CDPATH= cd -- "$(dirname -- "$0")/.." 2>/dev/null && pwd)"

# Grouped so 2>/dev/null suppresses the shell's OWN "cannot create file" error
# too — a bare `printf ... > "$TMP_FILE" 2>/dev/null` applies the file
# redirect BEFORE the stderr redirect (left-to-right), so an unwritable
# $SILTPOKE_DIR leaks "Permission denied" to the session before the later
# 2>/dev/null ever takes effect.
# Defect [91]: with several hosts installed, each host's hook names its own
# copy, and the daemon restarts from whichever wrote last. Move the pointer only
# to a copy whose daemon bundle is at least as new as the one it names, or when
# that one is gone. Same rule as writePluginRootPointer (src/hooks/hook-guard-core.ts).
SILTPOKE_KEEP_ROOT=""
SILTPOKE_OLD_ROOT="$(cat "$FINAL_FILE" 2>/dev/null || true)"
if [ -n "$SILTPOKE_OLD_ROOT" ] && [ "$SILTPOKE_OLD_ROOT" != "$PLUGIN_ROOT" ] \
   && [ -f "${SILTPOKE_OLD_ROOT}/dist/siltpoke-daemon.js" ]; then
  if [ ! -f "${PLUGIN_ROOT}/dist/siltpoke-daemon.js" ] \
     || [ "${SILTPOKE_OLD_ROOT}/dist/siltpoke-daemon.js" -nt "${PLUGIN_ROOT}/dist/siltpoke-daemon.js" ]; then
    SILTPOKE_KEEP_ROOT=1
  fi
fi

if [ -z "$SILTPOKE_KEEP_ROOT" ]; then
  { printf '%s' "$PLUGIN_ROOT" > "$TMP_FILE"; } 2>/dev/null || exit 0
  # If the rename fails after the tmp file was written, don't leave it orphaned.
  mv "$TMP_FILE" "$FINAL_FILE" 2>/dev/null || rm -f "$TMP_FILE" 2>/dev/null || true
fi

# Defect [49]: record which agent this session runs in, for the dashboard
# daemon (hooks/lib/record-host.sh). Same detection and the same order as
# hooks/stop.sh's SILTPOKE_HOST_FAMILY — fork-specific names FIRST, plain claude
# LAST — and none set leaves it empty, which records nothing. Unconditional
# like the pointer above: no config.json and no bun still leave it refreshed.
SILTPOKE_HOST_FAMILY=""
[ -n "${QODER_PLUGIN_ROOT:-}" ] && SILTPOKE_HOST_FAMILY="qoder"
[ -z "$SILTPOKE_HOST_FAMILY" ] && [ -n "${CODEBUDDY_PLUGIN_ROOT:-}" ] && SILTPOKE_HOST_FAMILY="codebuddy"
[ -z "$SILTPOKE_HOST_FAMILY" ] && [ -n "${CLAUDE_PLUGIN_ROOT:-}" ] && SILTPOKE_HOST_FAMILY="claude"
# -r and ${0%/*} for the reasons given at the resolve-bun.sh source below.
SILTPOKE_RECORD_LIB="${0%/*}/lib/record-host.sh"
[ -r "$SILTPOKE_RECORD_LIB" ] && . "$SILTPOKE_RECORD_LIB" && siltpoke_record_host "$SILTPOKE_HOST_FAMILY"

# Invoke the SessionStart bundle so the once-ever legacy-hook migration
# sweep (removeCodexLegacyHooks / removeCcForkLegacyHooks, wired in
# src/hooks/handle-session-start.ts) actually runs for CC-fork hosts
# (qoder/codebuddy), which share this wrapper rather than having their own
# like codex's hooks/codex-session-start.sh. Guarded, silent, gated exactly
# like hooks/stop.sh: missing config.json / bun / bundle => no-op. Running
# this on plain Claude Code too is harmless — CC's legacy entries are
# already swept by configure.ts, so it's a no-op there.
BUN=""
# ${0%/*}, not $(dirname "$0"): dirname is an EXTERNAL command, so on a
# maximally-broken PATH it is itself unresolvable and prints
# "dirname: not found" straight into the user's session — the one thing
# this guard may never do. Parameter expansion is a shell builtin.
SILTPOKE_RESOLVE_LIB="${0%/*}/lib/resolve-bun.sh"
[ -r "$SILTPOKE_RESOLVE_LIB" ] && . "$SILTPOKE_RESOLVE_LIB" && BUN="$(siltpoke_resolve_bun || true)"
[ -n "$BUN" ] || BUN="$(command -v bun 2>/dev/null || true)"
if [ -f "${SILTPOKE_DIR}/config.json" ] && [ -n "$BUN" ] \
   && [ -f "${PLUGIN_ROOT}/dist/handle-session-start.js" ]; then
  printf '%s' "$PAYLOAD" | "$BUN" "${PLUGIN_ROOT}/dist/handle-session-start.js" >/dev/null 2>&1 || true
fi
exit 0
