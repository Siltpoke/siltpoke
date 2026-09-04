// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
// Copyright (c) 2026 Jiaqi Duan
import { existsSync } from "node:fs";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { randomBytes } from "node:crypto";
import { codexHooksJsonPath, resolveCodexHome } from "./paths";

interface HookEntry {
  type?: string;
  command?: string;
  timeout?: number;
  statusMessage?: string;
}

interface HookMatcher {
  matcher?: string;
  hooks?: HookEntry[];
}

interface CodexHooksConfig {
  hooks?: Record<string, HookMatcher[] | undefined>;
  [key: string]: unknown;
}

async function atomicWriteJson(path: string, data: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.tmp.${process.pid}.${Date.now()}.${randomBytes(4).toString("hex")}`;
  await writeFile(tmp, JSON.stringify(data, null, 2), "utf8");
  await rename(tmp, path);
}

async function readJsonOrEmpty(path: string): Promise<CodexHooksConfig> {
  if (!existsSync(path)) return {};
  try {
    const parsed = JSON.parse(await readFile(path, "utf8"));
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
      ? parsed as CodexHooksConfig
      : {};
  } catch {
    return {};
  }
}

function ensureCommandHook(
  config: CodexHooksConfig,
  event: "SessionStart" | "Stop",
  matcher: string | undefined,
  entry: HookEntry,
): CodexHooksConfig {
  const next: CodexHooksConfig = JSON.parse(JSON.stringify(config));
  if (!next.hooks) next.hooks = {};
  const existingForEvent = next.hooks[event];
  const matchers = Array.isArray(existingForEvent) ? [...existingForEvent] : [];
  const idx = matchers.findIndex((m) => (m.matcher ?? "") === (matcher ?? ""));
  const target: HookMatcher =
    idx === -1 ? { ...(matcher ? { matcher } : {}), hooks: [] } : { ...matchers[idx] };
  const hooks = Array.isArray(target.hooks) ? [...target.hooks] : [];
  const withoutPrior = hooks.filter(
    (h) => !(h.type === "command" && h.command === entry.command),
  );
  target.hooks = [...withoutPrior, entry];
  if (idx === -1) {
    matchers.push(target);
  } else {
    matchers[idx] = target;
  }
  next.hooks[event] = matchers;
  return next;
}

// Source paths written by `installCodexIntegration` before the plugin
// carried its own hooks.json (Task 2). Once the plugin's own hooks.json is
// live, a legacy ~/.codex/hooks.json entry pointing at these paths is a
// STALE duplicate declaration, not a correctness hazard — the marker-based
// dedupe (src/daemon/marker.ts, wired in on-stop.ts) already collapses two
// hook processes firing for the same Stop event to one Brain call, keyed on
// session_id + transcript content hash (identical regardless of which
// hooks.json entry invoked the process). This removal is tidiness: it keeps
// `~/.codex/hooks.json` / `codex plugin list` free of a dead duplicate entry.
const LEGACY_COMMAND_MARKERS = [
  "src/hooks/codex-stop.ts",
  "src/hooks/handle-session-start.ts",
] as const;

function isLegacyCommand(command: string | undefined): boolean {
  if (!command) return false;
  return LEGACY_COMMAND_MARKERS.some((marker) => command.includes(marker));
}

/**
 * Strip any Stop/SessionStart hook entry in `hooksPath` whose command targets
 * the legacy source paths `installCodexIntegration` used to write, leaving
 * every other entry (including any foreign, non-siltpoke tool's hooks)
 * untouched. Fail-soft: a missing or malformed hooks.json is a silent no-op
 * (nothing to migrate), never a throw.
 */
export async function removeCodexLegacyHooks(hooksPath: string): Promise<void> {
  let config: CodexHooksConfig;
  try {
    config = await readJsonOrEmpty(hooksPath);
  } catch {
    return;
  }
  if (!config.hooks) return;

  let changed = false;
  const next: CodexHooksConfig = JSON.parse(JSON.stringify(config));
  for (const event of ["Stop", "SessionStart"] as const) {
    const matchers = next.hooks?.[event];
    if (!Array.isArray(matchers)) continue;
    const filtered = matchers
      .map((m) => {
        const hooks = Array.isArray(m.hooks) ? m.hooks : [];
        const kept = hooks.filter((h) => !isLegacyCommand(h.command));
        if (kept.length !== hooks.length) changed = true;
        return { ...m, hooks: kept };
      })
      // Drop matchers a legacy removal emptied out entirely — an
      // `{ hooks: [] }` stub is a smaller but still-visible piece of the
      // same staleness this function exists to clean up.
      .filter((m) => m.hooks.length > 0);
    if (!next.hooks) continue;
    if (filtered.length > 0) {
      next.hooks[event] = filtered;
    } else if (event in next.hooks) {
      // No matchers left for this event at all — drop the key rather than
      // leaving a dangling empty array.
      delete next.hooks[event];
    }
  }

  if (!changed) return;

  try {
    await atomicWriteJson(hooksPath, next);
  } catch {
    // best-effort — must never throw into a session
  }
}

export interface CodexIntegrationResult {
  codex_home: string;
  hooks_path: string;
  stop_command: string;
  session_start_command: string;
}

export async function installCodexIntegration(
  repoRoot: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<CodexIntegrationResult> {
  const hooksPath = codexHooksJsonPath(env);
  const stopCommand = `bun ${join(repoRoot, "src", "hooks", "codex-stop.ts")}`;
  const sessionStartCommand = `bun ${join(repoRoot, "src", "hooks", "handle-session-start.ts")}`;

  let config = await readJsonOrEmpty(hooksPath);
  config = ensureCommandHook(config, "SessionStart", "startup|resume", {
    type: "command",
    command: sessionStartCommand,
    timeout: 30,
    statusMessage: "Siltpoke captures the session baseline",
  });
  config = ensureCommandHook(config, "Stop", undefined, {
    type: "command",
    command: stopCommand,
    timeout: 30,
    statusMessage: "Siltpoke reviews the completed Codex turn",
  });
  await atomicWriteJson(hooksPath, config);

  return {
    codex_home: resolveCodexHome(env),
    hooks_path: hooksPath,
    stop_command: stopCommand,
    session_start_command: sessionStartCommand,
  };
}
