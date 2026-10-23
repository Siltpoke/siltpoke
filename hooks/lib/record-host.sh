# shellcheck shell=sh
# Siltpoke — record which coding agent this hook is running in.
#
# Sourced by every hook guard under hooks/. Defines one function and touches
# nothing else, so it is safe to source under `set -u`.
#
# Why this file exists (defect [49]): the dashboard daemon is a separate
# process. It never sees SILTPOKE_HOST, which only lives for one hook run, so
# it could not tell which agent the user works in and chat always launched
# `claude`. The hooks DO know, at session start and at the end of each turn;
# this writes it down.
#
# The record is `<siltpoke home>/last-host`, two lines (plus hosts-seen/, below):
#   1. the family — claude | codex | agy | qoder | codebuddy
#   2. the absolute path of that family's command as THIS session resolves it,
#      or an empty line. The autostarted daemon gets a short PATH; the session
#      has the user's real one, so this is the path worth keeping.
# src/installer/last-host.ts writes the same two lines (Windows guard, source
# install) and holds the same family-to-command table.
#
# Rules, each one a way this record could otherwise lie:
#   - An unknown or empty family writes NOTHING. Never `claude` as a guess: a
#     wrong name sends chat to an agent the user may not have.
#   - The caller must already have exited on SILTPOKE_INTERNAL=1. A reviewer
#     child that siltpoke spawned is not the user's agent.
#   - Every failure is silent and returns 0. Nothing here may print into the
#     user's session, and a guard must never stop because of it.
# The first time hosts-seen/ is made, the family in last-host gets a file at
# last-host's time — only if it has none. Two agents starting at once can both
# find the folder missing; the later seed used to put a family the other had
# just touched back to last-host's old time. A seed is always older than a real
# touch, so an existing file is left alone. Mirrors last-host.ts `seedSeen`,
# which creates atomically; here a microsecond gap between the test and the
# touch remains (POSIX sh has no exclusive create without a subshell dance).
_siltpoke_seed_seen() {
  _siltpoke_prev="$({ head -n 1 "$1/last-host"; } 2>/dev/null || true)"
  case "$_siltpoke_prev" in
    claude|codex|agy|qoder|codebuddy)
      [ -e "$2/$_siltpoke_prev" ] || touch -r "$1/last-host" "$2/$_siltpoke_prev" 2>/dev/null || true
      ;;
  esac
  return 0
}

siltpoke_record_host() {
  case "${1:-}" in
    claude|codex|agy|codebuddy) _siltpoke_host_bin="$1" ;;
    qoder) _siltpoke_host_bin="qodercli" ;;
    *) return 0 ;;
  esac

  _siltpoke_host_dir="${SILTPOKE_HOME:-}"
  if [ -z "$_siltpoke_host_dir" ]; then
    [ -n "${HOME:-}" ] || return 0
    _siltpoke_host_dir="${HOME}/.siltpoke"
  fi

  # Only an absolute path is worth recording; `command -v` can also answer
  # with a bare name for a builtin or a function.
  _siltpoke_host_path="$(command -v "$_siltpoke_host_bin" 2>/dev/null || true)"
  case "$_siltpoke_host_path" in
    /*) ;;
    *) _siltpoke_host_path="" ;;
  esac

  mkdir -p "$_siltpoke_host_dir" 2>/dev/null || return 0

  # Every agent seen, not only the last (spec §12.4): an empty file per family
  # under hosts-seen/, whose mtime is when that family was last seen. The first
  # time the folder is made, the family already in last-host gets one too, at
  # last-host's own time — read BEFORE last-host is overwritten below. Each
  # writer seeds before its own touch, so its family always ends fresh.
  _siltpoke_seen_dir="${_siltpoke_host_dir}/hosts-seen"
  if [ ! -d "$_siltpoke_seen_dir" ]; then
    mkdir -p "$_siltpoke_seen_dir" 2>/dev/null || true
    _siltpoke_seed_seen "$_siltpoke_host_dir" "$_siltpoke_seen_dir"
  fi
  touch "${_siltpoke_seen_dir}/$1" 2>/dev/null || true

  # Grouped so 2>/dev/null also covers the shell's own "cannot create" error
  # (see the same note in hooks/session-start.sh). Tmp file + rename: a reader
  # never sees a half-written record.
  # $$ in the name: two agents can end a turn in the same instant, and with one
  # shared tmp name the slower `mv` would find its file already renamed away.
  _siltpoke_host_tmp="${_siltpoke_host_dir}/last-host.tmp.$$"
  { printf '%s\n%s\n' "$1" "$_siltpoke_host_path" > "$_siltpoke_host_tmp"; } 2>/dev/null || return 0
  mv "$_siltpoke_host_tmp" "${_siltpoke_host_dir}/last-host" 2>/dev/null ||
    rm -f "$_siltpoke_host_tmp" 2>/dev/null || true
  return 0
}
