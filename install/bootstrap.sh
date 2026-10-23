#!/bin/sh
# SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
# siltpoke bootstrap — one-command installer entry (macOS/Linux).
# Entire body is inside __siltpoke_main so a truncated download cannot execute.
__siltpoke_main() {
  set -eu
  TARBALL_URL="${SILTPOKE_TARBALL_URL:-https://github.com/Siltpoke/siltpoke/releases/latest/download/siltpoke.tar.gz}"
  APP_DIR="${SILTPOKE_HOME:-$HOME/.siltpoke}/app"
  # Install receipt note about bun (spec §2.3): this script runs before any
  # siltpoke code exists, so it leaves one line of JSON that the first TS run
  # merges into ~/.siltpoke/receipt.json and deletes. byUs = bun was NOT on PATH
  # before we acted; "pending" = the bun installer started and has not finished.
  BUN_NOTE="${SILTPOKE_HOME:-$HOME/.siltpoke}/receipt-bootstrap.json"
  TMP="$(mktemp -d)"

  echo "siltpoke: downloading source…"
  curl -fsSL --proto '=https' --tlsv1.2 "$TARBALL_URL" -o "$TMP/siltpoke.tar.gz"

  echo "siltpoke: verifying checksum…"
  EXPECTED="${SILTPOKE_TARBALL_SHA256:-}"
  if [ -z "$EXPECTED" ]; then
    curl -fsSL --proto '=https' --tlsv1.2 "$TARBALL_URL.sha256" -o "$TMP/siltpoke.tar.gz.sha256"
    EXPECTED="$(cut -d' ' -f1 < "$TMP/siltpoke.tar.gz.sha256")"
  fi
  if command -v shasum >/dev/null 2>&1; then
    ACTUAL="$(shasum -a 256 "$TMP/siltpoke.tar.gz" | cut -d' ' -f1)"
  else
    ACTUAL="$(sha256sum "$TMP/siltpoke.tar.gz" | cut -d' ' -f1)"
  fi
  if [ "$ACTUAL" != "$EXPECTED" ]; then
    echo "siltpoke: checksum mismatch — refusing to install ($ACTUAL != $EXPECTED)" >&2
    rm -rf "$TMP"; exit 1
  fi

  mkdir -p "$APP_DIR"
  tar -xzf "$TMP/siltpoke.tar.gz" -C "$APP_DIR" --strip-components=1
  rm -rf "$TMP"

  if ! command -v bun >/dev/null 2>&1; then
    # [63] Ask before installing anything. --yes says yes; with no terminal to ask
    # on (and no --yes) we do not guess: say how, and stop (bun is what runs the rest).
    BUN_OK=0
    # SILTPOKE_YES=1 is the same consent as --yes (the TS side honours both).
    if [ "${SILTPOKE_YES:-}" = "1" ]; then BUN_OK=1; fi
    for a in "$@"; do
      if [ "$a" = "--yes" ]; then BUN_OK=1; fi
    done
    if [ "$BUN_OK" = 0 ]; then
      if ( : < /dev/tty ) 2>/dev/null; then
        printf 'siltpoke needs Bun (its runtime) and it is not installed. Install it now? [Y/n] ' > /dev/tty
        read -r BUN_ANS < /dev/tty || BUN_ANS=""
        case "$BUN_ANS" in "" | [Yy] | [Yy][Ee][Ss]) BUN_OK=1 ;; esac
      else
        echo "siltpoke: no terminal to ask on, so not installing Bun." >&2
      fi
    fi
    if [ "$BUN_OK" != 1 ]; then
      echo "siltpoke: Bun is required. Install it from https://bun.sh and re-run, or re-run piped as: sh -s -- --yes" >&2
      exit 1
    fi
    echo "siltpoke: installing Bun (required runtime)…"
    printf '{"id":"tool:bun","byUs":true,"state":"pending"}\n' > "$BUN_NOTE"
    BUN_TMP="$(mktemp -d)"
    curl -fsSL --proto '=https' --tlsv1.2 https://bun.sh/install -o "$BUN_TMP/bun-install.sh"
    bash "$BUN_TMP/bun-install.sh"
    rm -rf "$BUN_TMP"
    export PATH="$HOME/.bun/bin:$PATH"
    printf '{"id":"tool:bun","byUs":true,"state":"done"}\n' > "$BUN_NOTE"
  elif [ ! -f "$BUN_NOTE" ]; then
    # Already there before us. (An existing note is a pending one from an earlier
    # run that did install it — leave that one alone.)
    printf '{"id":"tool:bun","byUs":false,"state":"done"}\n' > "$BUN_NOTE"
  fi

  echo "siltpoke: starting setup…"
  # Piped from the network, stdin is the pipe; the setup asks questions, so hand it the
  # terminal when there is one (spec 2.4: ask on /dev/tty, never guess without one).
  if [ ! -t 0 ] && ( : < /dev/tty ) 2>/dev/null; then
    exec bun "$APP_DIR/src/cli/bootstrap.ts" "$@" < /dev/tty
  fi
  exec bun "$APP_DIR/src/cli/bootstrap.ts" "$@"
}
__siltpoke_main "$@"
