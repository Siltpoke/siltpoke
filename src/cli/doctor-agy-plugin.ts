// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
// Copyright (c) 2026 Jiaqi Duan
/**
 * Does the agy PLUGIN ship a Stop hook for siltpoke?
 *
 * WHY — audit defect `[55]`: `doctor` printed "Antigravity not wired" while
 * agy's Stop hook was firing that day. The agy row only read the global
 * `~/.gemini/config/hooks.json`; a plugin install carries its own
 * `<plugin root>/hooks.json` (declared by `plugin.json` `"hooks": "./hooks.json"`,
 * source `.antigravity-plugin/hooks.json`), which the row never opened.
 *
 * The plugin root comes from `resolveAgyPluginRoot()` — the one resolver the
 * statusline and plugin-host detection already use — never a second path list.
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { resolveAgyPluginRoot } from "../installer/paths";
import type { CheckResult } from "./doctor";

/** The plugin's hooks.json names its Stop hook script `agy-stop.sh`. */
const AGY_STOP_SCRIPT = "agy-stop.sh";

/**
 * Where to look for the plugin root. An explicit `agyPluginRoot` wins. Otherwise,
 * if the caller pinned a hooks.json path, the plugin lives beside it in the
 * same config dir (exactly how `resolveAgyPluginRoot` derives it from
 * `ANTIGRAVITY_HOOKS_HOME`), so a pinned hooks.json can never leak the real
 * `~/.gemini` into the answer.
 */
export function agyPluginRootFor(opts: { agyPluginRoot?: string; agyHooksJsonPath?: string }): string {
  if (opts.agyPluginRoot) return opts.agyPluginRoot;
  if (opts.agyHooksJsonPath) return join(dirname(opts.agyHooksJsonPath), "plugins", "siltpoke");
  return resolveAgyPluginRoot();
}

/**
 * The agy row: the global-hooks.json result stands if it is a real pass;
 * otherwise a plugin-shipped Stop hook turns it into a pass that names the
 * plugin path, and only if neither is wired does the global result (info "not
 * wired", or a red for a broken global file) stand.
 */
export function withAgyPluginFallback(
  global: CheckResult,
  agyHooksJsonPath?: string,
): CheckResult {
  if (global.pass && global.status !== "info") return global;
  const root = agyPluginRootFor({ agyHooksJsonPath });
  if (!agyPluginStopWired(root)) return global;
  return { name: `agy Stop hook registered (via the agy plugin, ${join(root, "hooks.json")})`, pass: true, detail: null };
}

/**
 * True only when `<root>/hooks.json` parses and `hooks.Stop` holds a command
 * entry running `agy-stop.sh`. A plugin dir without that entry, or an unreadable
 * file, is NOT wired.
 */
export function agyPluginStopWired(pluginRoot: string): boolean {
  const file = join(pluginRoot, "hooks.json");
  if (!existsSync(file)) return false;
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return false;
  }
  const hooks = (parsed as { hooks?: { Stop?: unknown } } | null)?.hooks;
  const stop = hooks && Array.isArray(hooks.Stop) ? hooks.Stop : [];
  return stop.some((h) => {
    const e = h as { type?: unknown; command?: unknown } | null;
    return e?.type === "command" && typeof e.command === "string" && e.command.includes(AGY_STOP_SCRIPT);
  });
}
