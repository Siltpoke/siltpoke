// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
// Copyright (c) 2026 Jiaqi Duan
/**
 * `quiz-score` subcommand core — turns the raw personality-quiz answers the
 * `/siltpoke-setup` conversation collects into the five dials, by calling the
 * REAL `scoreQuiz` in `src/installer/personality-seed.ts`.
 *
 * WHY THIS EXISTS: the quiz's dials must be *scored* from the answers (each
 * Likert item's `impact` weights, the reverse flag, the finale deltas), NOT
 * guessed by the model. This module is the deterministic bridge: the .md
 * command collects 5 Likert scores + 1 finale letter, hands them here as a
 * small constrained JSON blob, and gets back the exact dials `scoreQuiz`
 * produces. No scoring math is reimplemented here — it only validates the
 * untrusted input, then delegates.
 *
 * Input shape (constrained — 5 scores 1-5 + one letter per finale scenario,
 * so it is safe to pass on a command line):
 *
 *     {"scores":[5,4,3,2,1],"finales":["a","a","a"]}            // matchMode defaults to "mirror"
 *     {"scores":[5,4,3,2,1],"finales":["a","b","a"],"matchMode":"complement"}
 *
 * `scores[i]` is the Likert answer (1 = strongly disagree … 5 = strongly
 * agree) for `QUIZ_LIKERT_ITEMS[i]`, positionally. `finales[i]` is the chosen
 * letter for `QUIZ_FINALES[i]`, positionally (each finale allows only its own
 * option letters).
 */
import {
  type Dials,
  type FinaleLetter,
  type MatchMode,
  QUIZ_FINALES,
  QUIZ_LIKERT_ITEMS,
  type QuizAnswers,
  type QuizLikertAnswer,
  scoreQuiz,
} from "../installer/personality-seed";

const MATCH_MODES = ["mirror", "complement", "hybrid"] as const;

/** Narrows an arbitrary string to a valid MatchMode. */
export function isMatchMode(s: string): s is MatchMode {
  return (MATCH_MODES as readonly string[]).includes(s);
}

/**
 * Parse + validate the raw JSON answers and compute the dials via the real
 * `scoreQuiz`. Throws `Error` (with a user-facing message) on any bad input;
 * never returns partial/guessed dials.
 *
 * @param raw JSON string, either from a `--answers` flag or stdin.
 * @param matchModeOverride optional `--match-mode` flag value; wins over the
 *   `matchMode` field inside the JSON. Absent both → "mirror".
 */
export function computeQuizDials(raw: string, matchModeOverride?: string): Dials {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("answers must be valid JSON");
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("answers must be a JSON object");
  }
  const obj = parsed as Record<string, unknown>;

  const scores = obj.scores;
  if (!Array.isArray(scores) || scores.length !== QUIZ_LIKERT_ITEMS.length) {
    throw new Error(
      `\`scores\` must be an array of exactly ${QUIZ_LIKERT_ITEMS.length} numbers (one per Likert item)`,
    );
  }
  const likert: QuizLikertAnswer[] = scores.map((s, i) => {
    if (typeof s !== "number" || !Number.isInteger(s) || s < 1 || s > 5) {
      throw new Error(`score #${i + 1} must be an integer 1-5 (got ${JSON.stringify(s)})`);
    }
    return { itemIndex: i, score: s as 1 | 2 | 3 | 4 | 5 };
  });

  const finales = obj.finales;
  if (!Array.isArray(finales) || finales.length !== QUIZ_FINALES.length) {
    throw new Error(
      `\`finales\` must be an array of exactly ${QUIZ_FINALES.length} letters (one per finale scenario)`,
    );
  }
  const finaleAnswers: FinaleLetter[] = finales.map((f, i) => {
    const valid = QUIZ_FINALES[i]!.options.map((o) => o.letter);
    if (typeof f !== "string" || !(valid as readonly string[]).includes(f)) {
      throw new Error(
        `finale #${i + 1} must be one of ${valid.join(", ")} (got ${JSON.stringify(f)})`,
      );
    }
    return f as FinaleLetter;
  });

  const modeRaw = matchModeOverride ?? obj.matchMode ?? "mirror";
  if (typeof modeRaw !== "string" || !isMatchMode(modeRaw)) {
    throw new Error(`matchMode must be one of ${MATCH_MODES.join(", ")}`);
  }

  const answers: QuizAnswers = {
    likert,
    finales: finaleAnswers,
  };
  return scoreQuiz(answers, modeRaw);
}
