// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
// Copyright (c) 2026 Jiaqi Duan
import type { PrereqStatus } from "./prereq";

function installLabel(name: string, platform: NodeJS.Platform): string {
  if (name === "git") {
    return platform === "win32" ? "install git (winget)" : "install git (Xcode Command Line Tools)";
  }
  if (name === "bun") {
    return platform === "win32" ? "install bun (powershell)" : "install bun (curl)";
  }
  return `install ${name}`;
}

export function buildInstallPlan(prereqs: PrereqStatus[], platform: NodeJS.Platform): string[] {
  return [
    ...prereqs
      .filter((p) => !p.present && (p.name === "bun" || p.name === "git"))
      .map((p) => installLabel(p.name, platform)),
    "back up + wire ~/.claude/settings.json",
    "install siltpoke core (runInstall)",
  ];
}
