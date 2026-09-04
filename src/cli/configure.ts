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
import { resolvePluginRoot, writeDaemonShim, writeShim } from "../installer/shim";
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
  /** Warning sink. Defaults to stderr. */
  warn?: (msg: string) => void;
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

interface HookEntry {
  type?: string;
  command?: string;
  url?: string;
  headers?: Record<string, string>;
}
interface HookMatcher {
  matcher?: string;
  hooks?: HookEntry[];
}
interface Settings {
  statusLine?: { type?: string; command?: unknown };
  hooks?: { Stop?: HookMatcher[] } & Record<string, unknown>;
  [k: string]: unknown;
}

/**
 * True ONLY for Stop-hook entries a pre-plugin siltpoke install actually wrote.
 * The shapes are enumerated by the code that writes them —
 * installer/settings-mutator.ts (registerStopHookPair / buildStopCurlCommand):
 *
 *   1. `type: "http"` + a url ending in `/hooks/stop`  (oldest fast-path)
 *   2. a `curl … -H "X-Siltpoke-Secret: …" … /hooks/stop` command  (current fast-path)
 *   3. a command running `…/src/hooks/on-stop.ts`  (the Brain-call entry)
 *
 * We match on those STRUCTURAL anchors and nothing else.
 *
 * We deliberately do NOT match a bare "siltpoke" substring. It is not an anchor,
 * it is a coincidence: the word shows up in any path under a siltpoke checkout
 * or notes dir, so it silently deleted hooks that were never ours —
 *   `cd ~/dev/siltpoke && make lint-notify`      (the user's own hook)
 *   `otherpet --log ~/siltpoke-notes/x.log`      (another tool entirely)
 * — destroying user config with only the timestamped backup to fall back on.
 * An anchor has to be something ONLY our installer could have written.
 */
function isLegacySiltpokeStopEntry(h: HookEntry): boolean {
  const command = h.command ?? "";
  const url = h.url ?? "";

  // (1) the stale type:"http" entry — no `command` string at all.
  if (h.type === "http" && url.includes("/hooks/stop")) return true;

  // (2) the curl fast-path. Its unforgeable tell is our auth header (which the
  //     http entry also carried, in `headers`); the route is the corroborator.
  const secretInCommand = command.toLowerCase().includes("x-siltpoke-secret");
  const secretInHeaders = Object.keys(h.headers ?? {}).some(
    (k) => k.toLowerCase() === "x-siltpoke-secret",
  );
  if (secretInCommand || secretInHeaders) return true;
  if (command.startsWith("curl ") && command.includes("/hooks/stop")) return true;

  // (3) the Brain-call entry. `hooks/on-stop.ts` is OUR file name — this anchor
  //     is location-independent, so a fork cloned to any directory still matches.
  return command.includes("hooks/on-stop.ts");
}

/** Human-readable one-liner for a removed entry, for the warn log. */
function describeHookEntry(h: HookEntry): string {
  return h.command ?? h.url ?? JSON.stringify(h);
}

/**
 * The plugin's hooks.json now owns the Stop hook. A leftover settings.json entry
 * from a pre-plugin install would fire a SECOND review every turn — two Brain
 * calls, double spend. Strip ours; leave every other tool's Stop hook (and every
 * other hook event) exactly as it was.
 *
 * `onRemove` is called once per stripped entry: deleting lines from a file the
 * user owns must be VISIBLE, not something they reconstruct from a backup after
 * noticing their own hook stopped firing.
 *
 * Pure: the input object is never mutated.
 */
export function removeLegacyStopHook<T extends object>(
  settings: T,
  onRemove: (description: string) => void = () => {},
): T {
  const s = settings as Settings;
  const stop = s.hooks?.Stop;
  if (!Array.isArray(stop)) return settings;
  const kept = stop
    // Filter per HOOK, not per matcher: a matcher can hold our entry next to a
    // foreign one, and dropping the whole matcher would take the user's hook
    // down with it.
    .map((m) => ({
      ...m,
      hooks: (m.hooks ?? []).filter((h) => {
        if (!isLegacySiltpokeStopEntry(h)) return true;
        onRemove(describeHookEntry(h));
        return false;
      }),
    }))
    .filter((m) => (m.hooks ?? []).length > 0);
  return { ...settings, hooks: { ...s.hooks, Stop: kept } };
}

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
async function writeConfig(dir: string, opts: ConfigureOptions): Promise<void> {
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
async function wireSettings(
  home: string,
  siltpokeDir: string,
  wantStatusline: boolean,
  warn: (msg: string) => void,
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
    const shimPath = await writeShim(home);
    const swapped = swapStatusLine(next, `sh ${shimPath}`);
    next = swapped.next as Settings;
    const old = swapped.oldStatusLineCommand;
    // Self-reference guard (the bug install.ts guards): on a re-run the current
    // statusLine is ALREADY our wrapper. Writing that into inner.txt makes the
    // wrapper call itself — fork bomb. Leave the prior good inner.txt alone.
    const isSelf =
      old !== null &&
      (old.includes("siltpoke") || old.includes("face/wrapper"));
    if (old && !isSelf) {
      atomicWrite(join(siltpokeDir, "inner.txt"), old);
    }
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
): Promise<void> {
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
  await writeConfig(siltpokeDir, opts);

  // 2. settings.json: legacy Stop-hook sweep (always) + statusLine (opt-in).
  //    A failure here must not take the pet down with it — the config is
  //    already on disk and usable; the user's own settings.json is backed up.
  try {
    await wireSettings(home, siltpokeDir, opts.statusline, warn);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    warn(`warning: settings.json wiring failed (${msg}); the pet is installed either way`);
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
      if (result.status !== "installed") {
        warn(`warning: daemon autostart ${result.status} (platform=${result.platform})`);
      }
    } catch (err) {
      // A launchctl/systemctl failure must not take the pet down with it: the
      // config + statusline are already written and usable.
      const msg = err instanceof Error ? err.message : String(err);
      warn(`warning: daemon autostart failed (${msg}); the pet is installed either way`);
    }
  }
}

if (import.meta.main) {
  const home = process.env.HOME ?? process.env.USERPROFILE ?? "";
  if (home.length === 0) {
    process.stderr.write("siltpoke-configure: HOME is not set\n");
    process.exit(2);
  }
  const argv = process.argv.slice(2);
  const answers = answersFilePath(argv);
  try {
    const opts = answers !== null ? await readAnswersFile(answers, argv) : parseArgs(argv);
    await configure(opts, home);
  } catch (err) {
    if (err instanceof ConfigureInputError) {
      process.stderr.write(`siltpoke-configure: ${err.message}\n`);
      process.exit(2);
    }
    throw err;
  }
  // Only on success: the answers file holds the user's pet, not a secret, but it
  // is scratch — leaving it behind would make the next setup run's failure look
  // like a success (a stale file the model forgot to rewrite still parses).
  if (answers !== null) await rm(answers, { force: true });
}
