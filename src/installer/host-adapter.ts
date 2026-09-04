// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
// Copyright (c) 2026 Jiaqi Duan
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { atomicWrite } from "../utils/atomic-write";
import type { AgentPresence } from "./agent-detect";
import type { SupportedAgent } from "./agent-types";
import { installCodexIntegration } from "./codex-integration";
import {
  hostCommandsDirPath,
  hostSettingsJsonPath,
  resolveAgyHooksJsonPath,
  resolveAntigravityHome,
  resolveCodebuddyHome,
  resolveCodexHome,
  resolveQoderHome,
} from "./paths";
import { registerSessionStartHook } from "./register-session-start";
import { registerStopHookPair, type StopHookPair } from "./settings-mutator";

/** Daemon Stop endpoint — same contract for every host (src/daemon/routes/hooks.ts). */
const DAEMON_STOP_URL = "http://127.0.0.1:9876/hooks/stop";

/** Shared, host-independent values computed once by the installer. */
export interface HostWireContext {
  /** Absolute repo root — adapters derive their bun-hook command paths from it. */
  repoRoot: string;
  /** siltpoke daemon secret, shared across settings.json hosts (codex ignores it). */
  secret: string;
}

/** A siltpoke host integration. CC-fork hosts are produced by ccForkHostAdapter. */
export interface HostAdapter {
  id: SupportedAgent;
  label: string;
  /** binary probed by `command -v` / `where`. */
  probeBin: string;
  /** which AgentPresence field indicates this host is installed. */
  presenceKey: keyof AgentPresence;
  settingsPath: (env: NodeJS.ProcessEnv) => string;
  commandsDir: (env: NodeJS.ProcessEnv) => string;
  detect: (presence: AgentPresence) => boolean;
  /** Write Stop + SessionStart hooks into the host's settings.json. */
  writeHooks: (
    env: NodeJS.ProcessEnv,
    ctx: HostWireContext,
  ) => Promise<{ path: string }>;
}

function bunHookCommand(repoRoot: string, script: string): string {
  return `bun ${join(repoRoot, "src", "hooks", script)}`;
}

