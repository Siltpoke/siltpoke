// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
// Copyright (c) 2026 Jiaqi Duan
/**
 * Is siltpoke installed in agy as a PLUGIN? (host detection only)
 *
 * WHY — audit defect `[67]`: `detectDoctorHost` only looked at `~/.claude`, the
 * global agy `hooks.json` and codex's `config.toml`. An agy install made through
 * the agy plugin has none of those (its hooks live in
 * `<agy config dir>/plugins/siltpoke/hooks.json`), so doctor defaulted to
 * `claude-code` and printed Claude Code rows and `/siltpoke:siltpoke-setup` advice —
 * the exact false output defect `[16]` removed for the global-hooks.json case.
 *
 * ORDER when several hosts are present: `~/.claude` first, then agy, then codex.
 * No per-host hint reaches doctor (every host runs the same
 * `siltpoke-cli.js doctor`; `SILTPOKE_HOST` is set only on the Stop/SessionStart
 * hooks, not on doctor), so the filesystem is all there is. A machine with both
 * `~/.claude` and an agy plugin therefore reports Claude Code — kept on purpose:
 * that is the established rule from `[16]`, and a real `~/.claude` user's rows
 * are real. (Since `[81]` that order applies only when the running copy is not
 * itself inside a host's folder — see `hostOfRunningCopy`.)
 *
 * Lives in its own module because `doctor.ts` is length-pinned. The plugin root
 * and the Stop-entry matcher are `[55]`'s (`doctor-agy-plugin.ts`), so the agy
 * row and host detection can never disagree about what "wired" means, and a
 * pinned `agyHooksJsonPath` can never leak the real `~/.gemini` into the answer.
 * Positive evidence only: the plugin's hooks.json must carry a Stop command that
 * runs `agy-stop.sh`; an empty or unrelated plugin dir is not agy.
 */
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { dirname, join, sep } from "node:path";
import {
  resolveAgyHooksJsonPath,
  resolveClaudeHome,
  resolveCodebuddyHome,
  resolveCodexHome,
  resolveQoderHome,
} from "../installer/paths";
import { agyPluginRootFor, agyPluginStopWired } from "./doctor-agy-plugin";

/** The host doctor answers for. qoder and codebuddy since `[89]`. */
export type DoctorHost = "claude-code" | "codex" | "antigravity" | "qoder" | "codebuddy";

/** The seams host detection reads; `DoctorOptions` carries all of them. */
interface HostProbes {
  claudeHome?: string;
  agyHooksJsonPath?: string;
  codexConfigPath?: string;
  qoderHome?: string;
  codebuddyHome?: string;
}

/**
 * The host whose own copy of Siltpoke this doctor is running from, or null.
 *
 * WHY — defect `[81]`: the note above ("no per-host hint reaches doctor … the
 * filesystem is all there is") missed one thing the filesystem does say: where
 * the running copy sits. Antigravity runs `<its plugin folder>/dist/siltpoke-cli.js`
 * and codex runs a copy under its own home, so a doctor started from either is
 * that host's — whatever else is installed on the machine. Without this, a
 * user with `~/.claude` who asked from Antigravity was told a plugin folder is
 * a broken repo, and one who asked from codex was told to `/plugin install`.
 *
 * Positive evidence only, like the rest of host detection: a copy anywhere
 * else (a source checkout, Claude Code's plugin cache) gives null, and the
 * machine is read as before.
 *
 * Defect `[89]`: Qoder and CodeBuddy keep their plugin copies in their own
 * homes too (`~/.qoder/plugins/cache/…`, `~/.codebuddy/plugins/cache/…`), and a
 * doctor run from either reported Claude Code's settings.json missing and
 * handed out `/siltpoke:siltpoke-setup` — measured with and without `~/.claude` present.
 */
export function hostOfRunningCopy(
  opts: HostProbes,
  root: string,
): "codex" | "antigravity" | "qoder" | "codebuddy" | null {
  if (isInside(root, agyPluginRootFor({ agyHooksJsonPath: opts.agyHooksJsonPath }))) return "antigravity";
  const claudeHome = opts.claudeHome ?? resolveClaudeHome();
  const homes: Array<["codex" | "qoder" | "codebuddy", string]> = [
    ["codex", opts.codexConfigPath ? dirname(opts.codexConfigPath) : resolveCodexHome()],
    ["qoder", opts.qoderHome ?? resolveQoderHome()],
    ["codebuddy", opts.codebuddyHome ?? resolveCodebuddyHome()],
  ];
  for (const [host, home] of homes) {
    // A host home that holds Claude Code's home too (CODEX_HOME=$HOME) says
    // nothing about whose copy this is: every copy on the machine is inside it.
    if (isInside(root, home) && !isInside(claudeHome, home)) return host;
  }
  return null;
}

/** Is `path` the folder `dir` or somewhere in it? Links resolved; false when either is not there. */
function isInside(path: string, dir: string): boolean {
  try {
    const [here, there] = [realpathSync(path), realpathSync(dir)];
    return here === there || here.startsWith(there + sep);
  } catch {
    return false; // one of them is not there — no evidence
  }
}

