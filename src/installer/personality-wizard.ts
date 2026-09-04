// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
// Copyright (c) 2026 Jiaqi Duan
import {
  askText,
  askChoice,
  askLabeledChoice,
  askNumber,
  askYesNo,
  type WizardIO,
} from "./wizard";
import { listSpeciesNames, DEFAULT_SPECIES } from "../face/species";
import { speciesDefaults } from "../brain/personality";
import {
  findMemoryFiles,
  generateFromMemory,
  generateSoulFromQuiz,
  scoreQuiz,
  archetypeOf,
  randomName,
  applyMatchMode,
  QUIZ_LIKERT_ITEMS,
  QUIZ_FINALES,
  type Dials,
  type FinaleLetter,
  type MatchMode,
  type QuizAnswers,
  type QuizLikertAnswer,
} from "./personality-seed";

export const LANGUAGES = [
  { value: "en", label: "English (en)" },
  { value: "zh-CN", label: "简体中文 / Simplified Chinese (zh-CN)" },
  { value: "zh-TW", label: "繁體中文 / Traditional Chinese (zh-TW)" },
  { value: "ja", label: "日本語 / Japanese (ja)" },
  { value: "ko", label: "한국어 / Korean (ko)" },
  { value: "es", label: "Español / Spanish (es)" },
  { value: "fr", label: "Français / French (fr)" },
  { value: "de", label: "Deutsch / German (de)" },
] as const;

export type Language = (typeof LANGUAGES)[number]["value"];

export interface PersonalityRationale {
  snark?: string;
  patience?: string;
  rigor?: string;
  chattiness?: string;
  curiosity?: string;
}

export interface Personality {
  name: string;
  species: string;
  language: Language;
  snark: number;
  patience: number;
  rigor: number;
  chattiness: number;
  curiosity: number;
  /** Pure-function archetype label derived from dials. */
  archetype?: string;
  soul?: string;
  seedUsedAt?: string;
  rationale?: PersonalityRationale;
  seedMemoryFiles?: string[];
  /** Method picked in the wizard. Recorded for telemetry / re-roll context. */
  method?: "defaults" | "manual" | "random" | "quiz" | "memory";
  /** How the pet's dials relate to the user — mirror / complement / hybrid. */
  matchMode?: MatchMode;
}

type MethodValue = "defaults" | "manual" | "random" | "quiz" | "memory";

function buildMethods(
  memoryFileCount: number,
): { value: MethodValue; label: string }[] {
  const methods: { value: MethodValue; label: string }[] = [
    {
      value: "defaults",
      label: "Use defaults (all 5 dials at 5/10 — neutral mid)",
    },
    {
      value: "manual",
      label:
        "Customize all 5 dials manually (snark / patience / rigor / chattiness / curiosity, 0-10)",
    },
    { value: "random", label: "Random — roll all 5 dials 0-10" },
    {
      value: "quiz",
      label:
        "Take a quick personality quiz — 5 statements + a few scenarios (~$0.001 Brain call, ~90 seconds)",
    },
  ];
  if (memoryFileCount > 0) {
    methods.push({
      value: "memory",
      label: `Read your global ~/.claude/ files — ${memoryFileCount} found (CLAUDE.md + rules/ + memory/), ~$0.001 Brain call`,
    });
  }
  return methods;
}

export interface PersonalityWizardOptions {
  io: WizardIO;
  claudeHome: string;
  defaults?: Partial<Personality>;
}

function rand0to10(): number {
  return Math.floor(Math.random() * 11);
}

const LIKERT_LABELS = [
  "Strongly disagree",
  "Disagree",
  "Neutral",
  "Agree",
  "Strongly agree",
] as const;

async function askLikert(
  io: WizardIO,
  question: string,
): Promise<1 | 2 | 3 | 4 | 5> {
  const choice = await askLabeledChoice<string>(
    io,
    question,
    LIKERT_LABELS.map((label, i) => ({ value: String(i + 1), label })),
    "3",
  );
  const n = parseInt(choice, 10);
  return (n >= 1 && n <= 5 ? n : 3) as 1 | 2 | 3 | 4 | 5;
}

function logDials(io: WizardIO, dials: Dials, rationale?: PersonalityRationale) {
  const arche = archetypeOf(dials);
  io.write(`    archetype: ${arche}\n`);
  const fields: (keyof Dials)[] = [
    "snark",
    "patience",
    "rigor",
    "chattiness",
    "curiosity",
  ];
  for (const k of fields) {
    io.write(`    ${k}=${dials[k]}`);
    if (rationale?.[k]) io.write(`   ← ${rationale[k]}`);
    io.write(`\n`);
  }
}

