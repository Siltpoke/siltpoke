#!/bin/sh
# Siltpoke agy Stop-hook guard. Same guarantees as hooks/stop.sh: anything
# missing => silent exit 0; never leak an error into the agy session.
set -u
HOME="${HOME:-}"
SILTPOKE_DIR="${HOME}/.siltpoke"
PAYLOAD="$(cat 2>/dev/null)"
[ -f "${SILTPOKE_DIR}/config.json" ] || exit 0
command -v bun >/dev/null 2>&1 || exit 0
PLUGIN_ROOT="${ANTIGRAVITY_PLUGIN_ROOT:-}"
[ -n "$PLUGIN_ROOT" ] || PLUGIN_ROOT="${AGY_PLUGIN_ROOT:-}"
[ -n "$PLUGIN_ROOT" ] || PLUGIN_ROOT="$(CDPATH= cd -- "$(dirname -- "$0")/.." 2>/dev/null && pwd)"
[ -n "$PLUGIN_ROOT" ] || exit 0
[ -f "${PLUGIN_ROOT}/dist/agy-stop.js" ] || exit 0
# SILTPOKE_HOST=agy tells brain-config the builder family this run (Slice A):
# review defaults to the agy family. Inherited by the spawned reviewer child.
printf '%s' "$PAYLOAD" | SILTPOKE_HOST=agy bun "${PLUGIN_ROOT}/dist/agy-stop.js"
exit 0
