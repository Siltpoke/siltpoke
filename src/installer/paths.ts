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

export function resolveCodexHome(
  env: NodeJS.ProcessEnv = process.env,
): string {
  const override = env.CODEX_HOME;
  if (typeof override === "string" && override.length > 0) {
    return override;
  }
  return join(homeDir(env), ".codex");
}

export function codexHooksJsonPath(
  env: NodeJS.ProcessEnv = process.env,
): string {
  return join(resolveCodexHome(env), "hooks.json");
}

export function resolveCodebuddyHome(
  env: NodeJS.ProcessEnv = process.env,
): string {
  const override = env.CODEBUDDY_HOME;
  if (typeof override === "string" && override.length > 0) {
    return override;
  }
  return join(homeDir(env), ".codebuddy");
}

export function resolveQoderHome(
  env: NodeJS.ProcessEnv = process.env,
): string {
  const override = env.QODER_HOME;
  if (typeof override === "string" && override.length > 0) {
    return override;
  }
  return join(homeDir(env), ".qoder");
}

export function resolveAntigravityHome(
  env: NodeJS.ProcessEnv = process.env,
): string {
  const override = env.ANTIGRAVITY_HOME ?? env.GEMINI_HOME;
  if (typeof override === "string" && override.length > 0) {
    return override;
  }
  return join(homeDir(env), ".gemini", "antigravity-cli");
}

/**
 * agy's real Stop-hook config lives at ~/.gemini/config/hooks.json — a
 * SIBLING of antigravity-cli/, not nested under it (T2 spike,
 * an internal design note §2/§3).
 * Deliberately does NOT derive from resolveAntigravityHome() for this
 * reason — the two directories are independent.
 */
export function resolveAgyHooksJsonPath(
  env: NodeJS.ProcessEnv = process.env,
): string {
  const override = env.ANTIGRAVITY_HOOKS_HOME;
  if (typeof override === "string" && override.length > 0) {
    return join(override, "hooks.json");
  }
  return join(homeDir(env), ".gemini", "config", "hooks.json");
}

/** settings.json under a host config home (CC-fork hosts share Claude's layout). */
export function hostSettingsJsonPath(home: string): string {
  return join(home, "settings.json");
}

/** slash-commands dir under a host config home. */
export function hostCommandsDirPath(home: string): string {
  return join(home, "commands");
}