/**
 * Where a codex install is wired. A codex PLUGIN carries its own `hooks.json`
 * at its root; `~/.codex/hooks.json` is where the older from-source setup wrote
 * (and what the plugin's first SessionStart tidies away, handle-session-start.ts).
 * So a doctor running from codex's own copy names that copy's file.
 */
export function codexWiringPath(opts: HostProbes, root: string): string {
  const own = join(root, "hooks.json");
  if (hostOfRunningCopy(opts, root) === "codex" && existsSync(own)) return own;
  return join(resolveCodexHome(), "hooks.json");
}

/** What is wired on this machine — the answer when the running copy does not say (`[16]`, `[67]`; order as above). */
export function hostOnThisMachine(opts: HostProbes): "claude-code" | "codex" | "antigravity" {
  if (existsSync(opts.claudeHome ?? resolveClaudeHome())) return "claude-code";
  if (existsSync(opts.agyHooksJsonPath ?? resolveAgyHooksJsonPath())) return "antigravity";
  if (agyPluginHasSiltpokeStop(opts)) return "antigravity"; // [67]
  if (existsSync(opts.codexConfigPath ?? join(resolveCodexHome(), "config.toml"))) return "codex";
  return "claude-code";
}

/**
 * The one sentence that tells this host's user how to set Siltpoke up.
 *
 * codex and antigravity: verbatim from their Stop-hook nudges
 * (`hooks/codex-stop.sh`, `src/hooks/agy-setup-hint.ts`) that defect `[8]`
 * settled. qoder and codebuddy (`[89]`): the phrase docs/MANUAL.md gives them —
 * neither exposes `/siltpoke-*` slash commands, and
 * `tests/plugin/host-aware-nudge.test.ts` holds the invariant that a non-Claude
 * host is never handed one.
 */
export function setupAdviceFor(host: DoctorHost): string {
  switch (host) {
    case "codex":
      return "Run `/skills` and pick siltpoke";
    case "antigravity":
      return 'Ask your agent to "set up Siltpoke"';
    case "qoder":
    case "codebuddy":
      return 'Ask your agent to "run Siltpoke setup"';
    default:
      return "Run `/siltpoke:siltpoke-setup`";
  }
}

/**
 * Where this host keeps the wiring doctor should be looking at. qoder and
 * codebuddy are Claude Code forks: a plugin install is wired by the plugin's
 * own `hooks/hooks.json`; a from-source install wrote `<host home>/settings.json`.
 */
export function wiringPathFor(host: DoctorHost, opts: HostProbes, root: string): string {
  switch (host) {
    case "codex":
      return codexWiringPath(opts, root);
    case "antigravity":
      return agyWiringPath(opts);
    case "qoder":
    case "codebuddy": {
      const own = join(root, "hooks", "hooks.json");
      if (hostOfRunningCopy(opts, root) === host && existsSync(own)) return own;
      const home = host === "qoder" ? (opts.qoderHome ?? resolveQoderHome()) : (opts.codebuddyHome ?? resolveCodebuddyHome());
      return join(home, "settings.json");
    }
    default:
      return join(opts.claudeHome ?? resolveClaudeHome(), "settings.json");
  }
}

/** "a codex" / "an antigravity" — the indefinite article for a host name in a sentence. */
export function aHost(host: string): string {
  return `${/^[aeiou]/i.test(host) ? "an" : "a"} ${host}`;
}

function pluginHooksJsonPath(opts: { agyHooksJsonPath?: string }): string {
  return join(agyPluginRootFor({ agyHooksJsonPath: opts.agyHooksJsonPath }), "hooks.json");
}

/**
 * The file an agy install is actually wired through: the plugin's hooks.json when
 * that is where the siltpoke Stop entry is AND the global hooks.json is absent
 * (a plugin-only install), the global path otherwise.
 */
export function agyWiringPath(opts: { agyHooksJsonPath?: string } = {}): string {
  const global = opts.agyHooksJsonPath ?? resolveAgyHooksJsonPath();
  if (globalHasSiltpokeStop(global)) return global;
  if (agyPluginHasSiltpokeStop(opts)) return pluginHooksJsonPath(opts);
  return global;
}

/** Same matcher as doctor's global-hooks row: `siltpoke-review`.Stop has a command naming `agy-stop.ts`. */
function globalHasSiltpokeStop(file: string): boolean {
  if (!existsSync(file)) return false;
  try {
    const stop = (JSON.parse(readFileSync(file, "utf8")) as Record<string, { Stop?: unknown } | undefined> | null)?.[
      "siltpoke-review"
    ]?.Stop;
    return (
      Array.isArray(stop) &&
      stop.some((h) => {
        const e = h as { type?: unknown; command?: unknown } | null;
        return e?.type === "command" && typeof e.command === "string" && e.command.includes("agy-stop.ts");
      })
    );
  } catch {
    return false;
  }
}

export function agyPluginHasSiltpokeStop(opts: { agyHooksJsonPath?: string } = {}): boolean {
  return agyPluginStopWired(agyPluginRootFor({ agyHooksJsonPath: opts.agyHooksJsonPath }));
}
