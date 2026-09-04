// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
// Copyright (c) 2026 Jiaqi Duan
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { detectPrereqs, type Exec, type PrereqStatus } from "./prereq";

export interface PreflightReport {
  settingsOk: boolean;
  settingsExisted: boolean;
  prereqs: PrereqStatus[];
  refuse: string | null;
}

export function preflight(
  exec: Exec,
  claudeHome: string,
  platform: NodeJS.Platform = process.platform,
): PreflightReport {
  const settingsPath = join(claudeHome, "settings.json");
  const settingsExisted = existsSync(settingsPath);
  let settingsOk = true;
  let refuse: string | null = null;
  if (settingsExisted) {
    try { JSON.parse(readFileSync(settingsPath, "utf8")); }
    catch { settingsOk = false; refuse = `Existing settings.json is not valid JSON: ${settingsPath} — fix or remove it before installing.`; }
  }
  return { settingsOk, settingsExisted, prereqs: detectPrereqs(exec, undefined, platform), refuse };
}
