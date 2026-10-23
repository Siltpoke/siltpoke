// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
// Copyright (c) 2026 Jiaqi Duan
/**
 * agy's "run setup" hint, delivered on the statusline.
 *
 * WHY NOT THE STOP HOOK'S OUTPUT. Measured 2026-09-29 in a real interactive
 * agy session (install audit §50): a Stop hook's stderr, a
 * `{"systemMessage": …}` line, and `{"decision":"stop","reason": …}` all ran
 * and all reached the screen 0 times. agy's Stop-hook response schema has
 * only `decision` and `reason`; there is no field meant for the user. The old
 * stderr nudge was therefore invisible while its marker burned it for good —
 * defect [33]'s shape on a different host.
 *
 * WHAT agy DOES RENDER is `statusLine.command` in
 * ~/.gemini/antigravity-cli/settings.json (measured the same day). Setup wires
 * that to the pet; before setup it is usually absent. So the first Stop before
 * setup points it at a one-line hint. agy reads settings at launch, so the
 * hint shows from the NEXT agy start, and goes blank once setup has run (see
 * hintCommand for why it cannot rely on setup replacing it).
 *
 * Three rules, each with a test in tests/hooks/agy-setup-hint.test.ts:
 *   - An existing statusLine — the user's, another tool's, an old pet — is
 *     never touched.
 *   - Offered once: a hint the user deleted is not put back (the marker).
 *   - An unreadable settings.json is left alone and NOT marked, so the hint
 *     can still arrive once the user fixes the file.
 */
import { existsSync, lstatSync, readFileSync, statSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { resolveAntigravityHome, siltpokeRoot } from "../installer/paths";
import { atomicWrite } from "../utils/atomic-write";

/** Names no slash command: agy has none (defect [8]). */
export const AGY_HINT_TEXT =
  'siltpoke: installed. Ask your agent to "set up Siltpoke" to meet your pet';

const MARKER = ".agy-setup-hint";

/** POSIX single-quote a value for a `sh -c` command string. */
export function shQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/**
 * The statusline command. It drains agy's JSON on stdin and prints the hint
 * only while (a) the plugin directory still exists — an uninstalled plugin
 * leaves a blank line, not a hint for something gone — and (b) setup has not
 * run. (b) cannot be left to setup replacing the line: the plugin-path setup
 * (skills/siltpoke/SKILL.md step 4, dist/siltpoke-configure.js) wires only
 * Claude Code's statusline and never touches agy's, so without this check the
 * hint would stay up forever after the user did exactly what it asked.
 */
export function hintCommand(pluginRoot: string, configPath: string): string {
  // `; true`: when the hint is suppressed the `&&` chain exits 1, and how agy
  // renders a failing statusline command was never measured. Always exit 0.
  return `cat >/dev/null; [ -d ${shQuote(pluginRoot)} ] && [ ! -f ${shQuote(configPath)} ] && printf '%s' ${shQuote(AGY_HINT_TEXT)}; true`;
}

/** Settings as an object, `null` when the file exists but cannot be trusted. */
export function readSettings(path: string): Record<string, unknown> | null {
  if (!existsSync(path)) return {};
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
    return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
}

function ensureSetupHint(env: NodeJS.ProcessEnv, pluginRoot: string): void {
  if (!isAbsolute(pluginRoot)) return;
  const root = siltpokeRoot(env);
  const marker = join(root, MARKER);
  if (existsSync(marker)) return;

  const settingsPath = join(resolveAntigravityHome(env), "settings.json");
  // A symlinked settings.json (a dotfiles setup) is left alone for good: the
  // atomic rename below would replace the link with a plain file and cut the
  // user's dotfiles repo off from agy. Marked, because it will not change.
  if (isSymlink(settingsPath)) {
    markOffered(marker);
    return;
  }
  const settings = readSettings(settingsPath);
  if (settings === null) return; // leave it, and do not mark — retried later

  if (!("statusLine" in settings)) {
    const next = { ...settings, statusLine: { type: "command", command: hintCommand(pluginRoot, join(root, "config.json")) } };
    const mode = existsSync(settingsPath) ? statSync(settingsPath).mode & 0o777 : undefined;
    atomicWrite(settingsPath, `${JSON.stringify(next, null, 2)}\n`, mode === undefined ? undefined : { mode });
    // agy rewrites this file while it runs. If it wrote from its own copy
    // between our read and our rename, the hint is gone — and marking it now
    // would repeat defect [33]'s "marked delivered, never shown". Mark only
    // what is actually on disk; otherwise the next turn tries again.
    const after = readSettings(settingsPath);
    if (after === null || !("statusLine" in after)) return;
  }
  markOffered(marker);
}

export function isSymlink(path: string): boolean {
  try {
    return lstatSync(path).isSymbolicLink();
  } catch {
    return false;
  }
}

function markOffered(marker: string): void {
  try {
    atomicWrite(marker, "");
  } catch {
    // Harmless: next time the statusLine is present, so nothing is written.
    // Only the user-deleted-it case relies on the marker.
  }
}

/** `bun dist/agy-stop.js --setup-hint <pluginRoot>`, called by hooks/agy-stop.sh. */
export function runSetupHintCli(argv: string[], env: NodeJS.ProcessEnv): void {
  const at = argv.indexOf("--setup-hint");
  try {
    ensureSetupHint(env, at >= 0 ? (argv[at + 1] ?? "") : "");
  } catch {
    // Silent by contract: nothing from a hook may reach the agy session.
  }
}
