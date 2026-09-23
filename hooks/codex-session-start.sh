#!/bin/sh
# Siltpoke Codex SessionStart-hook guard. Captures the session baseline.
set -u
HOME="${HOME:-}"
PAYLOAD="$(cat 2>/dev/null)"
[ "${SILTPOKE_INTERNAL:-}" = "1" ] && exit 0
BUN=""
# ${0%/*}, not $(dirname "$0"): dirname is an EXTERNAL command, so on a
# maximally-broken PATH it is itself unresolvable and prints
# "dirname: not found" straight into the user's session — the one thing
# this guard may never do. Parameter expansion is a shell builtin.
SILTPOKE_RESOLVE_LIB="${0%/*}/lib/resolve-bun.sh"
[ -r "$SILTPOKE_RESOLVE_LIB" ] && . "$SILTPOKE_RESOLVE_LIB" && BUN="$(siltpoke_resolve_bun || true)"
[ -n "$BUN" ] || BUN="$(command -v bun 2>/dev/null || true)"
[ -n "$BUN" ] || exit 0
HERE="$(dirname "$0")/.."
[ -f "${HERE}/dist/handle-session-start.js" ] || exit 0
# SILTPOKE_HOST=codex is the ONLY signal handle-session-start.ts trusts to
# know it is firing from the Codex plugin's own hooks.json (vs. a legacy
# `~/.codex/hooks.json` entry invoking the source file directly, or a Claude
# Code SessionStart firing while a session happens to be working inside this
# very repo) — see track #9's maybeMigrateLegacyCodexHooks. Set here, by the
# ONE wrapper script the plugin's hooks.json actually declares; never set by
# any other invocation path.
printf '%s' "$PAYLOAD" | SILTPOKE_HOST=codex "$BUN" "${HERE}/dist/handle-session-start.js"
exit 0
