// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
// Copyright (c) 2026 Jiaqi Duan
import {
  mkdir,
  writeFile,
  readFile,
  rename,
  symlink,
  readdir,
  unlink,
} from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { randomBytes } from "node:crypto";
import {
  resolveClaudeHome,
  siltpokeRoot,
  settingsJsonPath,
  commandsDirPath,
} from "../installer/paths";
import { backupSettings } from "../installer/backup";
import {
  swapStatusLine,
  registerStopHookPair,
  hasStopHookPair,
  type StopHookPair,
} from "../installer/settings-mutator";
import {
  registerSessionStartHook,
} from "../installer/register-session-start";
import { atomicWrite } from "../utils/atomic-write";
import { generateSecret } from "../daemon/auth";
import {
  askYesNo,
  realWizardIO,
  type WizardIO,
} from "../installer/wizard";
import {
  runPersonalityWizard,
  type Personality,
} from "../installer/personality-wizard";
import { migrateAll } from "../installer/migrations";
import { migrateV2toV3 } from "../memory/migrate-v3";
import { DEFAULT_SPECIES } from "../face/species";
import { setupOllamaInteractive, OLLAMA_MODEL } from "../installer/setup-ollama";

export interface InstallOptions {
  env?: NodeJS.ProcessEnv;
  io?: WizardIO;
  repoRoot?: string;
  noninteractive?: boolean;
  now?: () => Date;
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

async function symlinkCommands(
  pluginCommandsDir: string,
  claudeCommandsDir: string,
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
    await symlink(src, dest);
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

  if (!existsSync(settingsPath)) {
    io.write(
      `! No settings.json at ${settingsPath} — run Claude Code at least once before installing.\n`,
    );
    return {
      status: "no_settings",
      wrapper_command: wrapperCommand,
      hook_command: hookCommand,
      config_path: join(home, "config.json"),
      personality_seed_used: false,
    };
  }

  const currentSettings = await readJsonOrEmpty(settingsPath);
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
  if (statusLooksSiltpoke && currentStatusStr !== wrapperCommand) {
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

  if (alreadyInstalled) {
    io.write(
      `* Siltpoke is already installed (statusLine + Stop hook already point at this checkout). No changes.\n`,
    );
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
  io.write(`Claude home:    ${claudeHome}\n`);
  io.write(`Siltpoke home:  ${home}\n`);
  io.write(`Wrapper:        ${wrapperCommand}\n\n`);

  if (currentStatusStr) {
    io.write(`Detected existing statusLine: ${currentStatusStr}\n\n`);
  } else {
    io.write(`No existing statusLine.command detected — installing fresh.\n\n`);
  }

  let proceed = true;
  if (!noninteractive) {
    proceed = await askYesNo(io, "Swap statusLine.command to Siltpoke wrapper?", {
      default: "yes",
    });
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
  if (existsSync(configPathStep2)) {
    const prior = await readJsonOrEmpty(configPathStep2);
    await atomicWriteText(
      `${configPathStep2}.preinstall-bak`,
      JSON.stringify(prior, null, 2),
    );
    await atomicWriteJson(configPathStep2, { ...fresh, ...prior });
  } else {
    await atomicWriteJson(configPathStep2, fresh);
  }

  // 3. Backup settings.json.
  const backup = await backupSettings(claudeHome, (opts.now ?? (() => new Date()))());

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
  //    (http daemon + command fallback). Secret is loaded/created lazily
  //    here so a declined install never leaves a stray secret behind.
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

  // 6. Symlink slash commands.
  await symlinkCommands(pluginCommandsDir, claudeCommandsDir);

  io.write(`\n=== Installed ===\n`);
  io.write(`  ${personality.name} the ${personality.species} is ready.\n`);
  io.write(`  config:  ${join(home, "config.json")}\n`);
  io.write(`  backup:  ${backup.symlink}\n`);
  io.write(`\n  Restart Claude Code to bring ${personality.name} to life.\n`);

  return {
    status: "installed",
    wrapper_command: wrapperCommand,
    hook_command: hookCommand,
    inner_command: currentStatusStr,
    config_path: join(home, "config.json"),
    backup_path: backup.path,
    personality_seed_used: Boolean(personality.seedUsedAt),
  };
}

if (import.meta.main) {
  const noninteractive = process.argv.includes("--noninteractive");
  const wantJson = process.argv.includes("--json");
  const result = await runInstall({ noninteractive });
  if (wantJson) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  }
  process.exit(0);
}