function readJsonOrEmpty(path: string): Record<string, unknown> {
  if (!existsSync(path)) return {};
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8"));
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

interface CcForkOpts {
  id: SupportedAgent;
  label: string;
  probeBin: string;
  presenceKey: keyof AgentPresence;
  resolveHome: (env: NodeJS.ProcessEnv) => string;
  /** Stop-hook script under src/hooks/ (default on-stop.ts; agy passes agy-stop.ts). */
  stopScript?: string;
}

/**
 * Factory for Claude-Code-fork hosts (codebuddy, qoder). They share Claude's
 * settings.json hook schema, so writeHooks reuses the exact claude mutators
 * (registerStopHookPair + registerSessionStartHook), repointed to the fork's
 * own config home. No statusline swap (Global Constraints): hooks only.
 */
export function ccForkHostAdapter(opts: CcForkOpts): HostAdapter {
  const stopScript = opts.stopScript ?? "on-stop.ts";
  const settingsPath = (env: NodeJS.ProcessEnv): string =>
    hostSettingsJsonPath(opts.resolveHome(env));
  const commandsDir = (env: NodeJS.ProcessEnv): string =>
    hostCommandsDirPath(opts.resolveHome(env));
  return {
    id: opts.id,
    label: opts.label,
    probeBin: opts.probeBin,
    presenceKey: opts.presenceKey,
    settingsPath,
    commandsDir,
    detect: (presence) => presence[opts.presenceKey] === true,
    writeHooks: async (env, ctx) => {
      const path = settingsPath(env);
      const existing = readJsonOrEmpty(path);
      const stopPair: StopHookPair = {
        httpUrl: DAEMON_STOP_URL,
        command: bunHookCommand(ctx.repoRoot, stopScript),
        secret: ctx.secret,
      };
      const withStop = registerStopHookPair(existing, stopPair);
      const withSession = registerSessionStartHook(
        withStop,
        bunHookCommand(ctx.repoRoot, "handle-session-start.ts"),
      );
      atomicWrite(path, `${JSON.stringify(withSession, null, 2)}\n`);
      return { path };
    },
  };
}

export const codebuddyAdapter: HostAdapter = ccForkHostAdapter({
  id: "codebuddy",
  label: "CodeBuddy",
  probeBin: "codebuddy",
  presenceKey: "codebuddy",
  resolveHome: resolveCodebuddyHome,
});

export const qoderAdapter: HostAdapter = ccForkHostAdapter({
  id: "qodercli",
  label: "Qoder",
  probeBin: "qodercli",
  presenceKey: "qodercli",
  resolveHome: resolveQoderHome,
});

export const ccForkAdapters: readonly HostAdapter[] = [
  codebuddyAdapter,
  qoderAdapter,
];

/**
 * Codex is NOT a CC-fork — it writes ~/.codex/hooks.json (its own schema) via
 * the shipped, tested installCodexIntegration. This adapter thin-wraps it so
 * codex flows through the same registry + dispatch as the CC-fork hosts, with
 * zero rewrite of codex's hook schema.
 */
export const codexHostAdapter: HostAdapter = {
  id: "codex",
  label: "Codex",
  probeBin: "codex",
  presenceKey: "codex",
  settingsPath: (env) => join(resolveCodexHome(env), "hooks.json"),
  commandsDir: (env) => resolveCodexHome(env), // codex has no separate commands dir; unused by dispatch
  detect: (presence) => presence.codex === true,
  writeHooks: async (env, ctx) => {
    const r = await installCodexIntegration(ctx.repoRoot, env);
    return { path: r.hooks_path };
  },
};

interface AgyHookEntry {
  type: "command";
  command: string;
  timeout?: number;
}

const AGY_HOOK_NAME = "siltpoke-review";

/**
 * Read-modify-write ~/.gemini/config/hooks.json. Touches ONLY the
 * "siltpoke-review" top-level key — every other named hook the user (or
 * another tool) registered is read, cloned, and re-written byte-for-byte
 * untouched (round-trip tested). agy's Stop value is a FLAT array of
 * {type,command,timeout} handlers — no matcher wrapper, unlike Claude/codex
 * (T2 spike, design doc §3).
 */
export async function writeAgyHooksJson(
  hooksPath: string,
  stopCommand: string,
): Promise<{ path: string }> {
  const config = readJsonOrEmpty(hooksPath);
  const next: Record<string, unknown> = {
    ...config,
    [AGY_HOOK_NAME]: {
      Stop: [{ type: "command", command: stopCommand, timeout: 30 } satisfies AgyHookEntry],
    },
  };
  atomicWrite(hooksPath, `${JSON.stringify(next, null, 2)}\n`);
  return { path: hooksPath };
}

interface AgySettingsShape {
  hooks?: unknown;
  statusLine?: { type?: string; command?: unknown };
  [key: string]: unknown;
}

/**
 * Clean the orphaned Claude-shaped `hooks` key some machines carry in
 * ~/.gemini/antigravity-cli/settings.json — a manual probe rig from before
 * agy's real hooks.json mechanism was found (design doc §2, T1: this shape
 * never fired; agy has no Claude-shaped settings.json hook schema). Every
 * other key, including `statusLine`, is preserved; `statusLine.command` is
 * refreshed to the wrapper.ts --agent antigravity face command so the pet
 * renders even on a machine that never had a statusLine before.
 */
export async function cleanAgyOrphanSettings(
  settingsPath: string,
  wrapperCommand: string,
): Promise<{ path: string; hooksRemoved: boolean }> {
  const current = readJsonOrEmpty(settingsPath) as AgySettingsShape;
  const hooksRemoved = current.hooks !== undefined;
  const { hooks: _droppedOrphanHooks, ...rest } = current;
  const next: AgySettingsShape = {
    ...rest,
    statusLine: { type: "command", command: wrapperCommand },
  };
  atomicWrite(settingsPath, `${JSON.stringify(next, null, 2)}\n`);
  return { path: settingsPath, hooksRemoved };
}

/**
 * Antigravity (agy) is neither a CC-fork (ccForkHostAdapter) nor
 * settings.json-hooks-shaped like codex — it has its own name-keyed
 * hooks.json (writeAgyHooksJson) plus an orphan-cleanup step no other host
 * needs (cleanAgyOrphanSettings). `commandsDir` points at antigravityHome
 * for interface completeness but is unused by dispatch — agy is excluded
 * from symlinkCommands the same way codex is (src/cli/install.ts Task 6).
 */
export const agyHostAdapter: HostAdapter = {
  id: "antigravity",
  label: "Antigravity",
  probeBin: "agy",
  presenceKey: "antigravity",
  settingsPath: (env) => resolveAgyHooksJsonPath(env),
  commandsDir: (env) => resolveAntigravityHome(env),
  detect: (presence) => presence.antigravity === true,
  writeHooks: async (env, ctx) => {
    const hooksPath = resolveAgyHooksJsonPath(env);
    const settingsPath = join(resolveAntigravityHome(env), "settings.json");
    const stopCommand = bunHookCommand(ctx.repoRoot, "agy-stop.ts");
    const wrapperCommand = `bun ${join(ctx.repoRoot, "src", "face", "wrapper.ts")} --agent antigravity`;
    await writeAgyHooksJson(hooksPath, stopCommand);
    await cleanAgyOrphanSettings(settingsPath, wrapperCommand);
    return { path: hooksPath };
  },
};

export const secondaryHostAdapters: readonly HostAdapter[] = [
  codexHostAdapter,
  codebuddyAdapter,
  qoderAdapter,
  agyHostAdapter,
];
