// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
// Copyright (c) 2026 Jiaqi Duan
//
// The non-interactive write kernel.
//
// src/cli/install.ts interleaves ASKING (three TTY wizards) with WRITING. A
// slash command has no TTY, so the asking cannot survive the move to a plugin:
// it moves up to the model layer (`AskUserQuestion` in /siltpoke-setup) and
// arrives here as DATA — an --answers-file the model writes with the Write tool
// (never a shell), or, for CI and headless installs, plain flags. This file
// therefore asks NOTHING — answers in, files out. See ./configure-input.ts for
// how the answers get in and why the shell never sees them.
//
// Governing rule: no half-installed state may error out in the user's session.
// Every write is atomic; settings.json is backed up before it is touched; a
// failing autostart warns and continues rather than aborting the pet.
import { existsSync } from "node:fs";
import { readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { type DialSet, speciesDefaults } from "../brain/personality";
import type { AutostartDispatchResult } from "../installer/autostart";
import { backupSettings } from "../installer/backup";
import { archetypeOf } from "../installer/personality-seed";
import { siltpokeRoot } from "../installer/paths";
import { swapStatusLine } from "../installer/settings-mutator";
import {
  buildStatuslineCommand,
  type StatuslineInterpreterDeps,
} from "../installer/statusline-interpreter";
import { resolvePluginRoot, writeDaemonShim, writeShim } from "../installer/shim";
import { recordBunPath } from "../installer/bun-path";
import { removeLegacyStopHook, type Settings } from "./configure-legacy-sweep";
import { atomicWrite } from "../utils/atomic-write";
import {
  answersFilePath,
  ConfigureInputError,
  type ConfigureOptions,
  PERSONALITY_PRESETS,
  parseArgs,
  readAnswersFile,
  validateOptions,
} from "./configure-input";

// The input layer lives in ./configure-input.ts (parsing + the allow-lists).
// Re-exported here because this module is the kernel's public face.
export {
  answersFilePath,
  ConfigureInputError,
  type ConfigureOptions,
  PERSONALITY_PRESETS,
  parseArgs,
  readAnswersFile,
  validateOptions,
};

/** Seams so tests never reach the real launchctl/systemctl. */
export interface ConfigureDeps {
  installAutostart?: () => Promise<AutostartDispatchResult>;
  /**
   * Platform / binary-lookup seams for the statusLine interpreter (defect [10]).
   * Tests drive the win32 branch from macOS through these.
   */
  statuslineInterpreter?: StatuslineInterpreterDeps;
  /** Warning sink. Defaults to stderr. */
  warn?: (msg: string) => void;
  /** Success-summary sink. Defaults to stdout. Only `runConfigureCli` uses it. */
  out?: (msg: string) => void;
}

/**
 * What `configure` actually did — as opposed to what it was asked to do.
 *
 * The distinction is the point. Statusline wiring and autostart are each
 * allowed to fail without taking the pet down (the config is already on disk
 * and usable), so a summary built from `ConfigureOptions` would tell the user
 * a statusline is installed when it is not. Audit defect `[5d]`.
 */
export interface ConfigureResult {
  name: string;
  species: string;
  /** Absolute path of the pet config that was written. */
  configPath: string;
  /** `skipped` = not requested. `failed` = requested, and the wiring threw. */
  statusline: "installed" | "failed" | "skipped";
  /**
   * A discriminated outcome, NOT the dispatcher's raw status.
   *
   * `installAutostartForPlatform` returns `status: "skipped"` on any platform
   * that is neither darwin nor linux — Windows today. Passing that straight
   * through collided with the "the user never asked" case, and the summary
   * then told a Windows user who DID ask for the daemon that it was simply
   * "off (opt-in)". That is the very confusion this type exists to prevent,
   * reappearing in the other direction.
   */
  autostart:
    | "not-requested"
    | "installed"
    /** Requested, but the dispatcher declined — unsupported platform, missing module. */
    | { declined: string }
    | "failed";
}

/**
 * Resolve the five dials the pet gets, in priority order:
 *   1. explicit `dials` (the conversational setup's custom/random/quiz result)
 *   2. a named `personality` PRESET (the old cards / CI flags)
 *   3. the species' default profile
 * validateOptions has already guaranteed any `dials` are integers 0..10.
 */
function dialsFor(opts: ConfigureOptions): DialSet {
  if (opts.dials !== undefined) {
    // Reconstruct from EXACTLY the five keys — never return the raw object. It
    // came from JSON and buildConfig spreads the result last, so any extra
    // property riding along in `dials` (a stray `name` / `schemaVersion`) would
    // otherwise clobber a real config field. validateOptions already proved
    // these five are in-range integers.
    const { snark, patience, rigor, chattiness, curiosity } = opts.dials;
    return { snark, patience, rigor, chattiness, curiosity };
  }
  return PERSONALITY_PRESETS[opts.personality] ?? speciesDefaults(opts.species);
}

export { removeLegacyStopHook };


function buildConfig(opts: ConfigureOptions): Record<string, unknown> {
  const dials = dialsFor(opts);
  return {
    schemaVersion: 2,
    name: opts.name,
    species: opts.species,
    // `language` is the ONLY language key the runtime knows: brain/personality.ts
    // reads it and cli/doctor.ts requires it. The flag is spelled --lang because
    // that is what the setup command passes; the key it lands under is not.
    // (An extra `lang` mirror key used to be written here — nothing in src/ ever
    // read it, so it was pure schema noise.)
    language: opts.lang,
    // Record where the dials came from so the file reads honestly:
    //   · raw dials in (custom/random/quiz/read-my-memory) → "custom"
    //   · a named preset (old cards / CI) → that preset name
    //   · neither (species-default mode) → "default" — dialsFor already fell
    //     back to this species' own SPECIES_PROFILES entry (NOT a flat 5/10).
    personality:
      opts.dials !== undefined
        ? opts.personality || "custom"
        : opts.personality || "default",
    // archetype is DERIVED from the RESOLVED dials (not stored raw input) so the
    // config keeps the pre-plugin shape the pet card / dashboard read. Species-
    // default mode therefore still lands the right archetype for e.g. a cat.
    archetype: archetypeOf(dials),
    ...dials,
  };
}

/**
 * Write ~/.siltpoke/config.json.
 *
 * Merge order is the inverse of install.ts's: there, a re-run must not clobber
 * an existing pet, so prior values win. Here the user JUST answered the setup
 * cards, so their fresh answers win — while every other key the prior file held
 * (level, xp, biasAudit, agents, …) is preserved. The prior file is backed up
 * first.
 */
async function writeConfig(
  dir: string,
  opts: ConfigureOptions,
  home: string,
): Promise<void> {
  // Where bun lives, recorded from setup's own process.execPath — the hooks and
  // both shims read this pointer and cannot work it out themselves (defect
  // [20]/[21]; see installer/bun-path.ts). It rides along with config.json
  // because the two are the files ~/.siltpoke must carry after any setup.
  recordBunPath(home);
  const configPath = join(dir, "config.json");
  const fresh = buildConfig(opts);
  if (!existsSync(configPath)) {
    atomicWrite(configPath, `${JSON.stringify(fresh, null, 2)}\n`);
    return;
  }
  let prior: Record<string, unknown> = {};
  const raw = await readFile(configPath, "utf8");
  try {
    const parsed: unknown = JSON.parse(raw);
    if (parsed && typeof parsed === "object") {
      prior = parsed as Record<string, unknown>;
    }
  } catch {
    // Corrupt config.json: keep the bytes in the backup, start clean rather
    // than dying on the user's setup run.
  }
  atomicWrite(`${configPath}.pre-configure-bak`, raw);
  atomicWrite(configPath, `${JSON.stringify({ ...prior, ...fresh }, null, 2)}\n`);
}

/**
 * The ONE settings.json write.
 *
 * Two jobs, deliberately in the same pass:
 *  a) the legacy Stop-hook sweep — UNCONDITIONAL. The plugin's hooks.json fires
 *     the Stop hook for every install, whatever flags the user picked, so a
 *     pre-plugin settings.json entry means two Brain calls per turn. Gating this
 *     on `--statusline` (an unrelated, independently-toggleable feature) would
 *     leave a `--daemon`-only user paying double forever.
 *  b) the statusLine swap — only when `--statusline` was asked for.
 *
 * No settings.json, or nothing to change (fresh machine, or a re-run where the
 * sweep already happened and statusLine is untouched) ⇒ no backup, no write.
 */
/**
 * Point `statusLine.command` at our shim, preserving whatever was there before
 * so the wrapper can chain to it.
 *
 * Defect [10]: this used to write `sh <shim>` on every platform. Windows has no
 * bare `sh`, so the command could never start — silently, because a statusLine
 * command that fails to spawn renders nothing rather than an error.
 */
async function swapInStatusline(
  settings: Settings,
  home: string,
  siltpokeDir: string,
  warn: (msg: string) => void,
  interpreterDeps: StatuslineInterpreterDeps,
): Promise<Settings> {
  const shimPath = await writeShim(home);
  const statusline = buildStatuslineCommand(shimPath, interpreterDeps);
  if (!statusline.resolved) {
    warn(`warning: ${statusline.reason}`);
  }
  const swapped = swapStatusLine(settings, statusline.command);
  const old = swapped.oldStatusLineCommand;
  // Self-reference guard (the bug install.ts guards): on a re-run the current
  // statusLine is ALREADY our wrapper. Writing that into inner.txt makes the
  // wrapper call itself — fork bomb. Leave the prior good inner.txt alone.
  const isSelf =
    old !== null && (old.includes("siltpoke") || old.includes("face/wrapper"));
  if (old && !isSelf) {
    atomicWrite(join(siltpokeDir, "inner.txt"), old);
  }
  return swapped.next as Settings;
}

async function wireSettings(
  home: string,
  siltpokeDir: string,
  wantStatusline: boolean,
  warn: (msg: string) => void,
  interpreterDeps: StatuslineInterpreterDeps = {},
): Promise<void> {
  const claudeHome = join(home, ".claude");
  const settingsPath = join(claudeHome, "settings.json");
  const hasSettings = existsSync(settingsPath);
  if (!hasSettings && !wantStatusline) return; // nothing of ours is in there

  let current: Settings = {};
  if (hasSettings) {
    const raw = await readFile(settingsPath, "utf8");
    try {
      current = JSON.parse(raw) as Settings;
    } catch {
      // Unparseable settings.json. We CANNOT rewrite it: starting from `{}` would
      // re-serialize the file with every key the user had (permissions, env, MCP
      // servers, every other hook) simply gone — a silent, total wipe of a file we
      // could not even read. Say so and leave the file exactly as it is; the pet
      // still installs, and the user fixes their JSON and re-runs.
      warn(
        `warning: ${settingsPath} is not valid JSON — skipping settings wiring ` +
          `(left untouched). Fix the JSON and re-run setup to wire the statusline.`,
      );
      return;
    }
  }

  const removed: string[] = [];
  let next: Settings = removeLegacyStopHook(current, (d) => removed.push(d));
  const sweptSomething = JSON.stringify(next) !== JSON.stringify(current);

  if (wantStatusline) {
    next = await swapInStatusline(next, home, siltpokeDir, warn, interpreterDeps);
  } else if (!sweptSomething) {
    return; // nothing to write — don't touch the user's file for nothing
  }

  // Tell the user exactly what we took out of their file. A hook silently
  // vanishing is indistinguishable from a hook that broke.
  for (const entry of removed) {
    warn(`removed legacy siltpoke Stop hook from settings.json: ${entry}`);
  }

  // Back up BEFORE mutating — the user's settings.json is theirs.
  if (hasSettings) await backupSettings(claudeHome);
  atomicWrite(settingsPath, `${JSON.stringify(next, null, 2)}\n`);
}

export async function configure(
  opts: ConfigureOptions,
  home: string,
  deps: ConfigureDeps = {},
): Promise<ConfigureResult> {
  const warn = deps.warn ?? ((msg: string) => process.stderr.write(`${msg}\n`));
  // Honors SILTPOKE_HOME from process.env (relocates when set), else falls
  // back to the injected `home` param as HOME — preserves the test seam
  // (tests inject a tmp `home`) while still routing through the single
  // canonical resolver. Do NOT call siltpokeRoot() bare here — that would
  // ignore `home` and break every test that injects a tmp dir.
  const siltpokeDir = siltpokeRoot({ ...process.env, HOME: home });

  // 0. Reject an unknown species/personality BEFORE any write — a bad key would
  //    otherwise fall back to a default and hand the user the wrong pet.
  validateOptions(opts);

  // 1. The pet first — config.json must exist before the statusline starts
  //    rendering, or the card briefly shows a default pet the user never made.
  await writeConfig(siltpokeDir, opts, home);

  // 2. settings.json: legacy Stop-hook sweep (always) + statusLine (opt-in).
  //    A failure here must not take the pet down with it — the config is
  //    already on disk and usable; the user's own settings.json is backed up.
  let statusline: ConfigureResult["statusline"] = opts.statusline
    ? "installed"
    : "skipped";
  try {
    await wireSettings(
      home,
      siltpokeDir,
      opts.statusline,
      warn,
      deps.statuslineInterpreter,
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    warn(`warning: settings.json wiring failed (${msg}); the pet is installed either way`);
    // Only downgrade what was actually asked for: a skipped statusline that
    // hit an unrelated sweep failure is still `skipped`, not `failed`.
    if (opts.statusline) statusline = "failed";
  }

  // 3. Daemon autostart (opt-in).
  //
  //    The shim is written ONLY for a plugin install — i.e. only when
  //    ~/.siltpoke/plugin-root resolves, which the plugin's SessionStart hook is
  //    the only writer of. The shim resolves the daemon THROUGH that pointer, so
  //    writing it on a repo checkout (`bun run setup`, `siltpoked
  //    install-autostart`) would leave the file on disk, make resolveDaemonLauncher
  //    prefer it forever after, and hand the user a unit that can never resolve a
  //    daemon: it idles, the keep-alive respawns it every few minutes, and we
  //    report "installed" while serving nothing. No pointer ⇒ no shim ⇒ the unit
  //    keeps the direct `bun <repo>/src/cli/daemon.ts` path it has always used.
  //
  //    When we DO write it, it must land BEFORE the unit is rendered —
  //    installAutostartForPlatform points the unit at it.
  let autostart: ConfigureResult["autostart"] = "not-requested";
  if (opts.daemon) {
    if (resolvePluginRoot(home) !== null) {
      await writeDaemonShim(home);
    }
    const install =
      deps.installAutostart ??
      (async () => {
        const { installAutostartForPlatform } = await import("../installer/autostart");
        // Same `home` the shim was written under — do not let the platform
        // module re-derive os.homedir() and land on a different one.
        return installAutostartForPlatform({ home });
      });
    try {
      const result = await install();
      autostart = result.status === "installed" ? "installed" : { declined: result.status };
      if (result.status !== "installed") {
        warn(`warning: daemon autostart ${result.status} (platform=${result.platform})`);
      }
    } catch (err) {
      // A launchctl/systemctl failure must not take the pet down with it: the
      // config + statusline are already written and usable.
      const msg = err instanceof Error ? err.message : String(err);
      warn(`warning: daemon autostart failed (${msg}); the pet is installed either way`);
      autostart = "failed";
    }
  }

  return {
    name: opts.name,
    species: opts.species,
    configPath: join(siltpokeDir, "config.json"),
    statusline,
    autostart,
  };
}

/**
 * The success summary, one line per thing the user can check.
 *
 * WHY IT EXISTS — the kernel used to print NOTHING on success (audit defect
 * `[5d]`). `/siltpoke-setup` runs it and then has to tell the user what
 * happened, and its only evidence was an exit code plus the answers file
 * having vanished. Every line here reports the RESULT, never the request, so a
 * statusline that failed to wire is never announced as installed.
 */
export function summarize(r: ConfigureResult): string[] {
  const lines = [`siltpoke: created "${r.name}" (${r.species}) — ${r.configPath}`];
  if (r.statusline === "installed") {
    lines.push("siltpoke: statusline installed — your pet shows up in Claude Code");
  } else if (r.statusline === "failed") {
    lines.push(
      "siltpoke: statusline NOT installed (see the warning above) — the pet itself is fine",
    );
  } else {
    lines.push("siltpoke: statusline left off (you asked for it off)");
  }
  if (r.autostart === "not-requested") {
    lines.push(
      "siltpoke: background daemon off (opt-in — open /siltpoke-dashboard to start it)",
    );
  } else if (r.autostart === "installed") {
    lines.push("siltpoke: daemon autostart installed");
  } else if (r.autostart === "failed") {
    lines.push("siltpoke: daemon autostart FAILED (see the warning above)");
  } else {
    // Asked for, and the platform said no. Never phrased as "off (opt-in)":
    // the user DID opt in, and telling them otherwise hides the whole event.
    lines.push(
      `siltpoke: daemon autostart NOT installed — ${r.autostart.declined} on this platform (see the warning above)`,
    );
  }
  return lines;
}

/**
 * The whole CLI, as a function — argv in, exit code out.
 *
 * `import.meta.main` below is a two-line shell around this. Lifting it out is
 * what makes the summary above testable at all: the printing, the exit codes
 * and the answers-file deletion are the behaviour users actually get, and an
 * `import.meta.main` block cannot be imported by a test.
 */
export async function runConfigureCli(
  argv: string[],
  home: string,
  deps: ConfigureDeps = {},
): Promise<number> {
  const out = deps.out ?? ((s: string) => process.stdout.write(`${s}\n`));
  const warn = deps.warn ?? ((s: string) => process.stderr.write(`${s}\n`));
  if (home.length === 0) {
    warn("siltpoke-configure: HOME is not set");
    return 2;
  }
  const answers = answersFilePath(argv);
  let result: ConfigureResult;
  try {
    const opts = answers !== null ? await readAnswersFile(answers, argv) : parseArgs(argv);
    result = await configure(opts, home, { ...deps, warn });
  } catch (err) {
    if (err instanceof ConfigureInputError) {
      warn(`siltpoke-configure: ${err.message}`);
      return 2;
    }
    throw err;
  }
  // Only on success: the answers file holds the user's pet, not a secret, but it
  // is scratch — leaving it behind would make the next setup run's failure look
  // like a success (a stale file the model forgot to rewrite still parses).
  if (answers !== null) await rm(answers, { force: true });
  for (const line of summarize(result)) out(line);
  return 0;
}

if (import.meta.main) {
  const home = process.env.HOME ?? process.env.USERPROFILE ?? "";
  process.exit(await runConfigureCli(process.argv.slice(2), home));
}
