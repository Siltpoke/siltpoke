// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
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
// Quiz: 5 Likert + N forced-choice finales
//
// v4 design:
// each Likert item targets exactly ONE dial. v2 multi-axis items (e.g. the
// "stove" and "temper" questions) felt random because user couldn't trace
// why one answer moved three dials. Mono-axis items match IPIP/16P/HEXACO
// convention and give the rationale-writer a clean attribution.
//
// ALL 5 Likert items are positively keyed (no reverse-scored item). The
// N=1,131 study behind this quiz found a lone cross-dial reverse item is a
// net liability: mixing keying directions cuts reliability (0.92→0.65) and
// manufactures method factors. The `reverse?` field on LikertItem (and the
// sign-flip in scoreQuiz) is kept as a harmless, future-proof hook — no
// current item sets it.
//
// Acquiescence bias is instead fought by the forced-choice FINALES — the
// study's strongest-endorsed element (immune to "agree with everything"):
// each finale is a desirability-matched pair/set of options tapping DIFFERENT
// dials, so picking one reveals a real preference rather than a yea-saying.
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

// v5: NON-TECHNICAL, general-personality statements. The owner targets
// non-technical end users, and human personality is consistent across
// contexts — so the quiz measures GENERAL traits (never code/tools/reviews).
// Same dial mapping + impact weights as v4; still all positively keyed.
export const QUIZ_LIKERT_ITEMS: readonly LikertItem[] = [
  {
    // snark only — positively keyed. Agree = prefers candor over cushioning.
    text: "I'd rather someone be honest with me than spare my feelings.",
    impact: { snark: 2 },
  },
  {
    // patience only — positively keyed. Agree = stays calm at repeat mistakes.
    text: "When someone makes the same mistake twice, I stay calm about it.",
    impact: { patience: 2 },
  },
  {
    // rigor only — positively keyed. Agree = double-checks before finishing.
    text: "I like to double-check my work before I call it done.",
    impact: { rigor: 2 },
  },
  {
    // chattiness only — positively keyed. Agree = enjoys long-form talk.
    text: "I enjoy a good long conversation more than a quick exchange.",
    impact: { chattiness: 2 },
  },
  {
    // curiosity only — positively keyed. Agree = explores options first.
    text: "I like to explore a few different options before I decide.",
    impact: { curiosity: 2 },
  },
] as const;

export type FinaleLetter = "a" | "b" | "c" | "d";

export interface FinaleChoice {
  letter: FinaleLetter;
  text: string;
  impact: DialDelta;
}

export interface FinaleQuestion {
  text: string;
  options: readonly FinaleChoice[];
}

// Forced-choice finales — desirability-matched pairs/sets, each tapping
// DIFFERENT dials with roughly equal appeal so a pick reveals a real
// preference (not acquiescence). Impacts are modest (±1..±2) so no single
// finale dominates the five Likert items.
// v5: NON-TECHNICAL, everyday scenarios (no bugs/builds/code). Each is still a
// desirability-matched set tapping DIFFERENT dials with roughly equal appeal,
// so a pick reveals a real preference (not acquiescence). Impacts stay modest
// (±1..±2) so no single finale dominates the five Likert items.
export const QUIZ_FINALES: readonly FinaleQuestion[] = [
  {
    // snark vs patience vs rigor — four desirability-matched reactions to being
    // called out (some want the tease, some the reassurance, some the coaching).
    text: "A friend points out you slipped up. You'd rather they:",
    options: [
      {
        letter: "a",
        text: "Tease you about it with a grin",
        impact: { snark: 2 },
      },
      {
        letter: "b",
        text: "Gently talk you through it",
        impact: { patience: 2 },
      },
      {
        letter: "c",
        text: "Walk you through every step so it won't happen again",
        impact: { rigor: 2 },
      },
      {
        letter: "d",
        text: "Just let it go",
        impact: { patience: 1, snark: -1 },
      },
    ],
  },
  {
    // chattiness — desirability-matched (the quick version vs the full telling).
    text: "You're telling someone a story. You tend to:",
    options: [
      {
        letter: "a",
        text: "Give them the quick version",
        impact: { chattiness: -2 },
      },
      {
        letter: "b",
        text: "Tell the whole thing with every detail",
        impact: { chattiness: 2 },
      },
    ],
  },
  {
    // curiosity — desirability-matched (decisive vs exploratory).
    text: "Faced with a choice, you usually:",
    options: [
      {
        letter: "a",
        text: "Go with the first good option",
        impact: { curiosity: -2 },
      },
      {
        letter: "b",
        text: "Explore a few alternatives first",
        impact: { curiosity: 2 },
      },
    ],
  },
] as const;

export interface QuizLikertAnswer {
  itemIndex: number;
  /** 1 = strongly disagree, 5 = strongly agree. */
  score: 1 | 2 | 3 | 4 | 5;
}

export interface QuizAnswers {
  likert: readonly QuizLikertAnswer[];
  /** One chosen letter per finale in QUIZ_FINALES, aligned by index. */
  finales: readonly FinaleLetter[];
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

  for (let i = 0; i < answers.finales.length; i++) {
    const scenario = QUIZ_FINALES[i];
    if (!scenario) continue;
    const choice = scenario.options.find((o) => o.letter === answers.finales[i]);
    if (!choice) continue;
    for (const k of DIALS) {
      const delta = choice.impact[k];
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

  const finaleLines = answers.finales
    .map((letter, i) => {
      const scenario = QUIZ_FINALES[i];
      if (!scenario) return "";
      const choice = scenario.options.find((o) => o.letter === letter);
      return `Scenario: ${scenario.text}\n   → ${choice?.letter}) ${choice?.text ?? "?"}`;
    })
    .filter(Boolean)
    .join("\n");

  return [
    `<user_picked>\nname: ${userPickedName}\nspecies: ${userPickedSpecies}\n</user_picked>`,
    `<computed_dials>\nsnark=${dials.snark}, patience=${dials.patience}, rigor=${dials.rigor}, chattiness=${dials.chattiness}, curiosity=${dials.curiosity}\n</computed_dials>`,
    `<quiz_likert>\n${likertLines}\n</quiz_likert>`,
    `<quiz_finales>\n${finaleLines}\n</quiz_finales>`,
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
