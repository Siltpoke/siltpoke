#!/bin/sh
# Siltpoke Stop-hook guard.
#
# The plugin's hook is live the instant the plugin is enabled — which is BEFORE
# /siltpoke-setup has run, and possibly on a machine with no bun. Anything
# missing ⇒ exit 0 in silence. Siltpoke must never put an error in the user's
# Claude Code session.
set -u

# Guarded with :- (not bare ${HOME}) — same crash class as CLAUDE_PLUGIN_ROOT
# below: under `set -u` an unset HOME is a hard "unbound variable" crash, and
# it would happen HERE, before PAYLOAD is drained — exactly the host-hang
# failure mode this script exists to avoid.
HOME="${HOME:-}"
SILTPOKE_DIR="${HOME}/.siltpoke"
NUDGE_MARKER="${SILTPOKE_DIR}/.nudged"

nudge_once() {
  [ -f "$NUDGE_MARKER" ] && return 0
  mkdir -p "$SILTPOKE_DIR" 2>/dev/null || true
  # `touch`, NOT `: > "$NUDGE_MARKER"`. In dash (Linux's /bin/sh) a redirection
  # failure on a SPECIAL BUILTIN — and `:` is one — terminates the whole shell
  # (exit 2), before the `|| true` can catch it. bash (macOS's /bin/sh) is
  # lenient, so `: >` on an unwritable $SILTPOKE_DIR passes on macOS but crashes
  # the guard on Linux. `touch` is an external command: its failure is an
  # ordinary non-zero exit that `|| true` swallows. 2>/dev/null hides its stderr.
  touch "$NUDGE_MARKER" 2>/dev/null || true
  # Only print if the marker actually landed. If ~/.siltpoke is permanently
  # unwritable, the write above silently fails every single time — printing
  # unconditionally here would turn the "once ever" nudge into a per-turn
  # nag, which is exactly the spam this marker exists to prevent. A silent
  # Siltpoke beats one that can't keep its own promise.
  [ -f "$NUDGE_MARKER" ] || return 0
  printf '%s\n' "Siltpoke installed. Run /siltpoke-setup to meet your pet (express or custom)." >&2
}

# Read the payload up front — on EVERY path. A hook that leaves stdin unread can
# make the host block on its pipe write, and the guard's early exits must not be
# the thing that hangs Claude Code.
# stderr redirected: a maximally-broken PATH (e.g. empty, which POSIX treats as
# "search cwd only") can make `cat` itself unresolvable — that must stay silent
# too, per the governing rule that nothing here ever prints to the session.
PAYLOAD="$(cat 2>/dev/null)"

[ -f "${SILTPOKE_DIR}/config.json" ] || { nudge_once; exit 0; }

# Defect [20]/[21]: a bare `command -v bun` here made review silently never fire
# for any user whose bun PATH lives only in ~/.bash_profile — Claude Code's hook
# shell is non-login and never reads it. hooks/lib/resolve-bun.sh also accepts
# the absolute path setup recorded and bun's default install location.
#
# Sourced through $0's own directory, with an inline PATH-only fallback so a
# missing lib degrades to the old behaviour instead of killing the guard.
BUN=""
# -r, not -f: `.` (dot/source) is a POSIX SPECIAL BUILTIN, so under dash a
# failure to open the file terminates the whole script — with an error line, in
# the user's session. Same hazard class as the `: >` vs `touch` note above. A
# file that exists but cannot be read (a botched extraction, wrong permissions)
# must therefore fall through to the PATH-only fallback, not abort the guard.
#
# ${0%/*}, not $(dirname "$0"): dirname is an EXTERNAL command, so on a
# maximally-broken PATH it is itself unresolvable and prints
# "dirname: not found" straight into the user's session — the one thing
# this guard may never do. Parameter expansion is a shell builtin.
SILTPOKE_RESOLVE_LIB="${0%/*}/lib/resolve-bun.sh"
if [ -r "$SILTPOKE_RESOLVE_LIB" ]; then
  # shellcheck source=lib/resolve-bun.sh
  . "$SILTPOKE_RESOLVE_LIB"
  BUN="$(siltpoke_resolve_bun || true)"
fi
[ -n "$BUN" ] || BUN="$(command -v bun 2>/dev/null || true)"
# NO nudge on this path. config.json exists, so setup has already run, and
# "Run /siltpoke-setup to meet your pet" cannot put bun on a non-login shell's
# PATH — it just sends the user to re-do the one step that already worked.
# /siltpoke-doctor and the statusline are the surfaces that report this.
[ -n "$BUN" ] || exit 0

# Guarded with :- (not bare ${CLAUDE_PLUGIN_ROOT}) — under `set -u` an unset var
# is a hard crash with a stderr line, and the whole point of this script is that
# NOTHING here may ever leak an error into the user's session.
#
# CC exports CLAUDE_PLUGIN_ROOT; CC-fork hosts (qoder/codebuddy) may export a
# host-specific name or none. Try the known names, then fall back to resolving
# the plugin root from this script's own location (hooks/ -> plugin root). Each
# guarded with :- so an unset var never crashes under `set -u`.
PLUGIN_ROOT="${CLAUDE_PLUGIN_ROOT:-}"
[ -n "$PLUGIN_ROOT" ] || PLUGIN_ROOT="${QODER_PLUGIN_ROOT:-}"
[ -n "$PLUGIN_ROOT" ] || PLUGIN_ROOT="${CODEBUDDY_PLUGIN_ROOT:-}"
[ -n "$PLUGIN_ROOT" ] || PLUGIN_ROOT="$(CDPATH= cd -- "$(dirname -- "$0")/.." 2>/dev/null && pwd)"
[ -n "$PLUGIN_ROOT" ] || exit 0
[ -f "${PLUGIN_ROOT}/dist/siltpoke-stop.js" ] || exit 0

# Builder family for brain-config (Slice A): tell the reviewer which CC-family
# host built this run, so `review` defaults to it instead of claude. Detected
# from the same *_PLUGIN_ROOT env the fork exports — fork-specific names FIRST
# (a CC-fork could also export CLAUDE_PLUGIN_ROOT; the specific name wins), plain
# claude LAST. None present (unresolved fork) => empty => brain-config treats it
# as unknown => claude fallback => ZERO REGRESSION. Inherited by the reviewer child.
SILTPOKE_HOST_FAMILY=""
[ -n "${QODER_PLUGIN_ROOT:-}" ] && SILTPOKE_HOST_FAMILY="qoder"
[ -z "$SILTPOKE_HOST_FAMILY" ] && [ -n "${CODEBUDDY_PLUGIN_ROOT:-}" ] && SILTPOKE_HOST_FAMILY="codebuddy"
[ -z "$SILTPOKE_HOST_FAMILY" ] && [ -n "${CLAUDE_PLUGIN_ROOT:-}" ] && SILTPOKE_HOST_FAMILY="claude"

printf '%s' "$PAYLOAD" | SILTPOKE_HOST="$SILTPOKE_HOST_FAMILY" "$BUN" "${PLUGIN_ROOT}/dist/siltpoke-stop.js"

# Deliberate: even a crashing bundle must not surface an error in the user's
# session. The bundle logs its own fatals to ~/.siltpoke/.
exit 0
