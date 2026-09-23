# shellcheck shell=sh
# Siltpoke — resolve the bun binary from a NON-LOGIN shell.
#
# Sourced by every hook guard under hooks/. Defines one function and touches
# nothing else, so it is safe to source under `set -u` from a guard that has
# already read its payload.
#
# Why this file exists (defects [20] / [21], measured 2026-09-22): bun's own
# installer appends its PATH line to ~/.bash_profile, which ONLY a login shell
# reads. Claude Code runs hooks and the statusline in a non-login shell, so
# `command -v bun` finds nothing there while the same user's interactive
# terminal runs bun fine. The guards then exited 0 in silence on every turn:
# review never fired, and every visible sign — config.json, the pet, the
# statusline — still said "installed".
#
# Resolution order, and why:
#   1. PATH — the normal case, and the only one that keeps working if the user
#      later moves bun somewhere else entirely.
#   2. ~/.siltpoke/bun-path — the absolute path `setup` recorded from its own
#      process.execPath. setup is itself a bun program, so it always knows the
#      real answer; this is the same pointer-file pattern as
#      ~/.siltpoke/plugin-root (see src/installer/shim.ts).
#   3. ~/.bun/bin/bun — the installer's default location, for a machine that
#      has bun but never ran siltpoke's setup through it.
#
# Prints the resolved path on stdout and returns 0; prints nothing and returns
# 1 when bun is genuinely unreachable. Callers decide what to do with that —
# the hook guards stay silent (nothing may reach the user's session), while
# /siltpoke-doctor and the statusline are the surfaces that say it out loud.
siltpoke_resolve_bun() {
  _siltpoke_bun="$(command -v bun 2>/dev/null || true)"
  if [ -n "$_siltpoke_bun" ]; then
    printf '%s' "$_siltpoke_bun"
    return 0
  fi

  # `cat`, not `read`: a pointer file written without a trailing newline makes
  # `read` return non-zero even though it did set the variable, and under the
  # callers' `set -e`-free-but-`set -u` shells that reads as "no pointer".
  _siltpoke_ptr="${HOME:-}/.siltpoke/bun-path"
  if [ -f "$_siltpoke_ptr" ]; then
    # Command substitution already strips trailing newlines, so the writer's
    # trailing \n needs no `tr` — and must not use one: tr is external, and this
    # function has to survive a PATH where nothing resolves.
    _siltpoke_bun="$(cat "$_siltpoke_ptr" 2>/dev/null || true)"
    if [ -n "$_siltpoke_bun" ] && [ -x "$_siltpoke_bun" ]; then
      printf '%s' "$_siltpoke_bun"
      return 0
    fi
  fi

  _siltpoke_bun="${HOME:-}/.bun/bin/bun"
  if [ -x "$_siltpoke_bun" ]; then
    printf '%s' "$_siltpoke_bun"
    return 0
  fi

  return 1
}
