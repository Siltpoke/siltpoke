// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
// Copyright (c) 2026 Jiaqi Duan
/**
 * RULE ECHO — the fifth stage of the memory funnel, and the only one that was
 * never built.
 *
 * `MemoryFunnel` measures four stages: a rule is in the store → survives the
 * scope filter → is selected → its bytes reach the prompt. It stops there. What
 * the OUTPUT did with it has never been observed anywhere, which is why the
 * moat claim ("memory lifts catch rate 0.3 → 0.9") cannot be checked in
 * production at all.
 *
 * ⚠️ WHAT THIS MEASURES, STATED BEFORE ANYTHING ELSE. On 2026-08-03 this repo
 * misread three separate fields in one day — `duration_ms` (a whole-hook wall
 * clock) as a per-call latency, and `applied_count` (a dedup counter) as a
 * usage counter. Each was a correct number under a wrong label, and no step
 * alarmed. So this field is named for exactly what it does:
 *
 *   ECHO = a term that is distinctive to the rule appears in the critique.
 *
 * It is **not** "the rule caused the finding". Causation needs a counterfactual
 * — the same diff reviewed with and without the rule — which only the offline
 * moat eval can do. Echo is one-directional and lossy in both directions:
 *   - echo without influence: the model may use the word for its own reasons;
 *   - influence without echo: the rule may shape attention while the wording
 *     diverges entirely.
 * Treat a rise in echo as evidence worth investigating, never as proof of
 * effect, and never wire it into a gate.
 *
 * THE CONFOUND THIS DESIGN REMOVES. A rule about `atomicWrite` and a critique
 * mentioning `atomicWrite` prove nothing if the DIFF also says `atomicWrite` —
 * both sides are just reading the same code. So a rule's terms are filtered
 * against the reviewed corpus first, and only the residue counts. A rule with
 * NO residue is reported as `indistinguishable`, not as silent: we genuinely
 * cannot tell, and collapsing that into "no echo" would understate the signal
 * exactly the way `applied_count == 0` overstated it.
 */

/** Words that carry no discriminating power in a rule sentence. */
const STOPWORDS = new Set([
  "the", "a", "an", "and", "or", "but", "if", "then", "than", "that", "this", "these", "those",
  "is", "are", "was", "were", "be", "been", "being", "to", "of", "in", "on", "at", "by", "for",
  "with", "from", "into", "over", "under", "not", "no", "never", "always", "must", "should",
  "when", "while", "any", "all", "every", "each", "use", "used", "using", "via", "it", "its",
  "you", "your", "we", "our", "do", "does", "did", "can", "will", "would", "there", "here",
  "add", "adds", "added", "make", "makes", "made", "get", "gets", "set", "sets", "new", "old",
]);

/** Minimum length for a plain word to count as a term. Identifiers are exempt. */
const MIN_WORD_LEN = 4;

/** Looks like code rather than prose — kept regardless of length. */
function isIdentifierLike(t: string): boolean {
  // Length floor first: a two-letter acronym like `TS` is prose, not an
  // identifier, and letting it through made `TS` a "distinctive" term of a
  // rule — which then matched every critique quoting a `.ts` path.
  if (t.length < 3) return false;
  return /[A-Z]/.test(t.slice(1)) || t.includes("_") || t.includes("-") || /\d/.test(t);
}

/**
 * Content terms of a piece of text: lowercased, stopwords dropped, short prose
 * words dropped, code-shaped tokens kept whatever their length.
 */
export function contentTerms(text: string): Set<string> {
  const out = new Set<string>();
  for (const raw of text.split(/[^A-Za-z0-9_.-]+/)) {
    const t = raw.replace(/^[.-]+|[.-]+$/g, "");
    if (!t) continue;
    const lower = t.toLowerCase();
    if (STOPWORDS.has(lower)) continue;
    if (t.length < MIN_WORD_LEN && !isIdentifierLike(t)) continue;
    out.add(lower);
  }
  return out;
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Token-bounded containment. A plain `includes` would score `type` inside
 * `TypeScript` — the precise hole an independent review found in the recall
 * grader on 2026-08-03 (see `docs/lessons.md` L4). Boundaries are imposed only
 * on edges that are themselves word characters, so `foo-bar` and `x.y` still
 * match.
 */
export function containsTerm(haystack: string, term: string): boolean {
  const left = /^\w/.test(term) ? "(?<!\\w)" : "";
  const right = /\w$/.test(term) ? "(?!\\w)" : "";
  return new RegExp(`${left}${escapeRegExp(term)}${right}`, "i").test(haystack);
}

export interface EchoInput {
  /** Rules that actually reached the prompt for this review. */
  rules: ReadonlyArray<{ id: string; rule: string }>;
  /** The critique text the Brain produced. */
  critique: string;
  /** What the Brain was shown — diff, tool output. Terms present here are not
   * distinctive to the rule and are excluded before matching. */
  reviewedCorpus: string;
}

export interface EchoVerdict {
  /** A distinctive rule term appears in the critique. */
  echoed: string[];
  /** The rule had distinctive terms, none of which appear. */
  silent: string[];
  /** Every term the rule carries is also in the corpus — undecidable, and
   * deliberately NOT counted as silent. */
  indistinguishable: string[];
  /** Per-rule detail: which terms carried the verdict. Kept so a result can be
   * audited instead of trusted. */
  detail: Array<{ id: string; distinctive: string[]; matched: string[] }>;
}

/**
 * Classify each injected rule as echoed / silent / indistinguishable.
 *
 * The three-way split is the point. A boolean would force the undecidable case
 * into one of the two decided ones, which is how a measurement starts lying.
 */
export function classifyEcho(input: EchoInput): EchoVerdict {
  const corpusTerms = contentTerms(input.reviewedCorpus);
  const verdict: EchoVerdict = { echoed: [], silent: [], indistinguishable: [], detail: [] };

  for (const r of input.rules) {
    const distinctive = [...contentTerms(r.rule)].filter((t) => !corpusTerms.has(t));
    const matched = distinctive.filter((t) => containsTerm(input.critique, t));
    verdict.detail.push({ id: r.id, distinctive, matched });

    if (distinctive.length === 0) verdict.indistinguishable.push(r.id);
    else if (matched.length > 0) verdict.echoed.push(r.id);
    else verdict.silent.push(r.id);
  }
  return verdict;
}
