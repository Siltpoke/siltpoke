#!/bin/sh
# Siltpoke agy Stop-hook guard. Same guarantees as hooks/stop.sh: anything
# missing => silent exit 0; never leak an error into the agy session.
set -u
HOME="${HOME:-}"
SILTPOKE_DIR="${HOME}/.siltpoke"
NUDGE_MARKER="${SILTPOKE_DIR}/.agy-stop-nudged"

# Once-ever install nudge (defect [8]): agy has no verified `/siltpoke-*` slash
# form (agy --help shows no `skills` subcommand), so the nudge must name ONLY a
# natural-language instruction, never a slash command. Same guarantees as
# hooks/stop.sh's nudge_once (duplicated here, not sourced, since the agy
# plugin dir ships only this file at runtime): `touch` not `: >` (dash special-
# builtin redirection-failure crash), print only if the marker actually landed
# (an unwritable ~/.siltpoke must stay silent forever, not nag every turn).
#
# The marker is `.agy-stop-nudged`, matching hooks/codex-stop.sh's
# `.codex-stop-nudged` — the two Stop-hook nudges are a deliberate family, each
# suffixed `-stop-` so nothing else in the codebase can collide with either
# name (swept: only hooks/stop.sh's `.nudged` and
# src/hooks/handle-session-start.ts's `.codex-nudged` write anything under
# ~/.siltpoke with "nudge" in the name, and neither matches this shape). That
# second one is exactly why codex-stop.sh no longer uses the un-suffixed
# `.codex-nudged`: it was already owned by a different, pre-existing
# SessionStart nudge, so reusing it silenced this hook's nudge outright. agy
# has no colliding SessionStart nudge today, but the family name is worth
# keeping consistent so a future reader never has to ask why only one host is
# suffixed.
#
# The marker is otherwise still PER HOST: $HOME/.siltpoke is shared across
# every host on the machine, so one shared marker means: install in Claude
# Code, see the nudge, skip setup, then install in agy => agy stays silent and
# the user is back to defect [9]'s symptom (installed, does nothing, says
# nothing). Per-host costs a multi-host user one extra one-time line, each
# host-correct.
nudge_once() {
  [ -f "$NUDGE_MARKER" ] && return 0
  mkdir -p "$SILTPOKE_DIR" 2>/dev/null || true
  touch "$NUDGE_MARKER" 2>/dev/null || true
  [ -f "$NUDGE_MARKER" ] || return 0
  printf '%s\n' 'Siltpoke installed. Ask your agent to "set up Siltpoke" to meet your pet (express or custom).' >&2
}

PAYLOAD="$(cat 2>/dev/null)"
[ -f "${SILTPOKE_DIR}/config.json" ] || { nudge_once; exit 0; }
# Defect [20]/[21]: PATH alone loses bun in a non-login shell. No nudge on the
# unresolved path — setup already ran (config.json exists) and cannot fix PATH.
BUN=""
# ${0%/*}, not $(dirname "$0"): dirname is an EXTERNAL command, so on a
# maximally-broken PATH it is itself unresolvable and prints
# "dirname: not found" straight into the user's session — the one thing
# this guard may never do. Parameter expansion is a shell builtin.
SILTPOKE_RESOLVE_LIB="${0%/*}/lib/resolve-bun.sh"
[ -r "$SILTPOKE_RESOLVE_LIB" ] && . "$SILTPOKE_RESOLVE_LIB" && BUN="$(siltpoke_resolve_bun || true)"
[ -n "$BUN" ] || BUN="$(command -v bun 2>/dev/null || true)"
[ -n "$BUN" ] || exit 0
PLUGIN_ROOT="${ANTIGRAVITY_PLUGIN_ROOT:-}"
[ -n "$PLUGIN_ROOT" ] || PLUGIN_ROOT="${AGY_PLUGIN_ROOT:-}"
[ -n "$PLUGIN_ROOT" ] || PLUGIN_ROOT="$(CDPATH= cd -- "$(dirname -- "$0")/.." 2>/dev/null && pwd)"
[ -n "$PLUGIN_ROOT" ] || exit 0
[ -f "${PLUGIN_ROOT}/dist/agy-stop.js" ] || exit 0
# SILTPOKE_HOST=agy tells brain-config the builder family this run (Slice A):
# review defaults to the agy family. Inherited by the spawned reviewer child.
printf '%s' "$PAYLOAD" | SILTPOKE_HOST=agy "$BUN" "${PLUGIN_ROOT}/dist/agy-stop.js"
exit 0
