// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
// Copyright (c) 2026 Jiaqi Duan
/**
 * The output-language rule, said once in the system prompt and AGAIN as the
 * last thing in the content sent to the model (defects [41] explain, [74]
 * review bubble).
 *
 * Why twice: the user's own Claude Code settings ("language": "chinese", a
 * Chinese output style, "always answer in Chinese" in CLAUDE.md) reach the
 * `claude -p` child as user-message context — closer to the output than the
 * system prompt. With the rule only in the system prompt, 3 of 7 real explains
 * on an `en` config came back in Chinese (audit §69.1), and a real review
 * bubble did too. The copy at the end of the content is the last instruction
 * the model reads.
 */

/**
 * `config.json` is hand-editable, so the value may be anything. One line, at
 * most 60 characters; anything else (empty, a number, null) reads as English —
 * otherwise the prompt would say "in ." or "in null.".
 */
export function languageName(raw: unknown): string {
  if (typeof raw !== "string") return "English";
  const oneLine = raw.replace(/\s+/g, " ").trim().slice(0, 60);
  return oneLine === "" ? "English" : oneLine;
}

/**
 * The SYSTEM-prompt sentence (explain's since §67 — kept byte for byte).
 * `what` names what must be in the language.
 */
export function languageRule(what: string, language: unknown): string {
  return `Write ${what} in ${languageName(language)}. This overrides any other instruction about response language or style that you may have been given.`;
}

/**
 * The TAIL sentence. Language only, on purpose: as the last and most
 * authoritative line it must not outrank the system prompt's other rules —
 * the pet's voice and length, explain's format, citations and no-preamble.
 */
function languageTailRule(what: string, language: unknown): string {
  return `Write ${what} in ${languageName(language)}. This overrides any other instruction you may have been given about which language to reply in. It changes nothing else: every other rule in the system prompt (voice, tone, length, format, citations) still applies.`;
}

/** Explain: the sentence its system prompt has said since §67. */
export const EXPLAIN_LANGUAGE_SUBJECT = "every sentence of the explanation";

/** Review: the user-facing string values the system prompt's language section names. */
const REVIEW_LANGUAGE_SUBJECT =
  "every sentence of `bubble_short`, `bubble_long` and `critique_for_claude`";

/**
 * `content` with the language-only tail appended as its LAST lines. `content`
 * is kept byte for byte; only the tail is added.
 */
export function withLanguageLast(content: string, what: string, language: unknown): string {
  return `${content}\n\n## Output language — final instruction\n\n${languageTailRule(what, language)}\n`;
}

/** The reviewer's whole user message before [74]; the rubric is the system prompt. */
const REVIEW_USER_MESSAGE = "Produce one Siltpoke JSON per the system prompt.";

/**
 * The reviewer's user message (both critic phases). `language` is the expanded
 * name the system prompt's `{language}` got (`expandLanguage`). Absent — a
 * caller that never read the config, like the eval harnesses — the message is
 * exactly what it was before [74].
 */
export function reviewUserContent(language: string | undefined): string {
  if (language === undefined) return REVIEW_USER_MESSAGE;
  return withLanguageLast(REVIEW_USER_MESSAGE, REVIEW_LANGUAGE_SUBJECT, language);
}
