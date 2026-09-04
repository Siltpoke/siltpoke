// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
// Copyright (c) 2026 Jiaqi Duan

import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import {
  copyFile,
  mkdir,
  readdir,
  readFile,
  rename,
  symlink,
  unlink,
  writeFile,
} from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { generateSecret } from "../daemon/auth";
import { DEFAULT_SPECIES } from "../face/species";
import type { AgentTarget } from "../installer/agent-types";
import {
  type AutostartDispatchResult,
  installAutostartForPlatform,
} from "../installer/autostart";
import { backupSettings } from "../installer/backup";
import { type HostWireContext, secondaryHostAdapters } from "../installer/host-adapter";
import {
  type MenubarSetupDeps,
  type MenubarSetupResult,
  runMenubarSetup,
} from "../installer/menubar-setup";
import { migrateAll } from "../installer/migrations";
import { askMultiSelectTTY } from "../installer/multiselect-tty";
import {
  codexHooksJsonPath,
  commandsDirPath,
  resolveClaudeHome,
  resolveCodexHome,
  settingsJsonPath,
  siltpokeRoot,
} from "../installer/paths";
import {
  type Personality,
  runPersonalityWizard,
} from "../installer/personality-wizard";
import {
  registerSessionStartHook,
} from "../installer/register-session-start";
import {
  hasStopHookPair,
  registerStopHookPair,
  type StopHookPair,
  swapStatusLine,
} from "../installer/settings-mutator";
import { OLLAMA_MODEL, setupOllamaInteractive } from "../installer/setup-ollama";
import {
  askYesNo,
  realWizardIO,
  type WizardIO,
} from "../installer/wizard";
import { migrateV2toV3 } from "../memory/migrate-v3";
import { atomicWrite } from "../utils/atomic-write";

export type { AgentTarget } from "../installer/agent-types";

import { detectAgents } from "../installer/agent-detect";
import { buildAgentChoices, filterPresetByPresence, labelFor, resolveAgentFlag } from "../installer/agent-menu";
import type { Exec } from "../installer/prereq";

// `command -v <bin>` is a POSIX shell BUILTIN, not a standalone executable.
// macOS/BSD ship a compat shim at /usr/bin/command (a tiny `#!/bin/sh` script
// that calls the builtin), but Debian/Ubuntu — including GitHub Actions
// ubuntu-latest — do NOT ship any /usr/bin/command binary at all. Spawning
// "command" as a literal argv[0] (as this used to do) fails with ENOENT on
// Linux even when the target binary genuinely is on PATH, so detectAgents /
// detectPrereqs silently report EVERY agent/prereq as absent there. Route it
// through a shell instead so the builtin resolves everywhere. Mirrors the
// equivalent fix already applied to bootstrap.ts's own real-CLI exec — see
// the comment on the `if (import.meta.main)` block in that file.
//
// `args` are passed as positional shell parameters ($1, $2, ...) rather than
// interpolated into the `-c` script text — every current call site only ever
// passes static, hardcoded bin names (see agent-detect.ts / prereq.ts), but
// this keeps it that way structurally instead of by convention, so a future
// caller can't accidentally hand a shell-metacharacter-bearing value into
// `sh -c` string concatenation.
//
// Pulled out as a pure function (no subprocess) so tests can assert the
// routing decision structurally instead of relying on process.env.PATH
// tricks: Bun's spawnSync resolves the child's executable against the
// PARENT process's real PATH, not against a mutated process.env.PATH — so a
// test that strips process.env.PATH down to `/bin` and expects the old
// (unrouted) implementation to fail does NOT actually fail pre-fix, and
// would never catch a revert. See tests/cli/install-default-exec.test.ts.
//
// Empty `args` is guarded: `command ` with no operand exits 0 under POSIX
// sh, which would read as a false "present". No call site passes empty args
// today (agent-detect.ts / prereq.ts always pass ["-v", bin]), but keep it
// structurally safe rather than relying on that convention.
export function buildExecArgv(cmd: string, args: string[]): [string, string[]] {
  if (cmd !== "command" || args.length === 0) return [cmd, args];
  return ["sh", ["-c", `command ${args.map((_, i) => `"$${i + 1}"`).join(" ")}`, "_", ...args]];
}

