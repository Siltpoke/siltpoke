#!/bin/sh
# SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
# siltpoke bootstrap — one-command installer entry (macOS/Linux).
# Entire body is inside __siltpoke_main so a truncated download cannot execute.
__siltpoke_main() {
  set -eu
  TARBALL_URL="${SILTPOKE_TARBALL_URL:-https://github.com/Siltpoke/siltpoke/releases/latest/download/siltpoke.tar.gz}"
  APP_DIR="${SILTPOKE_HOME:-$HOME/.siltpoke}/app"
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
    echo "siltpoke: installing Bun (required runtime)…"
    BUN_TMP="$(mktemp -d)"
    curl -fsSL --proto '=https' --tlsv1.2 https://bun.sh/install -o "$BUN_TMP/bun-install.sh"
    bash "$BUN_TMP/bun-install.sh"
    rm -rf "$BUN_TMP"
    export PATH="$HOME/.bun/bin:$PATH"
  fi

  echo "siltpoke: starting setup…"
  exec bun "$APP_DIR/src/cli/bootstrap.ts" "$@"
}
__siltpoke_main "$@"