export async function runPersonalityWizard(
  opts: PersonalityWizardOptions,
): Promise<Personality> {
  const { io, claudeHome } = opts;
  const d = opts.defaults ?? {};

  // ---- name (Enter → random, or keep existing if re-rolling) ----
  const existingName = d.name;
  const namePrompt = existingName
    ? `Name your Siltpoke (Enter to keep "${existingName}", or type a new name):`
    : `Name your Siltpoke (type your own, or press Enter for a random name like "Velvetpaw"):`;
  const rawName = await askText(io, namePrompt, existingName ?? "");

  // ---- species ----
  const species = await askChoice(
    io,
    "Pick a species:",
    listSpeciesNames(),
    d.species ?? DEFAULT_SPECIES,
  );

  // Resolve name AFTER species so we can species-bias the noun pool.
  // Empty input OR literal "random" → roll a new one.
  let name = rawName.trim();
  if (name === "" || name.toLowerCase() === "random") {
    name = randomName(species);
    io.write(`  ✓ rolled: ${name}\n`);
  }

  // ---- language ----
  const language = await askLabeledChoice<Language>(
    io,
    "Preferred bubble language:",
    LANGUAGES,
    d.language ?? "en",
  );

  // ---- personality method ----
  const memoryFiles = await findMemoryFiles(claudeHome);
  const methods = buildMethods(memoryFiles.length);
  let method: MethodValue = await askLabeledChoice<MethodValue>(
    io,
    "How should we set Siltpoke's personality?",
    methods,
    "defaults",
  );

  // ---- match mode (only for quiz / memory — defaults/manual/random
  //      don't carry a user-vs-pet relationship) ----
  let matchMode: MatchMode = "mirror";
  if (method === "quiz" || method === "memory") {
    matchMode = await askLabeledChoice<MatchMode>(
      io,
      "How should the pet relate to YOUR personality?",
      [
        {
          value: "mirror",
          label: "Mirror — pet matches your vibe (same energy, gets you)",
        },
        {
          value: "complement",
          label:
            "Complement — pet fills your gaps (your weaknesses become its strengths)",
        },
        {
          value: "hybrid",
          label:
            "Hybrid — vibe matches you, but it fills your blindspots (recommended)",
        },
      ],
      "hybrid",
    );
  }

  const prof = speciesDefaults(species);
  let dials: Dials = {
    snark: d.snark ?? prof.snark,
    patience: d.patience ?? prof.patience,
    rigor: d.rigor ?? prof.rigor,
    chattiness: d.chattiness ?? prof.chattiness,
    curiosity: d.curiosity ?? prof.curiosity,
  };
  let soul: string | undefined;
  let seedUsedAt: string | undefined;
  let rationale: PersonalityRationale | undefined;
  let seedMemoryFiles: string[] | undefined;

  if (method === "defaults") {
    dials = { ...prof };
  } else if (method === "manual") {
    io.write(`  All five dials, 0-10 each. Press Enter to keep the shown default.\n`);
    dials.snark = await askNumber(io, "snark (0 = sweet, 10 = savage):", {
      min: 0, max: 10, default: dials.snark,
    });
    dials.patience = await askNumber(
      io,
      "patience (0 = trigger-happy, 10 = saintly):",
      { min: 0, max: 10, default: dials.patience },
    );
    dials.rigor = await askNumber(
      io,
      "rigor (0 = vibes, 10 = methodical):",
      { min: 0, max: 10, default: dials.rigor },
    );
    dials.chattiness = await askNumber(
      io,
      "chattiness (0 = terse, 10 = verbose):",
      { min: 0, max: 10, default: dials.chattiness },
    );
    dials.curiosity = await askNumber(
      io,
      "curiosity (0 = by-the-book, 10 = exploratory):",
      { min: 0, max: 10, default: dials.curiosity },
    );
  } else if (method === "random") {
    dials = {
      snark: rand0to10(),
      patience: rand0to10(),
      rigor: rand0to10(),
      chattiness: rand0to10(),
      curiosity: rand0to10(),
    };
    io.write(`  rolled:\n`);
    logDials(io, dials);
  }

  // Memory preview + fallback-to-quiz offer
  if (method === "memory") {
    io.write(`\n  Reading ${memoryFiles.length} memory file(s):\n`);
    for (const f of memoryFiles) {
      io.write(`    · ${f}\n`);
    }
    io.write(
      `\n  Heads up: Brain works best when these files describe YOU\n  (preferences, working style, pet peeves) rather than generic\n  coding rules. If the list above looks like style guides or\n  generic rules, the quiz will give a more personal result.\n`,
    );
    const proceed = await askYesNo(
      io,
      `Use these files to calibrate ${name}'s personality?`,
      { default: "yes" },
    );
    if (!proceed) {
      io.write(`  Switching to quiz mode instead.\n`);
      method = "quiz";
    }
  }

  if (method === "quiz") {
    io.write(
      `\n  Quick personality quiz — 5 statements + ${QUIZ_FINALES.length} scenarios.\n`,
    );
    io.write(`  Rate each from 1 (strongly disagree) to 5 (strongly agree).\n\n`);
    const likertAnswers: QuizLikertAnswer[] = [];
    for (let i = 0; i < QUIZ_LIKERT_ITEMS.length; i++) {
      const item = QUIZ_LIKERT_ITEMS[i]!;
      const score = await askLikert(io, `Q${i + 1}. "${item.text}"`);
      likertAnswers.push({ itemIndex: i, score });
    }

    io.write(`\n  A few scenario questions:\n\n`);
    const finaleAnswers: FinaleLetter[] = [];
    for (const scenario of QUIZ_FINALES) {
      const choice = await askLabeledChoice<FinaleLetter>(
        io,
        scenario.text,
        scenario.options.map((o) => ({ value: o.letter, label: o.text })),
        scenario.options[0]!.letter,
      );
      finaleAnswers.push(choice);
    }

    const answers: QuizAnswers = {
      likert: likertAnswers,
      finales: finaleAnswers,
    };
    dials = scoreQuiz(answers, matchMode);

    io.write(
      `\n  Computed dials from your answers. Asking Brain for soul + rationale...\n\n`,
    );
    const soulResult = await generateSoulFromQuiz({
      answers,
      dials,
      userPickedName: name,
      userPickedSpecies: species,
    });
    if (soulResult) {
      soul = soulResult.soul;
      rationale = soulResult.rationale;
      seedUsedAt = new Date().toISOString();
      io.write(`  ✓ ${name} the ${species}\n`);
      io.write(`    soul:        ${soul}\n`);
      logDials(io, dials, rationale);
    } else {
      io.write(`  ! Brain didn't return soul + rationale, but dials are set.\n`);
      io.write(`  ✓ ${name} the ${species}\n`);
      logDials(io, dials);
    }
  }

  if (method === "memory") {
    io.write(
      `\n  Asking Brain to calibrate ${name} the ${species}'s dials from these...\n\n`,
    );
    const seed = await generateFromMemory({
      memoryFiles,
      userPickedName: name,
      userPickedSpecies: species,
    });
    if (seed) {
      // Brain returns dials that MIRROR the user. Apply match-mode transform
      // — mirror passes through, complement/hybrid flip the relevant dials.
      const mirroredDials: Dials = {
        snark: seed.snark,
        patience: seed.patience,
        rigor: seed.rigor,
        chattiness: seed.chattiness,
        curiosity: seed.curiosity,
      };
      dials = applyMatchMode(mirroredDials, matchMode);
      soul = seed.soul;
      seedUsedAt = new Date().toISOString();
      rationale = seed.rationale;
      seedMemoryFiles = [...memoryFiles];
      io.write(`  ✓ ${name} the ${species}\n`);
      io.write(`    soul:        ${seed.soul}\n`);
      if (matchMode !== "mirror") {
        io.write(
          `    (Brain's read of your vibe: snark=${mirroredDials.snark}, patience=${mirroredDials.patience}, rigor=${mirroredDials.rigor}, chattiness=${mirroredDials.chattiness}, curiosity=${mirroredDials.curiosity}.\n     Applied "${matchMode}" match-mode → final dials below.)\n`,
        );
      }
      logDials(io, dials, rationale);
    } else {
      // Seed generation failed — fall back to the SPECIES profile, not a flat
      // all-5 (a failed cat should still land the cat defaults, not lose its
      // species identity on an error path).
      dials = { ...prof };
      io.write(
        `  ! Brain didn't return a valid personality JSON. Keeping the ${species} defaults (snark=${prof.snark}, patience=${prof.patience}, rigor=${prof.rigor}, chattiness=${prof.chattiness}, curiosity=${prof.curiosity}).\n`,
      );
      io.write(
        `    (Your name/species/language picks are kept. You can re-roll later with \`bun run edit-personality\`.)\n`,
      );
    }
  }

  // Always compute archetype from final dials
  const archetype = archetypeOf(dials);
  // Defaults / manual / random paths haven't printed archetype yet — do it now
  if (method === "defaults" || method === "manual") {
    io.write(`\n  archetype: ${archetype}\n`);
  }

  return {
    name,
    species,
    language,
    snark: dials.snark,
    patience: dials.patience,
    rigor: dials.rigor,
    chattiness: dials.chattiness,
    curiosity: dials.curiosity,
    archetype,
    soul,
    seedUsedAt,
    rationale,
    seedMemoryFiles,
    method,
    matchMode: method === "quiz" || method === "memory" ? matchMode : undefined,
  };
}
