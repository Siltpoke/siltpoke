// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
// Copyright (c) 2026 Jiaqi Duan
import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

export interface PersonalityConfig {
  name: string;
  species: string;
  snark: number;
  patience: number;
  rigor: number;
  chattiness: number;
  curiosity: number;
  language: string;
}

export const DEFAULT_PERSONALITY: PersonalityConfig = {
  name: "Siltpoke",
  species: "slime",
  snark: 5,
  patience: 5,
  rigor: 5,
  chattiness: 5,
  curiosity: 5,
  language: "en",
};

export interface DialSet {
  snark: number;
  patience: number;
  rigor: number;
  chattiness: number;
  curiosity: number;
}

// Per-species default dials. slime = all-5 (the historical flat default);
// the others give each species a distinct out-of-the-box voice. Applied at
// pet CREATION (first-run wizard) only — existing configs are untouched.
export const SPECIES_PROFILES: Record<string, DialSet> = {
  slime: { snark: 5, patience: 5, rigor: 5, chattiness: 5, curiosity: 5 },
  cat: { snark: 8, patience: 2, rigor: 4, chattiness: 5, curiosity: 7 },
  owl: { snark: 3, patience: 8, rigor: 9, chattiness: 5, curiosity: 8 },
  robot: { snark: 2, patience: 7, rigor: 10, chattiness: 2, curiosity: 3 },
  bunny: { snark: 1, patience: 9, rigor: 5, chattiness: 8, curiosity: 5 },
};

export function speciesDefaults(species: string): DialSet {
  return SPECIES_PROFILES[species] ?? SPECIES_PROFILES.slime;
}

export async function loadPersonality(
  basePath: string,
): Promise<PersonalityConfig> {
  const configPath = join(basePath, "config.json");
  if (!existsSync(configPath)) return DEFAULT_PERSONALITY;
  try {
    const raw = await readFile(configPath, "utf8");
    const parsed = JSON.parse(raw) as Partial<PersonalityConfig> & {
      debug_skill?: number;
    };
    // v1 → v2 migration: old configs had `debug_skill`; reuse the same
    // number as `rigor` since the semantics overlap (methodical-ness).
    const migrated: Partial<PersonalityConfig> = { ...parsed };
    if (typeof parsed.debug_skill === "number" && typeof migrated.rigor !== "number") {
      migrated.rigor = parsed.debug_skill;
    }
    delete (migrated as { debug_skill?: number }).debug_skill;
    return { ...DEFAULT_PERSONALITY, ...migrated };
  } catch {
    return DEFAULT_PERSONALITY;
  }
}

const LANGUAGE_NAMES: Record<string, string> = {
  en: "English",
  "zh-CN": "Simplified Chinese (中文)",
  "zh-TW": "Traditional Chinese (繁體中文)",
  ja: "Japanese (日本語)",
  ko: "Korean (한국어)",
  es: "Spanish",
  fr: "French",
  de: "German",
};

export function expandLanguage(codeOrName: string): string {
  return LANGUAGE_NAMES[codeOrName] ?? codeOrName;
}

export interface PersonalityDrift {
  snark?: number;
  patience?: number;
  rigor?: number;
  chattiness?: number;
  curiosity?: number;
  style_strictness?: number;
  proactivity?: number;
}

function clampDrift(value: number | undefined): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return 0;
  return Math.max(-3, Math.min(3, Math.trunc(value)));
}

function clampStat(value: number): number {
  return Math.max(0, Math.min(10, Math.round(value)));
}

export function applyDrift(
  personality: PersonalityConfig,
  drift: PersonalityDrift | null | undefined,
): PersonalityConfig {
  if (!drift) return personality;
  return {
    ...personality,
    snark: clampStat(personality.snark + clampDrift(drift.snark)),
    patience: clampStat(personality.patience + clampDrift(drift.patience)),
    rigor: clampStat(personality.rigor + clampDrift(drift.rigor)),
    chattiness: clampStat(personality.chattiness + clampDrift(drift.chattiness)),
    curiosity: clampStat(personality.curiosity + clampDrift(drift.curiosity)),
  };
}

export async function buildSystemPrompt(
  personality: PersonalityConfig,
  templatePath?: string,
  drift?: PersonalityDrift | null,
): Promise<string> {
  const effective = applyDrift(personality, drift);
  const here = dirname(fileURLToPath(import.meta.url));
  const path = templatePath ?? join(here, "system-prompt.md");
  const template = await readFile(path, "utf8");
  return template
    .replaceAll("{name}", effective.name)
    .replaceAll("{species}", effective.species)
    .replaceAll("{snark}", String(effective.snark))
    .replaceAll("{patience}", String(effective.patience))
    .replaceAll("{rigor}", String(effective.rigor))
    .replaceAll("{chattiness}", String(effective.chattiness))
    .replaceAll("{curiosity}", String(effective.curiosity))
    .replaceAll("{language}", expandLanguage(effective.language));
}