export const defaultExec: Exec = (cmd, args) => {
  const [spawnCmd, spawnArgs] = buildExecArgv(cmd, args);
  const r = spawnSync(spawnCmd, spawnArgs, { encoding: "utf8" });
  return { status: r.status ?? 1, stdout: r.stdout ?? "" };
};

export interface InstallOptions {
  env?: NodeJS.ProcessEnv;
  io?: WizardIO;
  repoRoot?: string;
  noninteractive?: boolean;
  now?: () => Date;
  /** Autostart platform dispatch — injectable for tests (track #6 T2). */
  installAutostartFn?: () => Promise<AutostartDispatchResult>;
  /** Menu-bar setup dispatch — injectable for tests (track #7 T7). */
  runMenubarSetupFn?: (deps: MenubarSetupDeps) => Promise<MenubarSetupResult>;
  /** Platform override for tests — the menu-bar question is darwin-only (track #7 T7),
   *  and it also gates the symlink→copy branch for backupSettings/symlinkCommands (Tw1). */
  platform?: NodeJS.Platform;
  /** Preset agent targets from bootstrap's command-v detection (P2 AC10). When
   *  provided, runInstall skips its own config-dir probe + interactive prompt. */
  presetAgents?: AgentTarget[];
  /** True when presetAgents came from the --agent flag (vs bootstrap detection);
   *  gates the "Claude not selected" advisory note. */
  agentFlagUsed?: boolean;
  /** Command-presence probe, injectable for tests. */
  exec?: Exec;
}

export interface InstallResult {
  status:
    | "installed"
    | "already_installed"
    | "no_settings"
    | "user_aborted"
    | "internal_subprocess";
  wrapper_command: string;
  hook_command: string;
  inner_command?: string | null;
  config_path: string;
  backup_path?: string;
  personality_seed_used: boolean;
}

function detectRepoRoot(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  return resolve(here, "..", "..");
}

async function atomicWriteJson(path: string, data: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.tmp.${process.pid}.${Date.now()}.${randomBytes(4).toString("hex")}`;
  await writeFile(tmp, JSON.stringify(data, null, 2), "utf8");
  await rename(tmp, path);
}

async function atomicWriteText(path: string, contents: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.tmp.${process.pid}.${Date.now()}.${randomBytes(4).toString("hex")}`;
  await writeFile(tmp, contents, "utf8");
  await rename(tmp, path);
}

async function readJsonOrEmpty(path: string): Promise<Record<string, unknown>> {
  if (!existsSync(path)) return {};
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch {
    return {};
  }
}

export async function symlinkCommands(
  pluginCommandsDir: string,
  claudeCommandsDir: string,
  platform: NodeJS.Platform = process.platform,
): Promise<string[]> {
  await mkdir(claudeCommandsDir, { recursive: true });
  const entries = await readdir(pluginCommandsDir);
  const linked: string[] = [];
  for (const name of entries) {
    if (!name.endsWith(".md")) continue;
    const src = join(pluginCommandsDir, name);
    const dest = join(claudeCommandsDir, name);
    try {
      await unlink(dest);
    } catch {
      // missing dest is fine
    }
    if (platform === "win32") {
      // Windows symlink() needs elevation → EPERM. Copy the command file instead;
      // re-run of install re-copies (idempotent), matching plugin-update semantics.
      await copyFile(src, dest);
    } else {
      await symlink(src, dest);
    }
    linked.push(name);
  }
  return linked;
}

function readSecretIfPresent(home: string): string | null {
  const secretPath = join(home, "secret");
  if (!existsSync(secretPath)) return null;
  const value = readFileSync(secretPath, "utf8").trim();
  return value.length > 0 ? value : null;
}

function loadOrCreateSecret(home: string): string {
  const existing = readSecretIfPresent(home);
  if (existing !== null) return existing;
  const s = generateSecret();
  atomicWrite(join(home, "secret"), s, { mode: 0o600 });
  return s;
}

interface WireSecondaryHostsOpts {
  env: NodeJS.ProcessEnv;
  home: string;
  repoRoot: string;
  selectedAgents: AgentTarget[];
  pluginCommandsDir: string;
  platform: NodeJS.Platform;
  io: WizardIO;
}

