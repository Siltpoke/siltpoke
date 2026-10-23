// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
// Copyright (c) 2026 Jiaqi Duan
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { resolveAgyPluginRoot, resolveClaudeHome, resolveCodebuddyHome, resolveQoderHome } from "./paths";

/**
 * Which hosts still have the siltpoke plugin installed (defect [61]).
 *
 * The question behind `--purge`: can anything still write ~/.siltpoke? The data
 * folder is shared by every host, so "Claude Code no longer lists the plugin"
 * is not enough — a plugin still installed in codebuddy or codex keeps its
 * hooks, and they would write the folder straight back.
 *
 * A plugin cache directory that exists proves nothing (Claude Code keeps it
 * after an uninstall, marked `.orphaned_at`), so each host is asked through its
 * own record of what is installed.
 */
interface PluginHosts {
  /** Display names of the hosts that still list siltpoke. */
  hosts: string[];
  /**
   * False when NO host gave an answer at all. Then nothing is known, and a
   * caller must not treat an empty `hosts` as "gone".
   */
  known: boolean;
}

/** `null` = could not tell (no such host, or its record cannot be read). */
export type HostAnswer = boolean | null;

function lists(registryPath: string): HostAnswer {
  try {
    return readFileSync(registryPath, "utf8").includes('"siltpoke@');
  } catch {
    return null;
  }
}

/** The first definite answer among several files a host may use. */
function anyOf(...answers: HostAnswer[]): HostAnswer {
  if (answers.some((a) => a === true)) return true;
  return answers.some((a) => a === false) ? false : null;
}

/**
 * Codex keeps no registry file to read (its `config.toml` mentions of siltpoke
 * are project-trust entries), so it has to be asked. Same query, same shape,
 * as the skill's own lookup (`skills/siltpoke/SKILL.md`).
 */
export function codexListsPlugin(): HostAnswer {
  const r = spawnSync("codex", ["plugin", "list", "--json"], { encoding: "utf8", timeout: 5000 });
  if (r.error || r.status !== 0) return null;
  return parseCodexPluginList(r.stdout);
}

/**
 * `false` only when the output has the shape we know and siltpoke is not in it.
 * Any other shape is `null`: a wrong "not installed" lets a purge through, a
 * wrong "cannot tell" only makes the user delete the folder by hand.
 */
export function parseCodexPluginList(stdout: string): HostAnswer {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    return null;
  }
  const installed = (parsed as { installed?: unknown } | null)?.installed;
  if (!Array.isArray(installed)) return null;
  return installed.some((p) => (p as { name?: unknown } | null)?.name === "siltpoke");
}

const CLAUDE_UNINSTALL = "claude plugin uninstall siltpoke";
const IN_PROJECT = "In the project folder you installed it for";
/**
 * Inside double quotes a shell still acts on these (`!` is history expansion
 * in an interactive bash or zsh), and a control character must not reach the
 * terminal raw. A path holding one is named in words instead of in a command.
 * PowerShell and cmd take `\` and `!` literally — there `\` is the separator.
 */
// biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are what this refuses
const UNSAFE_IN_QUOTES = { posix: /["$`\\!\x00-\x1f\x7f]/, win32: /["$`%\x00-\x1f\x7f]/ };

/** The lines that remove one project-scoped install. */
function projectUninstall(scope: string, projectPath: unknown, platform: NodeJS.Platform): string[] {
  const command = `${CLAUDE_UNINSTALL} --scope ${scope}`;
  if (typeof projectPath !== "string" || projectPath === "") return [`${IN_PROJECT}:`, command];
  const windows = platform === "win32";
  if ((windows ? UNSAFE_IN_QUOTES.win32 : UNSAFE_IN_QUOTES.posix).test(projectPath)) {
    // Shown with anything unprintable escaped; JSON.stringify leaves DEL as it is.
    return [`${IN_PROJECT} (${JSON.stringify(projectPath).replaceAll("\x7f", "\\u007f")}):`, command];
  }
  // Two lines on Windows: `&&` is not PowerShell 5 syntax. Elsewhere one line
  // in a subshell, so pasting it does not leave the user's shell in the project.
  return windows ? [`cd "${projectPath}"`, command] : [`(cd "${projectPath}" && ${command})`];
}

/**
 * The lines to type to remove siltpoke from Claude Code, for each install it
 * records (defect [82]). Claude Code removes a plugin only from the scope it is
 * told (`user` when not told), and a `project` or `local` install only when
 * run inside that project's folder: the plain command answers "is not
 * installed in user scope" for those (measured 2026-10-08).
 *
 * A record that cannot be read gives the plain command: it is right for the
 * install most people have, and Claude Code's own error names `--scope`.
 */
export function claudeUninstallCommands(env: NodeJS.ProcessEnv, platform: NodeJS.Platform = process.platform): string[] {
  // One entry per distinct install; an entry may be two lines.
  const found = new Set<string>();
  for (const install of claudeInstallRecords(env)) {
    const { scope, projectPath } = (install ?? {}) as { scope?: unknown; projectPath?: unknown };
    if (scope !== "local" && scope !== "project") found.add(CLAUDE_UNINSTALL);
    else found.add(projectUninstall(scope, projectPath, platform).join("\n"));
  }
  return found.size > 0 ? [...found].flatMap((lines) => lines.split("\n")) : [CLAUDE_UNINSTALL];
}

/** Every install of a siltpoke plugin in Claude Code's record, from any marketplace; none when it cannot be read. */
function claudeInstallRecords(env: NodeJS.ProcessEnv): unknown[] {
  let plugins: unknown;
  try {
    const registry = join(resolveClaudeHome(env), "plugins", "installed_plugins.json");
    plugins = (JSON.parse(readFileSync(registry, "utf8")) as { plugins?: unknown } | null)?.plugins;
  } catch {
    return [];
  }
  if (typeof plugins !== "object" || plugins === null) return [];
  return Object.entries(plugins).flatMap(([id, installs]) => (id.startsWith("siltpoke@") && Array.isArray(installs) ? installs : []));
}

export function hostsWithPlugin(env: NodeJS.ProcessEnv, askCodex: () => HostAnswer): PluginHosts {
  // qoder has used both file names (seen 2026-10-02: `installed_plugins_v2.json`).
  const qoderPlugins = join(resolveQoderHome(env), "plugins");
  const answers: Array<[string, HostAnswer]> = [
    ["Claude Code", lists(join(resolveClaudeHome(env), "plugins", "installed_plugins.json"))],
    ["CodeBuddy", lists(join(resolveCodebuddyHome(env), "plugins", "installed_plugins.json"))],
    [
      "Qoder",
      anyOf(lists(join(qoderPlugins, "installed_plugins.json")), lists(join(qoderPlugins, "installed_plugins_v2.json"))),
    ],
    ["Codex", askCodex()],
    // agy has no registry file; an installed plugin IS its directory. A missing
    // directory is not an answer about agy — most machines simply have no agy.
    ["Antigravity", existsSync(resolveAgyPluginRoot(env)) ? true : null],
  ];
  return {
    hosts: answers.filter(([, a]) => a === true).map(([name]) => name),
    known: answers.some(([, a]) => a !== null),
  };
}
