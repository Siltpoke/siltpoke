#!/bin/sh
# Siltpoke agy Stop-hook guard. Same guarantees as hooks/stop.sh: anything
# missing => silent exit 0; never leak an error into the agy session.
set -u
HOME="${HOME:-}"
# Same rule as siltpokeRoot() (src/installer/paths.ts): SILTPOKE_HOME wins when
# set and non-empty (`:-` treats empty as unset), else ~/.siltpoke. The TS side
# writes config.json and the [53] marker there, so the shell must look there; a
# hard-coded $HOME/.siltpoke also made an isolated run write the REAL home ([73]).
SILTPOKE_DIR="${SILTPOKE_HOME:-${HOME}/.siltpoke}"

# Before setup, agy's user gets the "set up Siltpoke" hint on the STATUSLINE,
# not from this hook's output. Measured 2026-09-29 in a real interactive agy
# session (install audit §50): agy shows nothing a Stop hook prints — stderr,
# a `systemMessage` line and a `{"decision":"stop","reason":…}` reply all ran
# and all reached the screen 0 times. This file used to print the nudge to
# stderr and write `.agy-stop-nudged`, so the one line meant to guide a new
# agy user was invisible AND marked as delivered (defect [33]'s shape).
# src/hooks/agy-setup-hint.ts does the settings edit; it needs bun, so with no
# bun there is no hint, and nothing is marked, so the next turn tries again.

PAYLOAD="$(cat 2>/dev/null)"

# Defect [73]: a `claude -p` / codex / agy child that siltpoke itself spawned
# (reviewer, explain, chat, distil) loads the user's installed plugin and fires
# THIS hook. Every spawn site sets SILTPOKE_INTERNAL=1 (src/router/router.ts
# isSiltpokeInternal); exit before anything below can write — the plugin-root
# pointer, the nudge marker, a telemetry row — so a review can never rewrite the
# user's real state. Payload is already drained above.
[ "${SILTPOKE_INTERNAL:-}" = "1" ] && exit 0

# Defect [49]: record that this turn ran in agy, for the dashboard daemon
# (hooks/lib/record-host.sh). agy has no SessionStart hook, so this is the only
# place its record is written. Before the gates below: it needs neither setup
# nor bun. ${0%/*} and -r for the reasons given at the resolve-bun.sh source.
SILTPOKE_RECORD_LIB="${0%/*}/lib/record-host.sh"
[ -r "$SILTPOKE_RECORD_LIB" ] && . "$SILTPOKE_RECORD_LIB" && siltpoke_record_host agy

# Defect [20]/[21]: PATH alone loses bun in a non-login shell.
BUN=""
# ${0%/*}, not $(dirname "$0"): dirname is an EXTERNAL command, so on a
# maximally-broken PATH it is itself unresolvable and prints
# "dirname: not found" straight into the user's session — the one thing
# this guard may never do. Parameter expansion is a shell builtin.
SILTPOKE_RESOLVE_LIB="${0%/*}/lib/resolve-bun.sh"
[ -r "$SILTPOKE_RESOLVE_LIB" ] && . "$SILTPOKE_RESOLVE_LIB" && BUN="$(siltpoke_resolve_bun || true)"
[ -n "$BUN" ] || BUN="$(command -v bun 2>/dev/null || true)"
PLUGIN_ROOT="${ANTIGRAVITY_PLUGIN_ROOT:-}"
[ -n "$PLUGIN_ROOT" ] || PLUGIN_ROOT="${AGY_PLUGIN_ROOT:-}"
[ -n "$PLUGIN_ROOT" ] || PLUGIN_ROOT="$(CDPATH= cd -- "$(dirname -- "$0" 2>/dev/null)/.." 2>/dev/null && pwd)"

if [ ! -f "${SILTPOKE_DIR}/config.json" ]; then
  [ -n "$BUN" ] && [ -n "$PLUGIN_ROOT" ] && [ -f "${PLUGIN_ROOT}/dist/agy-stop.js" ] &&
    "$BUN" "${PLUGIN_ROOT}/dist/agy-stop.js" --setup-hint "$PLUGIN_ROOT" </dev/null >/dev/null 2>&1
  exit 0
fi

# Setup has run. A pet made before agy's plugin was installed never reached
# agy's statusline (defect [53]): wire it once. The shell tests the marker so
# the common turn costs one `[ -f ]`, not a bun start.
if [ ! -f "${SILTPOKE_DIR}/.agy-pet-wired" ]; then
  [ -n "$BUN" ] && [ -n "$PLUGIN_ROOT" ] && [ -f "${PLUGIN_ROOT}/dist/agy-stop.js" ] &&
    "$BUN" "${PLUGIN_ROOT}/dist/agy-stop.js" --wire-pet "$PLUGIN_ROOT" </dev/null >/dev/null 2>&1
fi

# No hint on the unresolved paths below — setup cannot fix PATH.
[ -n "$BUN" ] || exit 0
[ -n "$PLUGIN_ROOT" ] || exit 0
[ -f "${PLUGIN_ROOT}/dist/agy-stop.js" ] || exit 0
# SILTPOKE_HOST=agy tells brain-config the builder family this run (Slice A):
# review defaults to the agy family. Inherited by the spawned reviewer child.
printf '%s' "$PAYLOAD" | SILTPOKE_HOST=agy "$BUN" "${PLUGIN_ROOT}/dist/agy-stop.js"
exit 0
