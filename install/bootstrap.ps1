# SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
# siltpoke bootstrap — one-command installer entry (Windows).
# Entire body is inside Main so a truncated download cannot execute.
function Main {
  $ErrorActionPreference = "Stop"
  [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

  $TarballUrl = if ($env:SILTPOKE_TARBALL_URL) { $env:SILTPOKE_TARBALL_URL } else { "https://github.com/Siltpoke/siltpoke/releases/latest/download/siltpoke.tar.gz" }
  $Home_ = if ($env:SILTPOKE_HOME) { $env:SILTPOKE_HOME } else { Join-Path $HOME ".siltpoke" }
  $AppDir = Join-Path $Home_ "app"
  # Install receipt note about bun (spec 2.3): this script runs before any siltpoke
  # code exists, so it leaves one line of JSON that the first TS run merges into
  # receipt.json and deletes. byUs = bun was NOT on PATH before we acted; "pending"
  # = the bun installer started and has not finished. ASCII on purpose: Windows
  # PowerShell's UTF8 adds a byte-order mark (the TS side tolerates one anyway).
  $BunNote = Join-Path $Home_ "receipt-bootstrap.json"
  $Tmp = Join-Path ([IO.Path]::GetTempPath()) ("siltpoke-" + [Guid]::NewGuid())
  New-Item -ItemType Directory -Force -Path $Tmp | Out-Null
  $Tarball = Join-Path $Tmp "siltpoke.tar.gz"

  Write-Host "siltpoke: downloading source…"
  Invoke-WebRequest -Uri $TarballUrl -OutFile $Tarball -UseBasicParsing

  Write-Host "siltpoke: verifying checksum…"
  $Expected = if ($env:SILTPOKE_TARBALL_SHA256) { $env:SILTPOKE_TARBALL_SHA256 } else {
    (Invoke-WebRequest -Uri "$TarballUrl.sha256" -UseBasicParsing).Content.Trim().Split(" ")[0]
  }
  $Actual = (Get-FileHash -Algorithm SHA256 -Path $Tarball).Hash.ToLower()
  if ($Actual -ne $Expected.ToLower()) {
    Remove-Item -Recurse -Force $Tmp
    throw "siltpoke: checksum mismatch — refusing to install ($Actual != $Expected)"
  }

  New-Item -ItemType Directory -Force -Path $AppDir | Out-Null
  tar -xzf $Tarball -C $AppDir --strip-components=1
  Remove-Item -Recurse -Force $Tmp

  if (-not (Get-Command bun -ErrorAction SilentlyContinue)) {
    # [63] Ask before installing anything. --yes says yes; with no console to ask on (and
    # no --yes) we do not guess: say how, and stop (bun is what runs the rest).
    # UNTESTED on Windows: under `irm | iex` the script text is not on stdin, so
    # Read-Host reads the console host directly - that is the part to check on the box.
    $BunOk = ($args -contains "--yes") -or ($env:SILTPOKE_YES -eq "1")
    if (-not $BunOk) {
      if ([Environment]::UserInteractive -and -not [Console]::IsInputRedirected) {
        $Answer = Read-Host "siltpoke needs Bun (its runtime) and it is not installed. Install it now? [Y/n]"
        $BunOk = ($Answer -eq "" -or $Answer -match '^(y|yes)$')
      } else {
        Write-Host "siltpoke: no console to ask on, so not installing Bun."
      }
    }
    if (-not $BunOk) {
      throw "siltpoke: Bun is required. Install it (irm bun.sh/install.ps1 | iex) and re-run, or re-run with the environment variable SILTPOKE_YES set to 1 (a piped one-liner cannot take an argument)."
    }
    Write-Host "siltpoke: installing Bun (required runtime)…"
    Set-Content -Path $BunNote -Value '{"id":"tool:bun","byUs":true,"state":"pending"}' -Encoding ascii
    irm https://bun.sh/install.ps1 | iex
    $env:PATH = "$HOME\.bun\bin;$env:PATH"
    Set-Content -Path $BunNote -Value '{"id":"tool:bun","byUs":true,"state":"done"}' -Encoding ascii
  } elseif (-not (Test-Path $BunNote)) {
    # Already there before us. (An existing note is a pending one from an earlier
    # run that did install it - leave that one alone.)
    Set-Content -Path $BunNote -Value '{"id":"tool:bun","byUs":false,"state":"done"}' -Encoding ascii
  }

  Write-Host "siltpoke: starting setup…"
  bun (Join-Path $AppDir "src\cli\bootstrap.ts") @args
}
Main @args
