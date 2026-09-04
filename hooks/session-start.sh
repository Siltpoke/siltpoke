#!/bin/sh
# Records where this version of the plugin is installed, so surfaces that CANNOT
# use ${CLAUDE_PLUGIN_ROOT} — the statusLine command, the daemon autostart unit —
# can find the current bundle after a plugin upgrade moves the cache directory.
set -u
PAYLOAD="$(cat 2>/dev/null)"   # capture the SessionStart payload (carries session_id)

# Guarded with :- (not bare ${HOME}) — under `set -u` an unset HOME is a hard
# "unbound variable" crash, the same bug class as the unguarded
# ${CLAUDE_PLUGIN_ROOT} this script already defaults below.
HOME="${HOME:-}"
SILTPOKE_DIR="${HOME}/.siltpoke"
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
{ printf '%s' "$PLUGIN_ROOT" > "$TMP_FILE"; } 2>/dev/null || exit 0
# If the rename fails after the tmp file was written, don't leave it orphaned.
mv "$TMP_FILE" "$FINAL_FILE" 2>/dev/null || rm -f "$TMP_FILE" 2>/dev/null || true

# Invoke the SessionStart bundle so the once-ever legacy-hook migration
# sweep (removeCodexLegacyHooks / removeCcForkLegacyHooks, wired in
# src/hooks/handle-session-start.ts) actually runs for CC-fork hosts
# (qoder/codebuddy), which share this wrapper rather than having their own
# like codex's hooks/codex-session-start.sh. Guarded, silent, gated exactly
# like hooks/stop.sh: missing config.json / bun / bundle => no-op. Running
# this on plain Claude Code too is harmless — CC's legacy entries are
# already swept by configure.ts, so it's a no-op there.
if [ -f "${SILTPOKE_DIR}/config.json" ] && command -v bun >/dev/null 2>&1 \
   && [ -f "${PLUGIN_ROOT}/dist/handle-session-start.js" ]; then
  printf '%s' "$PAYLOAD" | bun "${PLUGIN_ROOT}/dist/handle-session-start.js" >/dev/null 2>&1 || true
fi
exit 0
