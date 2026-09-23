#!/bin/sh
# Siltpoke Codex Stop-hook guard. Auto-discovered from the Codex plugin root.
# Live the instant the plugin is enabled — BEFORE config exists, possibly no bun.
# Anything missing ⇒ exit 0 in silence. Never leak an error into the Codex session.
set -u
HOME="${HOME:-}"
SILTPOKE_DIR="${HOME}/.siltpoke"
NUDGE_MARKER="${SILTPOKE_DIR}/.codex-stop-nudged"

# Once-ever install nudge (defect [8]): codex has no `/siltpoke-*` slash
# commands, so it must never be told to run one — see README.md's "In Codex
# there are no /siltpoke-* slash commands" section. Same guarantees as
# hooks/stop.sh's nudge_once (duplicated here, not sourced, since the codex
# plugin dir ships only this file at runtime): `touch` not `: >` (dash special-
# builtin redirection-failure crash), print only if the marker actually landed
# (an unwritable ~/.siltpoke must stay silent forever, not nag every turn).
#
# The marker is `.codex-stop-nudged`, NOT `.codex-nudged` (the 2026-07-18
# codex pet-config-bootstrap design's name) and NOT the shared `.nudged`
# stop.sh uses. `.codex-nudged` is already owned by a DIFFERENT, pre-existing
# nudge — `codexFirstRunNudge` in src/hooks/handle-session-start.ts, which
# fires on SessionStart and writes that exact marker. SessionStart always
# fires before Stop in the same session (hooks/hooks.json wires both), so a
# shared name would let the SessionStart nudge consume the marker and this
# Stop-hook nudge would stay silent forever — reinstating defect [8]'s exact
# "total silence" symptom. The two nudges are deliberately independent, not
# just differently named: the SessionStart nudge emits a hook `systemMessage`
# whose own source comment says an isolated smoke on codex-cli 0.143.0 could
# NOT confirm it actually renders in the TUI, so it is advisory at best,
# while THIS hook's stderr line is the one verified to appear. Losing the
# verified nudge to a silent collision with an unverified one would be worse
# than the duplicate marker file this instead accepts.
#
# The marker is otherwise still PER HOST: $HOME/.siltpoke is shared across
# every host on the machine, so one shared marker means: install in Claude
# Code, see the nudge, skip setup, then install in codex => codex stays
# silent and the user is back to defect [9]'s symptom (installed, does
# nothing, says nothing). Per-host costs a multi-host user one extra
# one-time line, each host-correct.
nudge_once() {
  [ -f "$NUDGE_MARKER" ] && return 0
  mkdir -p "$SILTPOKE_DIR" 2>/dev/null || true
  touch "$NUDGE_MARKER" 2>/dev/null || true
  [ -f "$NUDGE_MARKER" ] || return 0
  printf '%s\n' "Siltpoke installed. Run /skills -> pick siltpoke to meet your pet (express or custom), or just ask in natural language." >&2
}

# Read payload on EVERY path so the host never blocks on its pipe write.
PAYLOAD="$(cat 2>/dev/null)"

# An internal codex-reviewer spawn carries SILTPOKE_INTERNAL=1 — must not re-fire.
[ "${SILTPOKE_INTERNAL:-}" = "1" ] && exit 0
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

# Command runs with cwd = plugin root, so the bundle is at ./dist/codex-stop.js.
HERE="$(dirname "$0")/.."
[ -f "${HERE}/dist/codex-stop.js" ] || exit 0
# SILTPOKE_HOST=codex tells brain-config the builder family this run (Slice A):
# review defaults to the codex family instead of claude. Inherited by the spawned
# reviewer child (same env-passthrough as SILTPOKE_INTERNAL above).
printf '%s' "$PAYLOAD" | SILTPOKE_HOST=codex "$BUN" "${HERE}/dist/codex-stop.js"
exit 0
