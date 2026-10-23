// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
// Copyright (c) 2026 Jiaqi Duan
/**
 * The plugin's single CLI entry point — one bundle, many subcommands.
 *
 * WHY THIS EXISTS: `/plugin install` is pure file placement. It runs no
 * installer, so nothing rewrites paths, and the cache it drops the plugin into
 * has no `node_modules`. A command that shells out to `bun src/cli/foo.ts`
 * therefore cannot work on anybody's machine but the author's — it needs both a
 * path that only exists in the dev checkout and dependencies that are not there.
 *
 * So every non-setup command in `.claude-plugin/commands/` invokes exactly one
 * thing:
 *
 *     bun "${CLAUDE_PLUGIN_ROOT}/dist/siltpoke-cli.js" <subcommand>
 *
 * `dist/siltpoke-cli.js` is this file, bundled (deps inlined) by
 * `scripts/build-dist.ts`. `${CLAUDE_PLUGIN_ROOT}` is injected by the host, so
 * no absolute path is ever baked in. `tests/plugin/commands.test.ts` fails the
 * build if a command file regresses to either.
 *
 * This module is a router ONLY: each subcommand delegates to the existing
 * implementation in `src/cli/*`. No behavior is reimplemented here.
 */

import { existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { probeExec } from "../installer/menubar-setup";
import { siltpokeRoot } from "../installer/paths";
import { randomName } from "../installer/personality-seed";
import { restoreUserStatusLine } from "../installer/statusline-restore";
import { askYesNo, realWizardIO, type WizardIO } from "../installer/wizard";
import { runBrainCli } from "./brain-cli";
import { formatDetect } from "./brain-detect";
import { openDashboard, restartDashboard } from "./dashboard";
import { runDoctorCli } from "./doctor";
import { getCritique } from "./get-critique";
import { markForwarded } from "./mark-forwarded";
import { runMenubarCli } from "./menubar";
import { formatMuteHuman, formatMuteJson, runMute } from "./mute";
import { helpText } from "./plugin-help";
import { realUninstallEffects } from "./plugin-uninstall";
import { computeQuizDials } from "./quiz-score";
import { fsDiskProbes, homeScopedExec } from "./uninstall-disk";
import { realOutsideTools, runOutsideTool } from "./uninstall-purge";
import { runUninstallCommand } from "./uninstall-run";
import { formatUnmuteHuman, formatUnmuteJson, runUnmute } from "./unmute";
import { formatWakeHuman, formatWakeJson, runWake } from "./wake";

export interface CliIo {
  stdout: (s: string) => void;
  stderr: (s: string) => void;
}

const REAL_IO: CliIo = {
  stdout: (s) => process.stdout.write(s),
  stderr: (s) => process.stderr.write(s),
};

/** The plugin's own directory, as the host hands it to the command. */
function pluginRoot(): string | undefined {
  const root = process.env.CLAUDE_PLUGIN_ROOT;
  return root && root.length > 0 ? root : undefined;
}

/**
 * How to launch the daemon that serves the dashboard.
 *
 * In a plugin cache that is the sibling bundle (`dist/siltpoke-daemon.js`) —
 * `src/cli/daemon.ts`, the default `openDashboard()` uses, does not exist
 * there. Falls back to the source entry so `bun src/cli/plugin-cli.ts report`
 * still works in the dev checkout.
 */
export function resolveDaemonArgv(): readonly string[] | undefined {
  const root = pluginRoot();
  const candidates = [
    // Bundled: dist/siltpoke-cli.js sits next to dist/siltpoke-daemon.js.
    fileURLToPath(new URL("./siltpoke-daemon.js", import.meta.url)),
    ...(root ? [join(root, "dist", "siltpoke-daemon.js")] : []),
    // Source checkout: src/cli/plugin-cli.ts sits next to src/cli/daemon.ts.
    fileURLToPath(new URL("./daemon.ts", import.meta.url)),
  ];
  const found = candidates.find((p) => existsSync(p));
  // `process.execPath`, not a bare "bun". This argv OVERRIDES openDashboard's
  // own default, so it is the one a plugin install actually spawns — which is
  // every user who installed through `/plugin install` rather than from source.
  // Fixing the default alone left this path unfixed, and on native Windows a
  // bare "bun" resolves to nothing (`where.exe bun` is empty even with bun
  // installed), so the daemon would fail to start at all rather than start and
  // die. Found by the derived sweep in tests/cli/daemon-detached.test.ts, which
  // exists because a hand-written list of known sites had already missed two.
  return found ? [process.execPath, found, "start"] : undefined;
}

/**
 * The renderer the SwiftBar menu-bar shim should invoke. In a plugin cache the
 * bundled card sits next to this bundle (`dist/siltpoke-card.js`); undefined in
 * a source checkout, where menubar-setup falls back to `src/face/wrapper.ts`.
 */
export function resolveCardPath(): string | undefined {
  const root = pluginRoot();
  const candidates = [
    fileURLToPath(new URL("./siltpoke-card.js", import.meta.url)),
    ...(root ? [join(root, "dist", "siltpoke-card.js")] : []),
  ];
  return candidates.find((p) => existsSync(p));
}

/** Critiques are per-project — always read from `{cwd}/.siltpoke/`. */
function projectBase(): string {
  return join(process.cwd(), ".siltpoke");
}

/** First non-flag argument (the review id / the mute duration). */
function positional(rest: readonly string[]): string | undefined {
  return rest.find((a) => !a.startsWith("--"));
}

/** Value following `--flag`, or undefined if the flag is absent / has no value. */
function flagValue(rest: readonly string[], flag: string): string | undefined {
  const i = rest.indexOf(flag);
  return i >= 0 && i + 1 < rest.length ? rest[i + 1] : undefined;
}

type Handler = (rest: readonly string[], io: CliIo) => Promise<number> | number;

const HANDLERS: Record<string, Handler> = {
  help: (_rest, io) => {
    io.stdout(helpText());
    return 0;
  },

  // Prints ONE generated pet name to stdout. The conversational /siltpoke:siltpoke-setup
  // calls this so its "random" option is the REAL combinator (adjective +
  // species-biased noun, e.g. "Velvetpaw") instead of the model inventing a
  // name. Optional first positional = species, to bias the noun pool.
  "random-name": (rest, io) => {
    const species = positional(rest);
    io.stdout(`${randomName(species)}\n`);
    return 0;
  },

  // Scores the /siltpoke:siltpoke-setup personality quiz into the five dials by calling
  // the REAL scoreQuiz (src/installer/personality-seed.ts) — the .md collects
  // 5 Likert scores + one finale letter per scenario and hands them here, so
  // dials are SCORED from the answers, never guessed by the model. Answers
  // arrive as a small
  // constrained JSON blob via `--answers '<json>'` or on stdin. Match mode
  // defaults to "mirror"; `--match-mode <mode>` overrides.
  "quiz-score": async (rest, io) => {
    const answersFlag = flagValue(rest, "--answers");
    const raw = (answersFlag ?? (await Bun.stdin.text())).trim();
    if (!raw) {
      io.stderr("quiz-score: no answers (use --answers '<json>' or pipe JSON on stdin)\n");
      return 1;
    }
    try {
      const dials = computeQuizDials(raw, flagValue(rest, "--match-mode"));
      io.stdout(`${JSON.stringify(dials)}\n`);
      return 0;
    } catch (e) {
      io.stderr(`quiz-score: ${(e as Error).message}\n`);
      return 1;
    }
  },

  last: async (rest, io) => {
    const idOrLatest = positional(rest) ?? "latest";
    io.stdout(await getCritique({ basePath: projectBase(), idOrLatest }));
    return 0;
  },

  "mark-forwarded": async (rest, io) => {
    const idOrLatest = positional(rest) ?? "latest";
    io.stdout(await markForwarded({ basePath: projectBase(), idOrLatest }));
    return 0;
  },

  mute: (rest, io) => {
    try {
      const result = runMute({ durationArg: positional(rest) ?? "" });
      io.stdout(rest.includes("--json") ? formatMuteJson(result) : formatMuteHuman(result));
      return 0;
    } catch (e) {
      io.stderr(`siltpoke-mute: ${(e as Error).message}\n`);
      return 1;
    }
  },

  unmute: (rest, io) => {
    const result = runUnmute();
    io.stdout(rest.includes("--json") ? formatUnmuteJson(result) : formatUnmuteHuman(result));
    return 0;
  },

  wake: async (rest, io) => {
    // Defect [11]: the self-serve clear for a latched Brain breaker. The code
    // existed in src/cli/wake.ts and every user-facing string pointed at
    // `/siltpoke:siltpoke-wake`, but it was wired into neither the CLI nor the plugin
    // commands — so the one documented way out did not exist.
    const result = await runWake();
    io.stdout(rest.includes("--json") ? formatWakeJson(result) : formatWakeHuman(result));
    return 0;
  },

  brain: (rest, io) => {
    // `detect` is read-only and config-free, so it lives beside the config
    // verbs rather than inside them. /siltpoke:siltpoke-setup §8 is its caller.
    if (rest[0] === "detect") {
      io.stdout(`${formatDetect()}\n`);
      return 0;
    }
    const result = runBrainCli(rest, siltpokeRoot(process.env));
    io[result.ok ? "stdout" : "stderr"](`${result.message}\n`);
    return result.ok ? 0 : 1;
  },

  doctor: async (rest, io) => {
    // Prefer the root the host gives. Without it (a doctor the user starts has
    // no CLAUDE_PLUGIN_ROOT), doctor's own `defaultRepoRoot()` now resolves the
    // bundle's root correctly — it used to land one level ABOVE it (defect [32]).
    const root = pluginRoot();
    const { exitCode, output } = await runDoctorCli(rest, root ? { repoRoot: root } : {});
    io.stdout(output);
    return exitCode;
  },

  dashboard: async (rest, io) => {
    const daemonArgv = resolveDaemonArgv();
    try {
      await openDashboard({
        noOpen: rest.includes("--no-open"),
        out: io.stdout,
        ...(daemonArgv ? { daemonArgv } : {}),
      });
      return 0;
    } catch (e) {
      io.stderr(`siltpoke-dashboard: ${(e as Error).message}\n`);
      return 1;
    }
  },

  "restart-daemon": async (_rest, io) => {
    const daemonArgv = resolveDaemonArgv();
    try {
      await restartDashboard({
        out: io.stdout,
        ...(daemonArgv ? { daemonArgv } : {}),
      });
      return 0;
    } catch (e) {
      io.stderr(`siltpoke-restart-daemon: ${(e as Error).message}\n`);
      return 1;
    }
  },

  // Not a user command. The statusline shim calls this once after it finds
  // the plugin uninstalled (defect [61]) — it is the only way anything of
  // ours still gets to run, and a shell script cannot safely edit JSON.
  "restore-statusline": (_rest, io) => {
    io.stdout(`${restoreUserStatusLine(process.env)}\n`);
    return 0;
  },

  // Defect [61]: the uninstall a plugin user can reach. Also what
  // ~/.siltpoke/bin/uninstall.sh runs once the plugin itself is gone.
  // `[61]` PR 2: it shows one removal plan and removes one group per call;
  // several groups only through its own y/N loop, which needs a terminal.
  uninstall: async (rest, io) => {
    // Opened on the first question only: `--plan` must not need a terminal.
    let wizard: WizardIO | undefined;
    const tools = realOutsideTools(probeExec, runOutsideTool);
    return await runUninstallCommand(rest, process.env, {
      effects: realUninstallEffects(process.env),
      probes: fsDiskProbes(homeScopedExec(probeExec, process.env), process.platform, tools.toolPresent),
      purge: tools.effects,
      // `defaults delete` acts on the account, not on HOME: refused under any other home.
      undo: { exec: homeScopedExec(probeExec, process.env), platform: process.platform },
      isTTY: process.stdin.isTTY === true && process.stdout.isTTY === true,
      ask: (question) => {
        wizard ??= realWizardIO();
        return askYesNo(wizard, question, { default: "no" });
      },
      write: io.stdout,
    });
  },

  menubar: async (rest, io) => {
    // No TTY under a slash command → non-interactive (running the command IS
    // the consent). Point the shim at the bundled card renderer when installed
    // as a plugin; undefined lets menubar-setup fall back to src/face/wrapper.ts.
    const rendererPath = resolveCardPath();
    return runMenubarCli(rest.length ? [...rest] : ["status"], {
      nonInteractive: true,
      ...(rendererPath ? { rendererPath } : {}),
      io: { readLine: async () => "", write: io.stdout },
      write: io.stdout,
    });
  },
};

const USAGE = `usage: siltpoke-cli <${Object.keys(HANDLERS).join("|")}> [args]\n`;

export async function runPluginCli(argv: readonly string[], io: CliIo = REAL_IO): Promise<number> {
  const sub = argv[0] ?? "help";
  const handler = HANDLERS[sub];
  if (!handler) {
    io.stderr(`unknown subcommand: ${sub}\n${USAGE}`);
    return 2;
  }
  return await handler(argv.slice(1), io);
}

if (import.meta.main) {
  process.exit(await runPluginCli(process.argv.slice(2)));
}
