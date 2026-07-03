// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Copyright (c) 2026 Jiaqi Duan
import { readFile, readdir, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { z } from "zod";
import { callBrainRaw, BrainError } from "../brain/brain";

// ---------------------------------------------------------------------------
// Personality dial schema (v2)
//
// 5 Big-Five-aligned dials. Each 0..10, default 5 (neutral). Pet behavior
// derives from combinations — pet's "debug skill" was a v1 dial, but
// competence isn't a personality trait, so it's gone. Methodical-vs-vibes
// is now `rigor`. New dials: `chattiness` (length/freq of bubbles) and
// `curiosity` (alternatives-suggesting vs by-the-book).
// ---------------------------------------------------------------------------

export const DIALS = [
  "snark",
  "patience",
  "rigor",
  "chattiness",
  "curiosity",
] as const;
export type DialKey = (typeof DIALS)[number];

// VIBE dials affect HOW the pet talks (tone, volume) — mirror-matched
// to user's vibe so the pet feels familiar.
export const VIBE_DIALS: readonly DialKey[] = ["snark", "chattiness"];

// TASK dials affect WHAT the pet flags (rigor, patience, exploration).
// Complement-matched in some modes so the pet fills the user's blindspots
// instead of sharing them.
export const TASK_DIALS: readonly DialKey[] = ["rigor", "patience", "curiosity"];

export type MatchMode = "mirror" | "complement" | "hybrid";

/** Returns +1 (mirror) or -1 (complement) for a given dial under a given match mode. */
export function dialPolarity(
  dial: DialKey,
  mode: MatchMode,
): 1 | -1 {
  if (mode === "mirror") return 1;
  if (mode === "complement") return -1;
  // hybrid: vibe = mirror, task = complement
  return (VIBE_DIALS as readonly DialKey[]).includes(dial) ? 1 : -1;
}

export const personalitySeedSchema = z.object({
  snark: z.number().int().min(0).max(10),
  patience: z.number().int().min(0).max(10),
  rigor: z.number().int().min(0).max(10),
  chattiness: z.number().int().min(0).max(10),
  curiosity: z.number().int().min(0).max(10),
  soul: z.string().min(1).max(280),
  rationale: z
    .object({
      snark: z.string().max(280).optional(),
      patience: z.string().max(280).optional(),
      rigor: z.string().max(280).optional(),
      chattiness: z.string().max(280).optional(),
      curiosity: z.string().max(280).optional(),
    })
    .optional(),
  generated_from_memory_at: z.string(),
});

export type PersonalitySeed = z.infer<typeof personalitySeedSchema>;

// Soul-only schema for quiz mode — dials are computed locally, Brain
// only writes the soul + rationale.
export const soulOnlySchema = z.object({
  soul: z.string().min(1).max(280),
  rationale: z
    .object({
      snark: z.string().max(280).optional(),
      patience: z.string().max(280).optional(),
      rigor: z.string().max(280).optional(),
      chattiness: z.string().max(280).optional(),
      curiosity: z.string().max(280).optional(),
    })
    .optional(),
});
export type SoulOnly = z.infer<typeof soulOnlySchema>;

// ---------------------------------------------------------------------------
// Quiz: 5 Likert + 1 BuzzFeed-style finale
//
// v3 design:
// each Likert item targets exactly ONE dial. v2 multi-axis items (e.g. the
// "stove" and "temper" questions) felt random because user couldn't trace
// why one answer moved three dials. Mono-axis items match IPIP/16P/HEXACO
// convention and give the rationale-writer a clean attribution.
//
// One item is reverse-scored (Q4 curiosity) to fight acquiescence bias.
//
// MBTI-style 5th axis (Assertive/Turbulent) is folded into `patience`:
// low patience ≈ turbulent, high patience ≈ assertive. We don't add a 6th
// dial because the archetype table is already 16 entries × curiosity
// prefix and patience already carries the behavioral signal.
//
// Each Likert item declares its dial impact at score=5 (strongly agree).
// Other scores (1..4) scale linearly. Reverse-scored items flip the sign.
// ---------------------------------------------------------------------------

export interface DialDelta {
  snark?: number;
  patience?: number;
  rigor?: number;
  chattiness?: number;
  curiosity?: number;
}

export interface LikertItem {
  text: string;
  /** Dial deltas applied at score=5 (strongly agree). Scaled by Likert position. */
  impact: DialDelta;
  /** If true, flip dial-delta sign before applying. Fights acquiescence bias. */
  reverse?: boolean;
}

export const QUIZ_LIKERT_ITEMS: readonly LikertItem[] = [
  {
    // snark only — life / light. funny vs polite was a weak dichotomy
    // (you can be both); sharp vs sweet is a real tonal opposition.
    text: "I'd rather be sharp than sweet.",
    impact: { snark: 2 },
  },
  {
    // patience only — life / mundane
    text: "I let small things slide.",
    impact: { patience: 2 },
  },
  {
    // rigor only — dev-flavored / one dev item to anchor the quiz to code
    text: "Before I push code, I re-read my own diff line by line.",
    impact: { rigor: 2 },
  },
  {
    // chattiness only — life / introspective
    text: "I think out loud, even when nobody's listening.",
    impact: { chattiness: 2 },
  },
  {
    // curiosity only — reverse-scored to catch "agree to everything" bias.
    // Agree = "I stop looking once something works" → curiosity DOWN.
    text: "Once I find a way that works, I stop looking for other ways.",
    impact: { curiosity: 2 },
    reverse: true,
  },
] as const;

export interface FinaleChoice {
  letter: "a" | "b" | "c" | "d";
  text: string;
  impact: DialDelta;
}

export interface FinaleQuestion {
  text: string;
  options: readonly FinaleChoice[];
}

export const QUIZ_FINALE: FinaleQuestion = {
  text: "Your pet finds a bug while you're asleep. It:",
  options: [
    {
      letter: "a",
      text: "Writes a haiku roasting you and pins it to your desk",
      impact: { snark: 2, rigor: 1, chattiness: 1 },
    },
    {
      letter: "b",
      text: "Leaves a polite sticky note with the file:line",
      impact: { snark: -1, patience: 1, rigor: 1 },
    },
    {
      letter: "c",
      text: "Fixes it silently and takes the credit at standup",
      impact: { rigor: 2, snark: 1, curiosity: 1 },
    },
    {
      letter: "d",
      text: "Shrugs. You'll find it eventually.",
      impact: { rigor: -2, patience: 1, chattiness: -1 },
    },
  ],
} as const;

export interface QuizLikertAnswer {
  itemIndex: number;
  /** 1 = strongly disagree, 5 = strongly agree. */
  score: 1 | 2 | 3 | 4 | 5;
}

export interface QuizFinaleAnswer {
  letter: "a" | "b" | "c" | "d";
}

export interface QuizAnswers {
  likert: readonly QuizLikertAnswer[];
  finale: QuizFinaleAnswer;
}

export interface Dials {
  snark: number;
  patience: number;
  rigor: number;
  chattiness: number;
  curiosity: number;
}

function clip(n: number): number {
  return Math.max(0, Math.min(10, Math.round(n)));
}

/**
 * Score a Likert response (1-5) into a multiplier:
 *   1 → -1.0,  2 → -0.5,  3 → 0,  4 → +0.5,  5 → +1.0
 */
function likertMultiplier(score: 1 | 2 | 3 | 4 | 5): number {
  return (score - 3) / 2;
}

/**
 * Pure function: quiz answers + match mode → final dial values. No Brain required.
 *
 * matchMode controls how user's revealed traits map to pet dials:
 *   - "mirror"     — pet mirrors user (default for v1 compat). Snarky user → snarky pet.
 *   - "complement" — pet inverts user. Lazy user → rigorous pet.
 *   - "hybrid"     — vibe dials mirror (relatable), task dials complement (fills gaps).
 */
export function scoreQuiz(
  answers: QuizAnswers,
  matchMode: MatchMode = "mirror",
): Dials {
  const dials: Dials = {
    snark: 5,
    patience: 5,
    rigor: 5,
    chattiness: 5,
    curiosity: 5,
  };

  for (const a of answers.likert) {
    const item = QUIZ_LIKERT_ITEMS[a.itemIndex];
    if (!item) continue;
    const mult = likertMultiplier(a.score) * (item.reverse ? -1 : 1);
    for (const k of DIALS) {
      const delta = item.impact[k];
      if (typeof delta === "number") {
        dials[k] += delta * mult * dialPolarity(k, matchMode);
      }
    }
  }

  const finaleChoice = QUIZ_FINALE.options.find(
    (o) => o.letter === answers.finale.letter,
  );
  if (finaleChoice) {
    for (const k of DIALS) {
      const delta = finaleChoice.impact[k];
      if (typeof delta === "number") {
        dials[k] += delta * dialPolarity(k, matchMode);
      }
    }
  }

  return {
    snark: clip(dials.snark),
    patience: clip(dials.patience),
    rigor: clip(dials.rigor),
    chattiness: clip(dials.chattiness),
    curiosity: clip(dials.curiosity),
  };
}

/**
 * Apply match-mode transform to Brain-supplied dials (memory mode).
 * Brain always returns dials that MIRROR the user; this function flips
 * the relevant dials per mode.
 *
 * Math: complement = 10 - dial. So Brain reading "user is lazy" → rigor=2
 * gets flipped to rigor=8 for complement mode.
 */
export function applyMatchMode(dials: Dials, mode: MatchMode): Dials {
  const flip = (v: number) => 10 - v;
  return {
    snark: dialPolarity("snark", mode) === 1 ? dials.snark : flip(dials.snark),
    patience: dialPolarity("patience", mode) === 1 ? dials.patience : flip(dials.patience),
    rigor: dialPolarity("rigor", mode) === 1 ? dials.rigor : flip(dials.rigor),
    chattiness: dialPolarity("chattiness", mode) === 1 ? dials.chattiness : flip(dials.chattiness),
    curiosity: dialPolarity("curiosity", mode) === 1 ? dials.curiosity : flip(dials.curiosity),
  };
}

// ---------------------------------------------------------------------------
// Archetype: 4-dial base × curiosity modifier prefix → final label
// ---------------------------------------------------------------------------

/** 16 base archetype names, one per snark×patience×rigor×chattiness quadrant. */
function baseArchetype(d: Dials): string {
  const s = d.snark >= 6;
  const p = d.patience >= 6;
  const r = d.rigor >= 6;
  const c = d.chattiness >= 6;

  // 4-bit lookup — order: snark, patience, rigor, chattiness
  const key = `${s ? 1 : 0}${p ? 1 : 0}${r ? 1 : 0}${c ? 1 : 0}`;

  const table: Record<string, string> = {
    "1010": "The Hawk",
    "1011": "The Drill Sergeant",
    "1110": "The Sly Fox",
    "1111": "The Wry Coach",
    "1000": "The Snapper",
    "1001": "The Rant",
    "1100": "The Tease",
    "1101": "The Roaster",
    "0010": "The Perfectionist",
    "0011": "The Anxious Officer",
    "0110": "The Patient Sage",
    "0111": "The Saint",
    "0000": "The Worrier",
    "0001": "The Frantic",
    "0100": "The Zen Monk",
    "0101": "The Cheerleader",
  };

  return table[key] ?? "The Centrist";
}

/** Final archetype label = curiosity prefix + base archetype. */
export function archetypeOf(d: Dials): string {
  const base = baseArchetype(d);
  const prefix =
    d.curiosity >= 7 ? "Curious " : d.curiosity <= 3 ? "Steady " : "";
  return `${prefix}${base}`;
}

// ---------------------------------------------------------------------------
// Random name combinator
//
// 50 × 50 = 2500 combinations. English. Optional species bias on the noun.
// ---------------------------------------------------------------------------

const NAME_ADJECTIVES = [
  "Mochi", "Velvet", "Glitchy", "Toasty", "Snappy", "Wobble", "Crispy",
  "Fuzzy", "Sleepy", "Sassy", "Sparky", "Drowsy", "Cosmic", "Drippy",
  "Wonky", "Soggy", "Bouncy", "Salty", "Squishy", "Crumbly", "Pickled",
  "Doodle", "Bubbly", "Frosty", "Mossy", "Sunny", "Murky", "Glossy",
  "Plucky", "Cranky", "Snazzy", "Witty", "Cozy", "Tipsy", "Dappled",
  "Spicy", "Sweetish", "Rascal", "Tiny", "Mighty", "Loafy", "Pesto",
  "Buttery", "Jellied", "Honey", "Maple", "Cinnamon", "Pepper", "Inky",
  "Yam",
] as const;

const NAME_NOUNS_GENERIC = [
  "Paw", "Crumb", "Pip", "Sprout", "Wisp", "Pebble", "Bean", "Sock",
  "Bit", "Byte", "Whisker", "Smudge", "Twig", "Acorn", "Bubble", "Fang",
  "Toe", "Comet", "Buddy", "Loaf", "Bun", "Pat", "Snout", "Tail",
  "Spec", "Nibble", "Stomp", "Pixel", "Glitch", "Boop", "Squiggle",
  "Pancake", "Dumpling", "Noodle", "Bao", "Tofu", "Miso", "Yuzu",
  "Knoll", "Twirl", "Hum", "Drip", "Pebble", "Spark", "Hop", "Skip",
  "Pounce", "Wisper", "Glint", "Dash",
] as const;

const SPECIES_NOUNS: Record<string, readonly string[]> = {
  cat: ["Paw", "Whisker", "Tail", "Pounce", "Purr", "Mew"],
  robot: ["Bolt", "Pixel", "Byte", "Glitch", "Bit", "Spark"],
  bunny: ["Hop", "Bun", "Tail", "Twitch", "Boop", "Skip"],
  owl: ["Hoot", "Talon", "Wing", "Feather", "Blink"],
  slime: ["Blob", "Wobble", "Drip", "Squish", "Glob", "Ooze"],
};

function pickFrom<T>(arr: readonly T[], rng: () => number = Math.random): T {
  return arr[Math.floor(rng() * arr.length)]!;
}

export function randomName(
  species?: string,
  rng: () => number = Math.random,
): string {
  const adj = pickFrom(NAME_ADJECTIVES, rng);
  const speciesNouns = species
    ? SPECIES_NOUNS[species.toLowerCase()]
    : undefined;
  // Bias: 60% chance to draw from species-specific pool if available
  const useSpecies = speciesNouns && rng() < 0.6;
  const noun = pickFrom(useSpecies ? speciesNouns : NAME_NOUNS_GENERIC, rng);
  // Sentence-case single word: only first letter upper, rest lower
  // e.g. "Velvetpaw", "Glitchypixel", "Sleepybolt"
  const joined = (adj + noun).toLowerCase();
  return joined.charAt(0).toUpperCase() + joined.slice(1);
}

// ---------------------------------------------------------------------------
// Brain prompts
// ---------------------------------------------------------------------------

export const SEED_PROMPT = `You are calibrating Siltpoke, a sassy ASCII terminal buddy who watches developers work.

The user has ALREADY chosen Siltpoke's name and species — those are NOT yours to change. Your job is to read their global Claude Code memory files (in the user message) and pick FIVE personality DIALS that match their working style, plus write a one-line soul description and per-dial rationale.

Output exactly one JSON object and nothing else:

{
  "snark": number,         // 0..10, sass vs sweetness
  "patience": number,      // 0..10, chill vs trigger-happy at user's mistakes
  "rigor": number,         // 0..10, vibes-based vs methodical (cites evidence)
  "chattiness": number,    // 0..10, terse vs verbose bubbles
  "curiosity": number,     // 0..10, by-the-book vs suggests alternatives
  "soul": string,          // 1-2 sentences in the user's preferred language
  "rationale": {           // SHORT explanations, ≤ 280 chars each
    "snark": string,
    "patience": string,
    "rigor": string,
    "chattiness": string,
    "curiosity": string
  },
  "generated_from_memory_at": string
}

Rules:
- Output ONLY the JSON object. No prose, no markdown fences.
- Each rationale sentence must reference SOMETHING the user wrote in the memory excerpts.
- Do NOT output name or species — those are already chosen.
- Be playful, not derivative.`;

export const QUIZ_SOUL_PROMPT = `You are writing the SOUL and per-dial RATIONALE for a freshly-calibrated Siltpoke pet.

The user has ALREADY: chosen name + species, answered a 5-item Likert personality quiz, and picked a finale scenario. From their answers we have already computed the 5 numerical dials deterministically — your job is NOT to change them.

Your job: write a 1-2 sentence soul description (in the user's preferred language) using the chosen name + species, and write a 1-sentence rationale per dial citing the user's specific quiz answers.

Output exactly one JSON object and nothing else:

{
  "soul": string,
  "rationale": {
    "snark": string,
    "patience": string,
    "rigor": string,
    "chattiness": string,
    "curiosity": string
  }
}

Rules:
- Output ONLY the JSON object. No prose, no markdown fences.
- Each rationale must reference a specific quiz answer ("agreed that...", "picked option C...").
- Do NOT output dial numbers — they're already set.
- ≤ 280 chars per rationale field, ≤ 280 chars for soul.
- Be playful, not derivative.`;

// ---------------------------------------------------------------------------
// Memory walk (find user-global config files)
// ---------------------------------------------------------------------------

interface FoundFile {
  path: string;
  size: number;
}

async function walk(
  dir: string,
  acc: FoundFile[],
  maxBytes: number,
  maxFiles: number,
): Promise<void> {
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch {
    return;
  }
  for (const name of entries) {
    if (acc.length >= maxFiles) return;
    const full = join(dir, name);
    let st;
    try {
      st = await stat(full);
    } catch {
      continue;
    }
    if (st.isDirectory()) {
      await walk(full, acc, maxBytes, maxFiles);
    } else if (st.isFile() && st.size <= maxBytes) {
      acc.push({ path: full, size: st.size });
    }
  }
}

// Match Claude Code's @<file> include syntax, e.g. `@RTK.md` or `@rules/x.md`.
const AT_REF = /@([A-Za-z0-9_./-]+\.md)\b/g;

async function statSafe(p: string) {
  try {
    return await stat(p);
  } catch {
    return null;
  }
}

async function tryAddFile(
  path: string,
  acc: FoundFile[],
  seen: Set<string>,
  maxBytes: number,
  maxFiles: number,
): Promise<boolean> {
  if (acc.length >= maxFiles) return false;
  if (seen.has(path)) return false;
  if (!existsSync(path)) return false;
  const st = await statSafe(path);
  if (!st?.isFile() || st.size > maxBytes) return false;
  acc.push({ path, size: st.size });
  seen.add(path);
  return true;
}

async function expandAtRefs(
  filePath: string,
  acc: FoundFile[],
  seen: Set<string>,
  maxBytes: number,
  maxFiles: number,
  depth: number,
): Promise<void> {
  if (depth > 2 || acc.length >= maxFiles) return;
  let content: string;
  try {
    content = await readFile(filePath, "utf8");
  } catch {
    return;
  }
  const baseDir = dirname(filePath);
  const refs = Array.from(content.matchAll(AT_REF)).map((m) => m[1]!);
  for (const ref of refs) {
    if (acc.length >= maxFiles) break;
    const refPath = join(baseDir, ref);
    const added = await tryAddFile(refPath, acc, seen, maxBytes, maxFiles);
    if (added) {
      await expandAtRefs(refPath, acc, seen, maxBytes, maxFiles, depth + 1);
    }
  }
}

// User-global memory sources only. Per-project memory under
// ~/.claude/projects/<X>/memory/ is explicitly NOT walked — personality
// should reflect WHO the user is, not what they happen to be working on.
export async function findMemoryFiles(
  claudeHome: string,
  opts: { maxBytes?: number; maxFiles?: number } = {},
): Promise<string[]> {
  const maxBytes = opts.maxBytes ?? 64 * 1024;
  const maxFiles = opts.maxFiles ?? 5;
  const found: FoundFile[] = [];
  const seen = new Set<string>();

  const claudeMd = join(claudeHome, "CLAUDE.md");
  if (await tryAddFile(claudeMd, found, seen, maxBytes, maxFiles)) {
    await expandAtRefs(claudeMd, found, seen, maxBytes, maxFiles, 1);
  }

  const globalMemoryDir = join(claudeHome, "memory");
  if (existsSync(globalMemoryDir) && found.length < maxFiles) {
    const before = found.length;
    await walk(globalMemoryDir, found, maxBytes, maxFiles);
    for (let i = before; i < found.length; i++) seen.add(found[i]?.path);
  }

  const rulesDir = join(claudeHome, "rules");
  if (existsSync(rulesDir) && found.length < maxFiles) {
    const before = found.length;
    await walk(rulesDir, found, maxBytes, maxFiles);
    for (let i = before; i < found.length; i++) seen.add(found[i]?.path);
  }

  return found.slice(0, maxFiles).map((f) => f.path);
}

// ---------------------------------------------------------------------------
// Brain calls — memory mode + quiz mode
// ---------------------------------------------------------------------------

export interface GenerateFromMemoryOptions {
  memoryFiles: readonly string[];
  userPickedName: string;
  userPickedSpecies: string;
  brainFn?: typeof callBrainRaw;
  now?: () => Date;
}

function buildMemoryContext(
  excerpts: string[],
  userPickedName: string,
  userPickedSpecies: string,
): string {
  const blocks = excerpts.map(
    (e, i) => `<memory n="${i + 1}">\n${e.slice(0, 12_000)}\n</memory>`,
  );
  return [
    `<user_picked>\nname: ${userPickedName}\nspecies: ${userPickedSpecies}\n</user_picked>`,
    blocks.join("\n"),
    "",
    `Generate the personality JSON for "${userPickedName} the ${userPickedSpecies}" now. Do not output name or species fields.`,
  ].join("\n");
}

export async function generateFromMemory(
  opts: GenerateFromMemoryOptions,
): Promise<PersonalitySeed | null> {
  if (opts.memoryFiles.length === 0) return null;
  const brain = opts.brainFn ?? callBrainRaw;
  const now = opts.now ?? (() => new Date());

  const excerpts: string[] = [];
  for (const path of opts.memoryFiles) {
    try {
      excerpts.push(await readFile(path, "utf8"));
    } catch {
      // skip unreadable file
    }
  }
  if (excerpts.length === 0) return null;

  try {
    const result = await brain({
      systemPrompt: SEED_PROMPT,
      contextBundle: buildMemoryContext(
        excerpts,
        opts.userPickedName,
        opts.userPickedSpecies,
      ),
    });
    const candidate = {
      ...(result.output as unknown as Record<string, unknown>),
      generated_from_memory_at: now().toISOString(),
    };
    return personalitySeedSchema.parse(candidate);
  } catch (err) {
    if (err instanceof BrainError) return null;
    if (err instanceof z.ZodError) return null;
    return null;
  }
}

export interface GenerateSoulFromQuizOptions {
  answers: QuizAnswers;
  dials: Dials;
  userPickedName: string;
  userPickedSpecies: string;
  brainFn?: typeof callBrainRaw;
}

function buildQuizContext(
  answers: QuizAnswers,
  dials: Dials,
  userPickedName: string,
  userPickedSpecies: string,
): string {
  const likertLines = answers.likert
    .map((a) => {
      const item = QUIZ_LIKERT_ITEMS[a.itemIndex];
      if (!item) return "";
      const labels = ["", "Strongly disagree", "Disagree", "Neutral", "Agree", "Strongly agree"];
      return `Q${a.itemIndex + 1}: ${item.text}\n   → ${a.score}/5 (${labels[a.score]})`;
    })
    .join("\n");

  const finaleChoice = QUIZ_FINALE.options.find(
    (o) => o.letter === answers.finale.letter,
  );

  return [
    `<user_picked>\nname: ${userPickedName}\nspecies: ${userPickedSpecies}\n</user_picked>`,
    `<computed_dials>\nsnark=${dials.snark}, patience=${dials.patience}, rigor=${dials.rigor}, chattiness=${dials.chattiness}, curiosity=${dials.curiosity}\n</computed_dials>`,
    `<quiz_likert>\n${likertLines}\n</quiz_likert>`,
    `<quiz_finale>\nScenario: ${QUIZ_FINALE.text}\n   → ${finaleChoice?.letter}) ${finaleChoice?.text ?? "?"}\n</quiz_finale>`,
    "",
    `Write the SOUL and per-dial rationale for "${userPickedName} the ${userPickedSpecies}" given the answers above. Reference specific answers in the rationale. Do not output dial numbers.`,
  ].join("\n");
}

/**
 * Asks Brain for soul + rationale ONLY. Dials are computed locally
 * via scoreQuiz (deterministic). Brain is not trusted with dial numbers
 * in quiz mode — only with narrative output.
 */
export async function generateSoulFromQuiz(
  opts: GenerateSoulFromQuizOptions,
): Promise<SoulOnly | null> {
  const brain = opts.brainFn ?? callBrainRaw;
  try {
    const result = await brain({
      systemPrompt: QUIZ_SOUL_PROMPT,
      contextBundle: buildQuizContext(
        opts.answers,
        opts.dials,
        opts.userPickedName,
        opts.userPickedSpecies,
      ),
    });
    return soulOnlySchema.parse(result.output);
  } catch (err) {
    if (err instanceof BrainError) return null;
    if (err instanceof z.ZodError) return null;
    return null;
  }
}
