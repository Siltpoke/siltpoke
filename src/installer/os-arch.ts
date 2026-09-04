// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
// Copyright (c) 2026 Jiaqi Duan

export function describePlatform(platform: NodeJS.Platform, arch: string): string {
  const osName =
    platform === "darwin" ? "macOS" : platform === "win32" ? "Windows" : platform === "linux" ? "Linux" : platform;
  let archName = arch;
  if (arch === "arm64") archName = platform === "darwin" ? "Apple Silicon (arm64)" : "arm64";
  else if (arch === "x64") archName = "x64";
  return `${osName} · ${archName}`;
}