/**
 * Secondary hosts (codex + codebuddy + qoder): wire each selected host's hooks
 * via its HostAdapter. codex writes ~/.codex/hooks.json (no command symlinks);
 * CC-fork hosts write settings.json + symlink slash-commands. Each host is
 * independent — one failure never blocks the others. Returns the count wired
 * (feeds the already_installed early-returns). Secret loaded once.
 *
 * Extracted out of runInstall (rather than inlined) to keep runInstall's
 * cognitive-complexity flat — this loop's branching lives here instead.
 */
async function wireSecondaryHosts(opts: WireSecondaryHostsOpts): Promise<number> {
  // secondaryHostAdapters' id is SupportedAgent; selectedAgents is
  // AgentTarget[] — the two unions now mirror each other exactly (agy
  // track), but comparing as strings avoids re-coupling this membership
  // check to the two types staying identical forever.
  const selectedAgentIds: readonly string[] = opts.selectedAgents;
  const selected = secondaryHostAdapters.filter((a) =>
    selectedAgentIds.includes(a.id),
  );
  if (selected.length === 0) return 0;
  const ctx: HostWireContext = {
    repoRoot: opts.repoRoot,
    secret: loadOrCreateSecret(opts.home),
  };
  let wired = 0;
  for (const adapter of selected) {
    try {
      const { path } = await adapter.writeHooks(opts.env, ctx);
      // codex has no separate commands dir; agy has no slash-command
      // symlink semantics either (its skill surface is agy's own, not
      // markdown commands under a commands/ dir) — both excluded here.
      if (adapter.id !== "codex" && adapter.id !== "antigravity") {
        await symlinkCommands(
          opts.pluginCommandsDir,
          adapter.commandsDir(opts.env),
          opts.platform,
        );
      }
      opts.io.write(`✓ Registered ${adapter.label} hooks at ${path}\n`);
      wired += 1;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      opts.io.write(`⚠ ${adapter.label} host wiring failed: ${msg}\n`);
    }
  }
  return wired;
}

function personalityToConfig(p: Personality): Record<string, unknown> {
  const config: Record<string, unknown> = {
    schemaVersion: 2,
    name: p.name,
    species: p.species,
    language: p.language,
    snark: p.snark,
    patience: p.patience,
    rigor: p.rigor,
    chattiness: p.chattiness,
    curiosity: p.curiosity,
  };
  if (p.archetype) config.archetype = p.archetype;
  if (p.soul) config.soul = p.soul;
  if (p.method) config.personality_method = p.method;
  if (p.matchMode) config.match_mode = p.matchMode;
  if (p.seedUsedAt) config.generated_from_memory_at = p.seedUsedAt;
  if (p.rationale) config.personality_rationale = p.rationale;
  if (p.seedMemoryFiles?.length) {
    config.personality_seed_memory_files = p.seedMemoryFiles;
  }
  return config;
}

function noninteractiveAgentTargets(env: NodeJS.ProcessEnv): AgentTarget[] {
  if (existsSync(settingsJsonPath(env))) return ["claude-code"];
  if (
    existsSync(codexHooksJsonPath(env)) ||
    existsSync(join(resolveCodexHome(env), "config.toml"))
  ) {
    return ["codex"];
  }
  return ["claude-code"];
}

