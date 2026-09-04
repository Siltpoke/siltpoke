#!/bin/sh
# Siltpoke Codex Stop-hook guard. Auto-discovered from the Codex plugin root.
# Live the instant the plugin is enabled — BEFORE config exists, possibly no bun.
# Anything missing ⇒ exit 0 in silence. Never leak an error into the Codex session.
set -u
HOME="${HOME:-}"
SILTPOKE_DIR="${HOME}/.siltpoke"

# Read payload on EVERY path so the host never blocks on its pipe write.
PAYLOAD="$(cat 2>/dev/null)"

# An internal codex-reviewer spawn carries SILTPOKE_INTERNAL=1 — must not re-fire.
[ "${SILTPOKE_INTERNAL:-}" = "1" ] && exit 0
[ -f "${SILTPOKE_DIR}/config.json" ] || exit 0
command -v bun > /dev/null 2>&1 || exit 0

# Command runs with cwd = plugin root, so the bundle is at ./dist/codex-stop.js.
HERE="$(dirname "$0")/.."
[ -f "${HERE}/dist/codex-stop.js" ] || exit 0
# SILTPOKE_HOST=codex tells brain-config the builder family this run (Slice A):
# review defaults to the codex family instead of claude. Inherited by the spawned
# reviewer child (same env-passthrough as SILTPOKE_INTERNAL above).
printf '%s' "$PAYLOAD" | SILTPOKE_HOST=codex bun "${HERE}/dist/codex-stop.js"
exit 0
