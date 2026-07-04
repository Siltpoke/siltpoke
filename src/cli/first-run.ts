// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
// Copyright (c) 2026 Jiaqi Duan
import { mkdir, writeFile, readFile, rename } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { randomBytes } from "node:crypto";
import {
  resolveClaudeHome,
  siltpokeRoot,
} from "../installer/paths";
import {
  realWizardIO,
  type WizardIO,
} from "../installer/wizard";
import {
  runPersonalityWizard,
  type Personality,
  type Language,
} from "../installer/personality-wizard";
import { DEFAULT_SPECIES } from "../face/species";
import { speciesDefaults } from "../brain/personality";

export interface FirstRunOptions {
  env?: NodeJS.ProcessEnv;
  io?: WizardIO;
  noninteractive?: boolean;
}

export interface FirstRunResult {
  status: "written" | "internal_subprocess";
  config_path: string;
  personality_seed_used: boolean;
}

async function atomicWriteJson(path: string, data: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.tmp.${process.pid}.${Date.now()}.${randomBytes(4).toString("hex")}`;
  await writeFile(tmp, JSON.stringify(data, null, 2), "utf8");
  await rename(tmp, path);
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

async function loadExistingDefaults(
  configPath: string,
): Promise<Partial<Personality> | undefined> {
  if (!existsSync(configPath)) return undefined;
  try {
    const raw = JSON.parse(await readFile(configPath, "utf8")) as Record<string, unknown>;
    const out: Partial<Personality> = {};
    if (typeof raw.name === "string") out.name = raw.name;
    if (typeof raw.species === "string") out.species = raw.species;
    if (typeof raw.language === "string") out.language = raw.language as Language;
    if (typeof raw.snark === "number") out.snark = raw.snark;
    if (typeof raw.patience === "number") out.patience = raw.patience;
    if (typeof raw.rigor === "number") out.rigor = raw.rigor;
    else if (typeof raw.debug_skill === "number") out.rigor = raw.debug_skill; // v1→v2 migration
    if (typeof raw.chattiness === "number") out.chattiness = raw.chattiness;
    if (typeof raw.curiosity === "number") out.curiosity = raw.curiosity;
    return out;
  } catch {
    return undefined;
  }
}

export async function runFirstRun(
  opts: FirstRunOptions = {},
): Promise<FirstRunResult> {
  const env = opts.env ?? process.env;
  if (env.SILTPOKE_INTERNAL === "1") {
    return {
      status: "internal_subprocess",
      config_path: "",
      personality_seed_used: false,
    };
  }

  const home = siltpokeRoot(env);
  const claudeHome = resolveClaudeHome(env);
  const configPath = join(home, "config.json");
  const noninteractive =
    opts.noninteractive ?? !(process.stdin as { isTTY?: boolean }).isTTY;
  const io = opts.io ?? realWizardIO();

  const existing = await loadExistingDefaults(configPath);
  // Species-aware fallback for any dial the config omits — a missing dial on a
  // known non-slime species fills from that species' profile, not a flat 5.
  const species = existing?.species ?? DEFAULT_SPECIES;
  const prof = speciesDefaults(species);
  if (existing) {
    io.write(
      `\n=== Re-rolling ${existing.name ?? "Siltpoke"} the ${existing.species ?? "slime"}'s personality ===\n`,
    );
    io.write(
      `  Press Enter at any prompt to keep your current pick.\n  Existing dials: snark=${existing.snark ?? prof.snark}, patience=${existing.patience ?? prof.patience}, rigor=${existing.rigor ?? prof.rigor}, chattiness=${existing.chattiness ?? prof.chattiness}, curiosity=${existing.curiosity ?? prof.curiosity}\n\n`,
    );
  } else {
    io.write(`\n=== Siltpoke personality wizard ===\n\n`);
  }

  let personality: Personality;
  if (noninteractive) {
    personality = {
      name: existing?.name ?? "Siltpoke",
      species,
      language: existing?.language ?? "en",
      snark: existing?.snark ?? prof.snark,
      patience: existing?.patience ?? prof.patience,
      rigor: existing?.rigor ?? prof.rigor,
      chattiness: existing?.chattiness ?? prof.chattiness,
      curiosity: existing?.curiosity ?? prof.curiosity,
      method: "defaults",
    };
  } else {
    personality = await runPersonalityWizard({
      io,
      claudeHome,
      defaults: existing,
    });
  }

  await atomicWriteJson(configPath, personalityToConfig(personality));

  io.write(`\n  ${personality.name} the ${personality.species} written.\n`);
  io.write(`  config: ${configPath}\n`);

  return {
    status: "written",
    config_path: configPath,
    personality_seed_used: Boolean(personality.seedUsedAt),
  };
}

if (import.meta.main) {
  const noninteractive = process.argv.includes("--noninteractive");
  const wantJson = process.argv.includes("--json");
  const result = await runFirstRun({ noninteractive });
  if (wantJson) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  }
  process.exit(0);
}
