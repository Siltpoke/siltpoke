// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
// Copyright (c) 2026 Jiaqi Duan
/**
 * Plugin-owned Stop hook detection — split out of doctor.ts to keep that
 * file from growing past its LOC ratchet.
 *
 * In the plugin-install era, `hooks/hooks.json` (committed at the repo root,
 * copied to `${CLAUDE_PLUGIN_ROOT}/hooks/hooks.json` on install) — not
 * `~/.claude/settings.json` — owns the Stop hook (see hooks/hooks.json +
 * hooks/stop.sh). A healthy plugin install therefore has an EMPTY
 * `settings.json` `hooks.Stop[]` — that's expected, not a fault. This module
 * answers "does the plugin's own manifest declare a Stop hook", so
 * `checkStopHook` in doctor.ts can treat that as sufficient for a pass
 * without asserting anything about settings.json.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { DoctorOptions } from "./doctor";

interface PluginHookEntryShape {
  type?: unknown;
  command?: unknown;
}
interface PluginHookMatcherShape {
  hooks?: PluginHookEntryShape[];
}

/**
 * Resolve the plugin's own hooks.json path. Defaults to
 * `${CLAUDE_PLUGIN_ROOT}/hooks/hooks.json`; injectable via
 * `opts.pluginHooksJsonPath` for tests (mirrors `opts.agyHooksJsonPath`).
 * Returns null when there's no plugin root to resolve against (non-plugin
 * install and no override supplied).
 */
export function resolvePluginHooksJsonPath(opts: DoctorOptions): string | null {
  if (typeof opts.pluginHooksJsonPath === "string" && opts.pluginHooksJsonPath.length > 0) {
    return opts.pluginHooksJsonPath;
  }
  const root = process.env.CLAUDE_PLUGIN_ROOT;
  if (typeof root !== "string" || root.length === 0) return null;
  return join(root, "hooks", "hooks.json");
}

/**
 * True iff the plugin's hooks.json exists, parses, and declares at least one
 * Stop matcher with a command hook. Any failure to resolve/read/parse — or a
 * declaration too malformed to trust — returns false rather than throwing,
 * so the caller falls through to the legacy settings.json check.
 */
export function pluginOwnsStopHook(opts: DoctorOptions): boolean {
  const path = resolvePluginHooksJsonPath(opts);
  if (path === null || !existsSync(path)) return false;
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return false;
  }
  if (typeof parsed !== "object" || parsed === null) return false;
  const stop = (parsed as { hooks?: { Stop?: unknown } }).hooks?.Stop;
  if (!Array.isArray(stop) || stop.length === 0) return false;
  return (stop as PluginHookMatcherShape[]).some(
    (m) =>
      Array.isArray(m?.hooks) &&
      m.hooks.some((h) => h?.type === "command" && typeof h.command === "string" && h.command.length > 0),
  );
}