export async function runInstall(
  opts: InstallOptions = {},
): Promise<InstallResult> {
  const env = opts.env ?? process.env;

  if (env.SILTPOKE_INTERNAL === "1") {
    return {
      status: "internal_subprocess",
      wrapper_command: "",
      hook_command: "",
      config_path: "",
      personality_seed_used: false,
    };
  }

  const repoRoot = opts.repoRoot ?? detectRepoRoot();
  const wrapperPath = join(repoRoot, "src", "face", "wrapper.ts");
  const hookPath = join(repoRoot, "src", "hooks", "on-stop.ts");
  const sessionStartPath = join(repoRoot, "src", "hooks", "handle-session-start.ts");
  const wrapperCommand = `bun ${wrapperPath}`;
  const hookCommand = `bun ${hookPath}`;
  const sessionStartCommand = `bun ${sessionStartPath}`;

  const claudeHome = resolveClaudeHome(env);
  const settingsPath = settingsJsonPath(env);
  const home = siltpokeRoot(env);
  const claudeCommandsDir = commandsDirPath(env);
  const pluginCommandsDir = join(repoRoot, ".claude-plugin", "commands");

  const noninteractive =
    opts.noninteractive ?? !(process.stdin as { isTTY?: boolean }).isTTY;
  const io = opts.io ?? realWizardIO();
  const platform = opts.platform ?? process.platform;

  // Autostart question (track #6 T2, AC1-5). Interactive only — CI /
  // noninteractive never prompts, never installs (AC4). Failure never blocks
  // install (pre-declared contingency): one warn line + the manual command,
  // then setup continues. Called on the success path AND on both
  // already-installed early returns — existing users re-running setup are the
  // primary autostart audience.
  const maybeOfferAutostart = async (): Promise<void> => {
    if (noninteractive) return;
    const wantsAutostart = await askYesNo(
      io,
      "开机自启 siltpoke daemon？(可选 — 只 dashboard/chat 等网页面需要它，核心 review 不需要)",
      { default: "no" },
    );
    if (!wantsAutostart) return;
    const installAutostart =
      opts.installAutostartFn ?? (() => installAutostartForPlatform());
    try {
      const result = await installAutostart();
      if (result.status === "installed") {
        io.write(`✓ Daemon autostart installed (${result.platform}).\n`);
      } else if (result.status === "skipped") {
        io.write(
          `* Autostart not supported on platform=${result.platform} — skipped.\n`,
        );
      } else {
        io.write(
          `! Autostart installer unavailable (installer/${result.module}.ts) — install manually later with: bun src/cli/daemon.ts install-autostart\n`,
        );
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      io.write(
        `! Autostart install failed (${msg}) — install manually later with: bun src/cli/daemon.ts install-autostart\n`,
      );
    }
  };

  // Menu-bar pet question (track #7 T7). macOS-only (platform injectable for
  // tests), asked right after the autostart step at every one of its call
  // sites, regardless of the autostart answer — the two features are
  // independent. Consent-driven end to end: this question just asks whether
  // to run setup at all; runMenubarSetup itself asks again before installing
  // SwiftBar via Homebrew or writing the plugin shim.
  const maybeOfferMenubar = async (): Promise<void> => {
    if (noninteractive) return;
    if (platform !== "darwin") return;
    const wantsMenubar = await askYesNo(
      io,
      "Add the menu-bar pet? (needs SwiftBar — I'll install it for you)",
      { default: "no" },
    );
    if (!wantsMenubar) return;
    const runMenubar = opts.runMenubarSetupFn ?? runMenubarSetup;
    await runMenubar({ io, platform });
  };
  const selectedAgents = opts.presetAgents?.length
    ? opts.agentFlagUsed
      ? (() => {
          // FIX 1 (final-branch review): --agent must not wire an undetected
          // secondary host. Bootstrap's own presetAgents path (agentFlagUsed
          // false) is intentionally left untouched below — its presence
          // check already happened in selectAndInstallAgents.
          const presence = detectAgents({ exec: opts.exec ?? defaultExec, platform });
          const { kept, dropped } = filterPresetByPresence(opts.presetAgents ?? [], presence);
          for (const d of dropped) {
            io.write(
              `⚠ ${labelFor(d)} not detected on PATH — skipped (siltpoke wires, never installs the CLI)\n`,
            );
          }
          return kept;
        })()
      : opts.presetAgents
    : noninteractive
      ? noninteractiveAgentTargets(env)
      : await (async (): Promise<AgentTarget[]> => {
          const presence = detectAgents({ exec: opts.exec ?? defaultExec, platform });
          const { items, defaults } = buildAgentChoices(presence);
          const supported = items.filter((i) => i.supported);
          const picked = await askMultiSelectTTY(
            io,
            "Which CLI agents should Siltpoke install into?",
            supported.map((i) => ({ value: i.value, label: i.label })),
            defaults,
          );
          return picked;
        })();
  const wantsClaude = selectedAgents.includes("claude-code");
  if (opts.agentFlagUsed && !wantsClaude) {
    io.write(
      "Note: Brain defaults to claude — set reviewer_provider in ~/.siltpoke/config.json if Claude isn't installed.\n",
    );
  }
  const wantsCodex = selectedAgents.includes("codex");
  // Selected secondary hosts (codex/codebuddy/qoder) count as "something to
  // install" just like Claude — otherwise a fresh machine with only a
  // secondary-host CLI present (no ~/.claude/settings.json) would hit the
  // no_settings early-return below before ever reaching wireSecondaryHosts.
  const selectedAgentIds: readonly string[] = selectedAgents;
  const wantsAnySecondary = secondaryHostAdapters.some((a) =>
    selectedAgentIds.includes(a.id),
  );

  // Run before settings.json check: state files (memory.json, etc.) live
  // independent of settings.json, so the no_settings exit branch must
  // still see a current-schema state on disk. migrateAll itself is a
  // no-op if no state files exist, so fresh installs cost nothing.
  const migrateResult = await migrateAll(home);
  if (migrateResult.migrated > 0) {
    io.write(
      `✓ Migrated ${migrateResult.migrated} state file(s) to current schema.\n`,
    );
  }
  for (const err of migrateResult.errors) {
    io.write(`! migration warning [${err.file}]: ${err.message}\n`);
  }

  // Auto-fire the v2 → v3 hybrid split. Safe because
  // readMemory / writeMemory are now v3-aware (compat shim) — every existing
  // caller continues to see / write a v2-shaped CoreMemory regardless of
  // whether migration has run. Idempotent (no-op if no v2 file or already
  // migrated).
  const v3 = await migrateV2toV3({ home });
  if (v3.migrated) {
    io.write(
      `✓ Split memory into v3 layout (project: ${v3.project_id}${v3.legacy_used ? " — legacy" : ""}).\n`,
    );
    if (v3.backup_path) {
      io.write(`  pre-split backup: ${v3.backup_path}\n`);
    }
  }

  const hasClaudeSettings = existsSync(settingsPath);
  if (wantsClaude && !hasClaudeSettings) {
    io.write(
      `! No settings.json at ${settingsPath} — run Claude Code at least once before installing.\n`,
    );
  }
  if (!hasClaudeSettings && !wantsAnySecondary) {
    return {
      status: "no_settings",
      wrapper_command: wrapperCommand,
      hook_command: hookCommand,
      config_path: join(home, "config.json"),
      personality_seed_used: false,
    };
  }

  const currentSettings = hasClaudeSettings
    ? await readJsonOrEmpty(settingsPath)
    : {};
  const currentStatus = (currentSettings as { statusLine?: { command?: unknown } })
    .statusLine?.command;
  const currentStatusStr =
    typeof currentStatus === "string" ? currentStatus : null;

  // For the "already installed" check we use whatever secret currently lives
  // on disk (if any). We deliberately do NOT materialise a new secret here —
  // otherwise a user who is just checking installer status, or who is about
  // to decline the swap, would leave a stray ~/.siltpoke/secret behind.
  const existingSecret = readSecretIfPresent(home);
  const alreadyInstalled =
    wantsClaude &&
    hasClaudeSettings &&
    currentStatusStr === wrapperCommand &&
    existingSecret !== null &&
    hasStopHookPair(currentSettings, {
      httpUrl: "http://127.0.0.1:9876/hooks/stop",
      command: hookCommand,
      secret: existingSecret,
    });

  const statusLooksSiltpoke =
    typeof currentStatusStr === "string" &&
    /siltpoke\/.+(face\/wrapper|src\/face\/wrapper)/.test(currentStatusStr);
  if (wantsClaude && statusLooksSiltpoke && currentStatusStr !== wrapperCommand) {
    io.write(
      `! Existing statusLine points at a DIFFERENT siltpoke checkout:\n  ${currentStatusStr}\n` +
        `! Refusing to install from this checkout to avoid corrupting the backup chain.\n` +
        `! Either run uninstall from the other checkout first, or move/rename this repo to match.\n`,
    );
    return {
      status: "user_aborted",
      wrapper_command: wrapperCommand,
      hook_command: hookCommand,
      config_path: join(home, "config.json"),
      personality_seed_used: false,
    };
  }

  if (alreadyInstalled && !wantsAnySecondary) {
    io.write(
      `* Siltpoke is already installed (statusLine + Stop hook already point at this checkout). No changes.\n`,
    );
    // Still offer autostart: re-running setup on an already-installed machine
    // is the primary way existing users pick up the new autostart feature.
    await maybeOfferAutostart();
    await maybeOfferMenubar();
    return {
      status: "already_installed",
      wrapper_command: wrapperCommand,
      hook_command: hookCommand,
      inner_command: null,
      config_path: join(home, "config.json"),
      personality_seed_used: false,
    };
  }

  io.write(`\n=== Siltpoke installer ===\n`);
  if (wantsClaude) io.write(`Claude home:    ${claudeHome}\n`);
  if (wantsCodex) io.write(`Codex home:     ${resolveCodexHome(env)}\n`);
  io.write(`Siltpoke home:  ${home}\n`);
  io.write(`Wrapper:        ${wrapperCommand}\n\n`);

  if (wantsClaude && currentStatusStr) {
    io.write(`Detected existing statusLine: ${currentStatusStr}\n\n`);
  } else if (wantsClaude) {
    io.write(`No existing statusLine.command detected — installing fresh.\n\n`);
  }

  let proceed = true;
  if (!noninteractive) {
    const promptText = wantsClaude
      ? "Install Siltpoke hooks/statusLine for selected CLI agents?"
      : "Install Siltpoke hooks for selected CLI agents?";
    proceed = await askYesNo(io, promptText, { default: "yes" });
  }
  if (!proceed) {
    return {
      status: "user_aborted",
      wrapper_command: wrapperCommand,
      hook_command: hookCommand,
      config_path: join(home, "config.json"),
      personality_seed_used: false,
    };
  }

  // 1. Run wizard FIRST so config.json exists before the wrapper takes over.
  //    Otherwise the statusline briefly shows the default species (slime) the
  //    moment swapStatusLine runs but config.json hasn't been written.
  let personality: Personality;
  if (noninteractive) {
    personality = {
      name: "Siltpoke",
      species: DEFAULT_SPECIES,
      language: "en",
      snark: 5,
      patience: 5,
      rigor: 5,
      chattiness: 5,
      curiosity: 5,
      method: "defaults",
    };
  } else {
    personality = await runPersonalityWizard({ io, claudeHome });
  }

  // 2. Write config.json (before wrapper takes over).
  //    Idempotency: if a config.json already exists, MERGE so existing values
  //    win — re-running install over an existing pet must not clobber the
  //    user's name/species/language/dials/progression (level, xp) with fresh
  //    defaults. Fresh supplies any newly-added field; prior preserves every
  //    existing key. Back up the prior file before merging.
  await mkdir(home, { recursive: true });
  const configPathStep2 = join(home, "config.json");
  const fresh = personalityToConfig(personality);
  fresh.agents = selectedAgents;
  if (existsSync(configPathStep2)) {
    const prior = await readJsonOrEmpty(configPathStep2);
    await atomicWriteText(
      `${configPathStep2}.preinstall-bak`,
      JSON.stringify(prior, null, 2),
    );
    await atomicWriteJson(configPathStep2, { ...fresh, ...prior, agents: selectedAgents });
  } else {
    await atomicWriteJson(configPathStep2, fresh);
  }

  let backup: Awaited<ReturnType<typeof backupSettings>> | undefined;
  let installedClaude = false;
  if (wantsClaude && hasClaudeSettings && !alreadyInstalled) {
    // 3. Backup settings.json.
    backup = await backupSettings(claudeHome, (opts.now ?? (() => new Date()))(), platform);

    // 4. Persist old statusline command to inner.txt so the wrapper can call it.
    //    Self-reference guard: on a RE-install, currentStatusStr is ALREADY the
    //    siltpoke wrapper. Writing it into inner.txt would make the wrapper call
    //    itself → fork bomb (posix_spawn EAGAIN / state-card cascade). Skip the
    //    write in that case so the prior good inner.txt is left untouched.
    const isWrapperSelf =
      currentStatusStr === wrapperCommand ||
      (currentStatusStr?.includes("face/wrapper") ?? false);
    if (currentStatusStr && !isWrapperSelf) {
      await atomicWriteText(join(home, "inner.txt"), currentStatusStr);
    }

    // 5. Mutate settings.json: swap statusLine + register Stop hook pair
    //    (silent curl fast-path to the daemon + on-stop command fallback;
    //    any old type:"http" entry is migrated away inside the register).
    //    Secret is loaded/created lazily here so a declined install never
    //    leaves a stray secret behind.
    const secret = loadOrCreateSecret(home);
    const stopPair: StopHookPair = {
      httpUrl: "http://127.0.0.1:9876/hooks/stop",
      command: hookCommand,
      secret,
    };
    const swapped = swapStatusLine(currentSettings, wrapperCommand);
    const withHook = registerStopHookPair(swapped.next, stopPair);
    // Also register the SessionStart hook so baseline.json is written at
    // session start before any code changes occur.
    const withSessionStart = registerSessionStartHook(withHook, sessionStartCommand);
    await atomicWriteJson(settingsPath, withSessionStart);
    installedClaude = true;
  }

  // Ollama setup for bias audit (skip in CI or when --no-ollama passed).
  const noOllama = (opts.env ?? process.env).CI === "true";
  const ollamaResult = await setupOllamaInteractive({
    skip: noOllama,
    io: { write: (s: string) => io.write(s) },
  });
  if (ollamaResult.enabled) {
    const configPath = join(home, "config.json");
    const existingConfig = await readJsonOrEmpty(configPath);
    await atomicWriteJson(configPath, {
      ...existingConfig,
      biasAudit: {
        enabled: true,
        model: OLLAMA_MODEL,
        samplePercent: 1,
        alertThreshold: 0.15,
      },
    });
  }

  // 6. Symlink Claude slash commands and wire secondary hosts.
  if (installedClaude) {
    await symlinkCommands(pluginCommandsDir, claudeCommandsDir, platform);
  }

  // Secondary hosts (codex + codebuddy/qoder) — see wireSecondaryHosts for details.
  const installedSecondaryCount = await wireSecondaryHosts({
    env,
    home,
    repoRoot,
    selectedAgents,
    pluginCommandsDir,
    platform,
    io,
  });

  if (!installedClaude && installedSecondaryCount === 0 && alreadyInstalled) {
    // Same rationale as the earlier already_installed return: existing
    // installs still get the autostart offer on re-run.
    await maybeOfferAutostart();
    await maybeOfferMenubar();
    return {
      status: "already_installed",
      wrapper_command: wrapperCommand,
      hook_command: hookCommand,
      inner_command: null,
      config_path: join(home, "config.json"),
      personality_seed_used: false,
    };
  }

  // 7. Autostart + menu-bar questions — see maybeOfferAutostart /
  // maybeOfferMenubar above (track #6 T2, track #7 T7).
  await maybeOfferAutostart();
  await maybeOfferMenubar();

  io.write(`\n=== Installed ===\n`);
  io.write(`  ${personality.name} the ${personality.species} is ready.\n`);
  io.write(`  config:  ${join(home, "config.json")}\n`);
  // Print the actual timestamped backup file, not the convenience pointer —
  // backupSettings() skips creating the pointer symlink on win32 (EPERM),
  // so backup.symlink may not exist there while backup.path always does.
  if (backup) io.write(`  backup:  ${backup.path}\n`);
  io.write(`\n  Restart your CLI agent to bring ${personality.name} to life.\n`);

  return {
    status: "installed",
    wrapper_command: wrapperCommand,
    hook_command: hookCommand,
    inner_command: currentStatusStr,
    config_path: join(home, "config.json"),
    backup_path: backup?.path,
    personality_seed_used: Boolean(personality.seedUsedAt),
  };
}

if (import.meta.main) {
  const noninteractive = process.argv.includes("--noninteractive");
  const wantJson = process.argv.includes("--json");
  const agentIdx = process.argv.indexOf("--agent");
  let presetAgents: AgentTarget[] | undefined;
  let agentFlagUsed = false;
  if (agentIdx >= 0) {
    const csv = process.argv[agentIdx + 1] ?? "";
    const resolved = resolveAgentFlag(csv);
    if (!resolved.ok) {
      process.stderr.write(`✗ ${resolved.error}\n`);
      process.exit(2);
    }
    presetAgents = resolved.agents;
    agentFlagUsed = true;
  }
  const result = await runInstall({ noninteractive, presetAgents, agentFlagUsed });
  if (wantJson) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  }
  process.exit(0);
}
