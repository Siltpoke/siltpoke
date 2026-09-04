#!/bin/sh
# Siltpoke Codex SessionStart-hook guard. Captures the session baseline.
set -u
HOME="${HOME:-}"
PAYLOAD="$(cat 2>/dev/null)"
[ "${SILTPOKE_INTERNAL:-}" = "1" ] && exit 0
command -v bun > /dev/null 2>&1 || exit 0
HERE="$(dirname "$0")/.."
[ -f "${HERE}/dist/handle-session-start.js" ] || exit 0
# SILTPOKE_HOST=codex is the ONLY signal handle-session-start.ts trusts to
# know it is firing from the Codex plugin's own hooks.json (vs. a legacy
# `~/.codex/hooks.json` entry invoking the source file directly, or a Claude
# Code SessionStart firing while a session happens to be working inside this
# very repo) — see track #9's maybeMigrateLegacyCodexHooks. Set here, by the
# ONE wrapper script the plugin's hooks.json actually declares; never set by
# any other invocation path.
printf '%s' "$PAYLOAD" | SILTPOKE_HOST=codex bun "${HERE}/dist/handle-session-start.js"
exit 0
