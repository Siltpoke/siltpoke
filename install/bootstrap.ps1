# SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
# siltpoke bootstrap — one-command installer entry (Windows).
# Entire body is inside Main so a truncated download cannot execute.
function Main {
  $ErrorActionPreference = "Stop"
  [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

  $TarballUrl = if ($env:SILTPOKE_TARBALL_URL) { $env:SILTPOKE_TARBALL_URL } else { "https://github.com/Siltpoke/siltpoke/releases/latest/download/siltpoke.tar.gz" }
  $Home_ = if ($env:SILTPOKE_HOME) { $env:SILTPOKE_HOME } else { Join-Path $HOME ".siltpoke" }
  $AppDir = Join-Path $Home_ "app"
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
    Write-Host "siltpoke: installing Bun (required runtime)…"
    irm https://bun.sh/install.ps1 | iex
    $env:PATH = "$HOME\.bun\bin;$env:PATH"
  }

  Write-Host "siltpoke: starting setup…"
  bun (Join-Path $AppDir "src\cli\bootstrap.ts") @args
}
Main @args
