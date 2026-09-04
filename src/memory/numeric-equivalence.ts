// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
// Copyright (c) 2026 Jiaqi Duan
/**
 * numericallyEquivalent — deterministic numeric-difference guard (no LLM).
 *
 * WHY (eval evidence): a paid calibration run found the ONLY
 * systematic extractor failure was the numeric trap — 1/6 exact match. Haiku
 * classifies  against stored  as contradict at
 * confidence 0.95-1.0, ignoring the prompt's numeric-specifics guard, and
 * because its confidence curve is flat at the extremes the threshold ladder
 * cannot catch it. So the guard is promoted from prompt (defense-in-depth)
 * to CODE at the runner's layer-2 — code-level guards are the real
 * guarantee, prompt-level guidance is best-effort only.
 *
 * WHAT: two texts are "numerically equivalent" when they say (almost) the same
 * thing apart from their numbers — i.e. a numeric-specifics difference, NOT a
 * genuine contradiction. Pipeline:
 *   1. Extract numeric tokens from each side: ASCII digit runs (incl. decimals),
 *      fullwidth digits ０-９, zh numeral runs (零一二两三四五六七八九十百千万亿).
 *   2. Either side has NO numeric token → false (nothing numeric to differ on).
 *   3. Token sequences identical → false (same numbers ≠ a numeric-difference
 *      case; this also protects true contradictions that merely share a zh
 *      numeral, e.g.  vs  — both
 *      carry , sequences match, guard stays out of the way).
 *   4. Residues = both texts minus their numeric tokens, lowercased, stripped
 *      of whitespace + punctuation/symbols (zh + ascii).
 *   5. Residue similarity ≥ 0.6 → true. Residue shorter than 2 chars on either
 *      side → fall back to strict equality ("90后" vs "00后" → residues ).
 *
 * SIMILARITY METRIC (deliberate deviation from the plain bigram-Dice sketch,
 * measured on the real cached eval outputs): extracted claims are often
 * subject-dropped fragments () while stored candidates are canonical
 * third-person (). Dice punishes that length asymmetry — the
 * flagship cat pair scores 0.25 and the guard never fires. Instead we score
 * CONTAINMENT (overlap coefficient, |A∩B| / min(|A|,|B|)) over the union of
 * character UNIGRAMS + BIGRAMS of the residues — CJK-friendly (single hanzi
 * carry meaning; bigrams keep en discriminative) and fragment-tolerant. On the
 * cached eval pairs: true numeric traps score 0.60-1.0, impostor pairs
 * ( vs ) score 0.
 *
 * CONSERVATIVE DIRECTION: a false POSITIVE here downgrades a contradict to a
 * plain add — the claim still lands, coexisting with the old fact, fully
 * visible on /memory. No data loss, user-correctable. A false NEGATIVE just
 * falls through to the existing ladder. Downgrade is therefore the safe
 * failure mode in both directions.
 *
 * Known accepted misses: cross-language pairs (the extractor sometimes answers
 * an English message with a Chinese fact — eval case nt-en-01) share no
 * residue grams and stay contradicts; and "3" vs  count as DIFFERENT
 * tokens (no numeral normalization), which only ever fires the guard more —
 * still the safe direction.
 *
 * @example numericallyEquivalent(, )        // true
 * @example numericallyEquivalent(, )   // true
 * @example numericallyEquivalent(, )      // false (same numbers)
 * @example numericallyEquivalent(, )                // false (no numbers)
 * @example numericallyEquivalent(, )            // false (different topic)
 */

/**
 * One numeric token: an ASCII/fullwidth digit run (with optional decimal part,
 * ascii or fullwidth dot) OR a zh-numeral run. Order of alternatives matters —
 * digits first so "3.5" stays one token.
 */
const NUMERIC_TOKEN_RE = /[0-9０-９]+(?:[.．][0-9０-９]+)?|[零一二两三四五六七八九十百千万亿]+/gu;

/** Whitespace + punctuation + symbols + separators, zh and ascii alike. */
const STRIP_RE = /[\s\p{P}\p{S}\p{Z}]/gu;

/** ≥ this containment score on the residues → numerically equivalent. */
const SIMILARITY_FLOOR = 0.6;

function numericTokens(text: string): string[] {
  return text.match(NUMERIC_TOKEN_RE) ?? [];
}

function residueOf(text: string): string {
  return text.replace(NUMERIC_TOKEN_RE, "").toLowerCase().replace(STRIP_RE, "");
}

/** Character unigram + bigram set of a residue (CJK-friendly gram inventory). */
function grams(residue: string): Set<string> {
  const set = new Set<string>();
  for (let i = 0; i < residue.length; i++) {
    set.add(residue.charAt(i));
    if (i + 1 < residue.length) set.add(residue.slice(i, i + 2));
  }
  return set;
}

/**
 * True when `a` and `b` differ in their numbers but say (almost) the same
 * thing otherwise — a numeric-specifics difference the correction pipeline
 * must treat as a coexisting add, never a contradiction. See module JSDoc.
 */
export function numericallyEquivalent(a: string, b: string): boolean {
  const tokensA = numericTokens(a);
  const tokensB = numericTokens(b);
  if (tokensA.length === 0 || tokensB.length === 0) return false;
  // Identical numeric sequences = not a numeric-DIFFERENCE case ("\0" as
  // join separator cannot appear inside a token, so joins compare exactly).
  if (tokensA.join("\0") === tokensB.join("\0")) return false;

  const residueA = residueOf(a);
  const residueB = residueOf(b);
  if (residueA.length < 2 || residueB.length < 2) return residueA === residueB;

  const gramsA = grams(residueA);
  const gramsB = grams(residueB);
  const [small, large] = gramsA.size <= gramsB.size ? [gramsA, gramsB] : [gramsB, gramsA];
  let shared = 0;
  for (const gram of small) {
    if (large.has(gram)) shared++;
  }
  return shared / small.size >= SIMILARITY_FLOOR;
}
