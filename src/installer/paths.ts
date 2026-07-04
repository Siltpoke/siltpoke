// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
// Copyright (c) 2026 Jiaqi Duan
import { join } from "node:path";

export class PathError extends Error {}

function homeDir(env: NodeJS.ProcessEnv): string {
  const home = env.HOME ?? env.USERPROFILE;
  if (!home || home.length === 0) {
    throw new PathError("HOME environment variable is not set");
  }
  return home;
}

export function resolveClaudeHome(
  env: NodeJS.ProcessEnv = process.env,
): string {
  const override = env.CLAUDE_HOME;
  if (typeof override === "string" && override.length > 0) {
    return override;
  }
  return join(homeDir(env), ".claude");
}

export function siltpokeRoot(
  env: NodeJS.ProcessEnv = process.env,
): string {
  const override = env.SILTPOKE_HOME;
  if (typeof override === "string" && override.length > 0) {
    return override;
  }
  return join(homeDir(env), ".siltpoke");
}

export function settingsJsonPath(
  env: NodeJS.ProcessEnv = process.env,
): string {
  return join(resolveClaudeHome(env), "settings.json");
}

export function commandsDirPath(
  env: NodeJS.ProcessEnv = process.env,
): string {
  return join(resolveClaudeHome(env), "commands");
}
