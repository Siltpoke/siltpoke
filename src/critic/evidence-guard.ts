// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
// Copyright (c) 2026 Jiaqi Duan
/**
 * Post-Brain substring-match check for the tool-augmented critic.
 *
 * Verifies that every evidence snippet emitted by the LLM appears verbatim in
 * the tool-derived citation corpus (the formatted tool section the Brain saw +
 * raw stdout + caller tokens), and that every cited file appears in the
 * changed-files set OR somewhere in the corpus.
 *
 * "Verbatim" has two readings since 2026-09-10, and both are still verbatim:
 * the corpus as written, or — for a snippet spanning lines — one side of one
 * diff hunk with the `+`/`-`/space column removed, which is how the file itself
 * reads. See `diffHunks` / `sidesOf`. A snippet the schema layer cut to the cap is checked
 * on the part it kept (`quotedText`).
 *
 * **It labels; it no longer deletes.** Until 2026-08-19 this returned a single
 * accept/reject boolean and NORMAL rejected the WHOLE review on the first
 * failure — and the second check's `return` sat inside the loop, so every
 * later evidence item went unread. Measured over the 400 most recent fired
 * reviews of a real store (`scripts/probes/critic-audit-coverage-probe.ts`):
 *
 *     214  53.5%  evidence array empty      → whole review discarded
 *      12   3.0%  snippet not in corpus     → whole review discarded
 *
 * 56.5% of the critic's silence came out of this one function, and what it
 * discarded was not junk: one dropped review had rubric triggers for a
 * god-file and a magic number written out in its own prose, and was thrown
 * away only because `evidence` was `[]`. Another cited a comment that really
 * does exist in the file — it just was not inside the 20 diff hunks the
 * reviewer happened to be handed.
 *
 * So the contract is now: **an unverifiable citation is dropped, an
 * unverifiable review is not.** The caller surfaces the review with the label
 * this returns, and shows the reader which parts were checked. The
 * anti-hallucination invariant is unchanged — a snippet that fails the check
 * never reaches the user AS EVIDENCE, it is just not allowed to take the rest
 * of the review down with it.
 *
 * **Precisely where a dropped snippet does and does not go**, because the first
 * version of this paragraph said "before it is persisted, logged, or rendered"
 * and that was too strong. It does NOT reach: the persisted critique, the
 * `brain_output` telemetry field, the pending-critique anchors, the pet bubble,
 * or any surface that presents evidence to the reader. It DOES remain in the
 * `brain.find` and `response.parse` trace spans, which are written before this
 * function runs and exist to record what the model actually returned — the
 * caller puts the verdict on the root span so a trace reader sees that the drop
 * happened instead of having to infer it.
 */

import {
  type BrainOutput,
  type EvidenceItem,
  type Finding,
  type ModelFinding,
  type PersistedFinding,
  SNIPPET_CAP,
} from "../brain/schema";
import {
  type CorpusHunk,
  type ParsedCorpus,
  diffHunks,
  sidesOf,
} from "./corpus-hunks";
import type { GateDecision } from "./classify-output";
import type { WebSource } from "../brain/schema-v2";

/**
 * How much of this review's evidence survived the check.
 *
 * A closed union, not a free string: it is written to telemetry, read back by
 * `classifyAuditAbsence`, and rendered on the timeline — the same reason
 * `AuditAbsenceKind` is closed.
 */
export type EvidenceLabel =
  /** Mode that does not check evidence at all (PASSIVE_BUBBLE / HARD_SUPPRESS). */
  | "not_checked"
  /**
   * Cited only files the corpus holds no bytes for, because the REVIEW BUDGET
   * cut them. Distinct from `not_checked`, which means the corpus never had
   * them at all: this one is siltpoke's own choice, and a user can act on it
   * (make a smaller change) in a way they cannot act on the other.
   */
  | "not_checked_budget"
  /** Every item checked out. */
  | "verified"
  /** NORMAL, and the reviewer cited nothing at all — no line to point at. */
  | "no_evidence"
  /** Some items checked out, some did not. */
  | "partly_unverified"
  /** Items were cited and not one of them checked out. */
  | "none_verified";

export interface UnverifiedEvidence {
  /**
   * Position in the evidence array AS PARSED. Kept so a reader can line the
   * dropped items up against what the reviewer emitted — a bare count cannot
   * say WHICH one went.
   *
   * "As parsed", not "as the model wrote it": since 2026-09-01 the schema layer
   * drops evidence items that fail their own shape before this function ever
   * runs (`coerceBrainOutputShape`), and a drop from the middle renumbers what
   * follows. WHICH ones went that way is on the same object, in `repaired` —
   * each entry carries the model's own index (`evidence.2: file: invalid_type
   * (received number)`). `truncated.evidence_malformed` is only the count, and
   * the note two lines up is right that a bare count cannot say which one went,
   * so it is `repaired` that lets a reader line the two removals up.
   */
  index: number;
  /** Log-safe reason. Snippet previews are truncated at 60 chars. */
  reason: string;
  /**
   * Where the refused citation pointed. Carried because the ONLY other copy is
   * gone by the time anything is written: the NORMAL caller reassigns
   * `critique.evidence` to the confirmed items before persisting, so `index`
   * refers to an array the reader no longer has. A persisted "#0 — snippet not
   * in evidence_corpus" without this names a position in a list nobody can see,
   * which is not enough to go and check the claim — and checking persisted
   * claims is the whole reason they are persisted (defect ⑩ step 2).
   */
  file: string;
  /** Line the refused citation pointed at, when the model gave one. */
  line?: number;
}

/** One finding refused because its quote could not be checked. */
export interface UnverifiedFinding {
  /** Position in `out.findings` as parsed — see the note on `UnverifiedEvidence.index`. */
  index: number;
  /** Log-safe reason. Quote previews are truncated at 60 chars. */
  reason: string;
  /** The file the refused finding named, carried for the same reason `UnverifiedEvidence.file` is. */
  file: string;
}

export interface EvidenceVerdict {
  label: EvidenceLabel;
  /**
   * The items that check out — the ONLY ones a caller may surface as evidence.
   * Everything else in the review is surfaced regardless of this list.
   */
  verified: EvidenceItem[];
  /** One entry per refused item. Empty when nothing was refused. */
  unverified: UnverifiedEvidence[];
  /**
   * The findings whose quote checks out — the ONLY ones a caller may surface.
   *
   * A PARALLEL FIELD ON THE SAME VERDICT, not a second verdict object and not a
   * second function, so there stays one call site and one label path down to the
   * critique frontmatter and the history row. A separate object would mean
   * wiring every downstream surface a second time, and a surface that got wired
   * once is how a defence ends up existing on one path and missing on its
   * sibling.
   */
  verifiedFindings: Finding[];
  /** One entry per refused finding. Empty when nothing was refused. */
  unverifiedFindings: UnverifiedFinding[];
  /**
   * How often the model's own guess at a line number matched the one the code
   * derived — the first measurement of that in this project.
   *
   * The four are MUTUALLY EXCLUSIVE and sum to the number of findings that
   * survived the check, decided in the order they are declared. `code_silent`
   * comes first and swallows every reason the code produced no range, because
   * "we could not check" is not a verdict on the model; splitting those reasons
   * out is what `range_source` is for.
   *
   * No pass mark. Nobody has ever measured this, so the first run IS the
   * baseline.
   */
  rangeAgreement: RangeAgreement;
}

export interface RangeAgreement {
  /** The code wrote no line number, whatever the model said. */
  code_silent: number;
  /** The code wrote one and the model offered none. */
  model_silent: number;
  /** Both, and the start lines match. */
  agree: number;
  /** Both, and they do not. */
  disagree: number;
}

/** Snippet reason strings are truncated here to keep telemetry logs scannable. */
const SNIPPET_PREVIEW_MAX = 60;

function previewOf(snippet: string): string {
  return snippet.length > SNIPPET_PREVIEW_MAX
    ? `${snippet.slice(0, SNIPPET_PREVIEW_MAX)}...`
    : snippet;
}

/**
 * What of a snippet is the reviewer's own text.
 *
 * The schema layer cuts an over-long snippet to exactly `SNIPPET_CAP` chars and
 * appends `…` (`truncStr`, src/brain/schema.ts). That character is siltpoke's,
 * the corpus never contains it, and so every cut snippet used to be refused —
 * the cut made to keep a long citation turned it into an unverifiable one.
 *
 * Only that exact shape is unwrapped. A shorter snippet ending in `…` is the
 * reviewer eliding something itself, and its prefix alone is not a quote.
 *
 * The shape is not proof the cut was siltpoke's: a reviewer can also write
 * exactly 240 chars ending in `…`, and that one is unwrapped too (cross-family
 * review, 2026-09-10). Accepted rather than plumbed, because what then passes
 * is still 239 characters that appear verbatim in the corpus — the `…` claims
 * "there was more", never what the more was.
 */
function quotedText(snippet: string): string {
  return snippet.length === SNIPPET_CAP && snippet.endsWith("…")
    ? snippet.slice(0, -1)
    : snippet;
}


/**
 * Check one evidence item against the corpus. Returns null when it checks out,
 * or the log-safe reason it does not.
 *
 * `sides` is computed on first need and shared across the review's items: most
 * snippets match verbatim and never pay for the parse.
 */
function reasonItemFails(
  item: EvidenceItem,
  citationCorpus: string,
  changedFiles: Set<string>,
  sides: () => string[],
): string | null {
  // Snippet must appear verbatim in the tool-derived citation corpus, or
  // verbatim in one side of one hunk with the diff prefixes removed (see
  // `diffHunks`). Only a multi-line snippet can need the second test: a side's
  // line is its diff line minus one leading character, so a single-line quote
  // that matches a side already matches the corpus.
  const quote = quotedText(item.snippet);
  if (!citationCorpus.includes(quote) && !sides().some((side) => side.includes(quote))) {
    return `snippet not in evidence_corpus: ${previewOf(item.snippet)}`;
  }
  // File must appear either in the changed-files set (PQ3) or somewhere in the
  // corpus as a tool-mentioned path (PQ4).
  if (!changedFiles.has(item.file) && !citationCorpus.includes(item.file)) {
    return `evidence file not in changed-files or corpus: ${item.file}`;
  }
  return null;
}

/**
 * Which bucket one finding falls in, given what the model claimed and what the
 * code worked out.
 *
 * Only the START line is compared. The model may give one end and not the
 * other, and "did it point at the right place" is the question Q3 asks; an end
 * line is a second, weaker question this slice does not try to answer.
 */
function agreementOf(claimed: number | undefined, derived: number | undefined): keyof RangeAgreement {
  if (derived === undefined) return "code_silent";
  if (claimed === undefined) return "model_silent";
  return claimed === derived ? "agree" : "disagree";
}

/** Where a finding's quote sits, as the CODE reads it — never as the model claimed. */
interface QuoteLocation {
  quote_tier: "strong" | "weak";
  range_source: "hunk" | "unanchored" | "stale_block" | "not_located";
  start_line?: number;
  end_line?: number;
}

/**
 * Whether the FIRST block naming `file` describes some other file by the end.
 *
 * On the recent-commits path `git log` emits newest first, so a file's first
 * block is its most recent change and is the only one whose `+` side line
 * numbers can be true of the file as it stands. That reasoning collapses when
 * the most recent thing that happened to the name was a delete or a rename:
 * the next block carrying the name is then an OLDER commit's, and its numbers
 * describe a file the name no longer refers to.
 *
 * A file that was ADDED is not this case, though `oldFile` is null there too —
 * its `+` side is the whole current file. Testing `file !== oldFile` alone
 * would have caught every added file, which is the dominant shape in a diff.
 */
function firstBlockIsUnusable(parsed: ParsedCorpus, file: string): boolean {
  // Checked FIRST and unconditionally, because a pure rename and an empty
  // file's deletion produce no hunk at all — the scan below cannot see either,
  // and would report the name as perfectly ordinary.
  //
  // Fail-closed on purpose: a name that was moved off anywhere in this corpus
  // gets no line number, even in the rarer case where a later commit recreated
  // it. The cost is a missing number on a shape almost nobody hits; the cost of
  // the other answer is a number pointing into a file that is not there.
  if (parsed.movedAway.has(file)) return true;
  for (const h of parsed.hunks) {
    if (h.file === file) return false;
    if (h.oldFile === file) return true; // deleted (file === null) or renamed away
  }
  return false;
}

/**
 * Locate a finding's quote in the diff, and say how much the answer is worth.
 *
 * Only ever called for a finding whose quote already passed the corpus check,
 * so "not found in a hunk" means weak provenance, never a fabricated citation.
 */
function locateQuote(
  finding: ModelFinding,
  parsed: ParsedCorpus,
  rangesAnchored: boolean,
): QuoteLocation {
  // The SAME unwrap the corpus check uses. Applying it on one path and not the
  // other would judge every quote the schema cut to the cap as matching
  // nothing — the corpus holds no `…`.
  const quote = quotedText(finding.quote);

  // `after` is context + added lines (`diffHunks` pushes context to both sides
  // and `+` lines to this one), so a quote that matches only the REMOVED side
  // cannot reach here. That is structural: it is not a rule anyone can forget,
  // and the tier is the one place a label could silently claim that code the
  // change deleted is code the change introduced.
  const inThisDiff = parsed.hunks.filter((h) => h.file === finding.file && h.after.includes(quote));
  if (inThisDiff.length === 0) {
    return { quote_tier: "weak", range_source: "not_located" };
  }

  if (!rangesAnchored) {
    return { quote_tier: "strong", range_source: "unanchored" };
  }

  // Lowest block wins: on a multi-commit corpus that is the most recent change
  // to the file. Ties keep corpus order, so the choice is deterministic.
  let best = inThisDiff[0]!;
  for (const h of inThisDiff) {
    if (h.blockIndex < best.blockIndex) best = h;
  }
  if (best.blockIndex > 0 || firstBlockIsUnusable(parsed, finding.file)) {
    return { quote_tier: "strong", range_source: "stale_block" };
  }

  const offset = best.after.indexOf(quote);
  const linesBefore = best.after.slice(0, offset).split("\n").length - 1;
  const start = best.newStart + linesBefore;
  // Counted from the quote itself rather than from the hunk's header count: a
  // blank last context line is counted by the parser and not quoted, so the
  // side can be one line shorter than the header promises.
  const end = start + quote.split("\n").length - 1;
  return { quote_tier: "strong", range_source: "hunk", start_line: start, end_line: end };
}

/**
 * Check one finding's quote, with the SAME two tests `reasonItemFails` applies
 * to an evidence snippet — deliberately the same, not a new judgement.
 *
 * This slice adds no line range and no provenance tier, so there is nothing
 * here a stricter rule could be built on yet. What it does add is the check
 * that did not exist at all: before this, a quote living in `findings` was
 * invisible to every check in this file, and a wholly invented one reached the
 * reader unchallenged.
 */
function reasonFindingFails(
  finding: ModelFinding,
  citationCorpus: string,
  changedFiles: Set<string>,
  sides: () => string[],
): string | null {
  const quote = quotedText(finding.quote);
  if (!citationCorpus.includes(quote) && !sides().some((side) => side.includes(quote))) {
    return `finding quote not in evidence_corpus: ${previewOf(finding.quote)}`;
  }
  if (!changedFiles.has(finding.file) && !citationCorpus.includes(finding.file)) {
    return `finding file not in changed-files or corpus: ${finding.file}`;
  }
  return null;
}

/**
 * Give each surviving finding its id.
 *
 * NUMBERED OVER THE POST-GUARD ARRAY. The guard can remove entries, so an id
 * taken from the model's original positions would skip numbers and point at
 * slots the reader never sees. Callers therefore number what SURVIVED, which
 * is what `critique.findings` holds by the time anything renders it.
 *
 * AN ID ALREADY THERE IS KEPT. The guard now assigns ids while it
 * still holds the corpus, so a finding usually arrives here already numbered
 * and this function is a no-op on it. It still numbers what it must, because
 * the OTHER caller is the daemon reading a sidecar written before any of this
 * existed (`daemon/routes/critique.tsx`), where the ids never got written.
 *
 * WHAT IT MUST NOT DO is fill anything else in. A finding with no `quote_tier`
 * is one nothing checked, and defaulting it to `weak` would state a result
 * where there was none — the same mislabelling that made an unexamined file
 * read as a clean one elsewhere in this repo.
 *
 * The id is assigned in code and is deliberately absent from
 * `modelFindingSchema`. Anything declared there is handed to the provider's
 * strict schema and becomes a key the model must emit — an id the reviewer
 * writes for itself is not an identifier, it is a claim.
 *
 * An earlier note here said a field absent from the schema is "a type that
 * lies", and that was right about the id and wrong as a general rule: see
 * `PersistedFinding` in `../brain/schema` for why a tier and a line range have
 * to be persisted, and why the zod schema is not the contract that governs
 * what is on disk.
 */
export function withFindingIds(findings: PersistedFinding[]): Finding[] {
  return findings.map((f, i) => {
    // Destructured out rather than spread-then-deleted: this is the second of
    // the two places the model's hints are dropped, and a `delete` that is
    // forgotten leaves them on an object the write path serialises whole.
    const { claimed_start_line: _s, claimed_end_line: _e, ...rest } = f;
    return { ...rest, id: f.id ?? `f${i + 1}` };
  });
}

/**
 * Post-Brain evidence check.
 *
 * @param out           The parsed BrainOutput from the LLM.
 * @param mode          Gate decision from classifyToolOutput.
 * @param citationCorpus Tool-derived text the Brain may legitimately cite,
 *   verbatim: the formatted tool-output section the Brain saw + every tool's
 *   RAW stdout (+ caller-impact tokens). All deterministic and tool-derived —
 *   no LLM-generated prose — so the anti-hallucination invariant holds.
 * @param changedFiles  Set of file paths that changed in this Stop event.
 * @returns EvidenceVerdict — the surviving items plus what was refused and why.
 *
 * Mode semantics:
 * - PASSIVE_BUBBLE: not checked (a passive bubble has no evidence to cite).
 * - HARD_SUPPRESS: not checked (defensive — the caller should not reach this
 *   in HARD_SUPPRESS, and pass-through is the safe no-op).
 * - NORMAL: every item checked; failures are listed, never fatal.
 *
 * The two unchecked modes pass evidence through UNFILTERED and say so in the
 * label. Reporting them as `verified` would be the cheaper code and a false
 * claim — nothing looked at those items.
 */
export function guardCritique(
  out: BrainOutput,
  mode: GateDecision,
  citationCorpus: string,
  changedFiles: Set<string>,
  /**
   * Files the review budget cut entirely (`buildToolOutputSection`). Optional
   * so existing callers and tests keep working; an omitted set means "nothing
   * known to be cut", which degrades to the same answer as before.
   */
  budgetCutFiles: Set<string> = new Set(),
  /**
   * Whether this diff's `+` side is the file as it is on disk right now, so a
   * line number derived from it means something to a reader who opens the file.
   *
   * DEFAULTS TO FALSE, and that default is the design. It is false for a
   * recent-commits window containing a merge, for a range whose right side is
   * not HEAD or whose tree is dirty, and for anything that failed to answer.
   * A missing line number costs a reader one lookup; a confident wrong one is
   * the failure mode this whole slice makes more expensive, because a finding
   * with a file, a range and a verbatim quote is much harder to doubt.
   */
  rangesAnchored = false,
): EvidenceVerdict {
  // ⚠️ UNREACHABLE IN PRODUCTION TODAY, recorded rather than removed.
  // There is exactly one production call site — `src/critic/phases/normal.ts`
  // — and it passes the literal `"NORMAL"`. The PASSIVE_BUBBLE phase does not
  // call this function at all, so "the guard skips 79% of triggers" is
  // understated: on that path the guard is never entered. Only tests and
  // `src/eval/critic-output/audit.ts` reach this branch, and the latter also
  // passes `"NORMAL"`.
  //
  // Kept because defect ①'s decision tree moves most of today's PASSIVE_BUBBLE
  // volume into REVIEW, at which point a caller may legitimately arrive here
  // with a non-NORMAL mode — and a pass-through that says `not_checked` is the
  // honest answer for a mode nothing examined. Deleting it now would only mean
  // re-deriving it then.
  if (mode === "PASSIVE_BUBBLE" || mode === "HARD_SUPPRESS") {
    return {
      label: "not_checked",
      verified: out.evidence,
      unverified: [],
      // `unchecked`, not `not_located`: nothing looked. Reporting these as
      // weak would be the cheaper code and a false claim, for the same reason
      // the label beside it is `not_checked` rather than `verified`.
      // `quote_tier` is left ABSENT here — the renderer draws no badge for a
      // finding nothing examined.
      verifiedFindings: withFindingIds(
        out.findings.map((f) => ({ ...f, range_source: "unchecked" as const })),
      ),
      unverifiedFindings: [],
      // Nothing was compared, so every bucket is zero — not `code_silent`,
      // which would read as "the code tried and could not".
      rangeAgreement: { code_silent: 0, model_silent: 0, agree: 0, disagree: 0 },
    };
  }

  // NORMAL from here.

  const verified: EvidenceItem[] = [];
  const unverified: UnverifiedEvidence[] = [];
  let parsedCache: ParsedCorpus | undefined;
  const parsed = (): ParsedCorpus => (parsedCache ??= diffHunks(citationCorpus));
  let sidesCache: string[] | undefined;
  const sides = (): string[] => (sidesCache ??= sidesOf(parsed().hunks));

  // FINDINGS ARE CHECKED FIRST, AND BEFORE THE EARLY RETURN BELOW.
  //
  // The `evidence.length === 0` shortcut two blocks down is correct for
  // evidence and would be a hole for findings: a review can carry three
  // findings and an empty evidence array, and checking findings after that
  // return would mean every quote in exactly that case went unchecked. Which is
  // this repo's most productive audit move, applied to its own new code — a
  // defence that exists on one path and is missing on its sibling.
  const located: PersistedFinding[] = [];
  const unverifiedFindings: UnverifiedFinding[] = [];
  const rangeAgreement: RangeAgreement = { code_silent: 0, model_silent: 0, agree: 0, disagree: 0 };
  out.findings.forEach((finding, index) => {
    const reason = reasonFindingFails(finding, citationCorpus, changedFiles, sides);
    if (reason === null) {
      const location = locateQuote(finding, parsed(), rangesAnchored);
      // Tallied HERE, while the model's own claim is still on the object. Two
      // lines further down it is gone for good, and this number is the only
      // trace of it that survives.
      rangeAgreement[agreementOf(finding.claimed_start_line, location.start_line)] += 1;
      located.push({ ...finding, ...location });
    } else {
      unverifiedFindings.push({ index, reason, file: finding.file });
    }
  });
  // Ids last, over the survivors, so the numbering matches what a reader sees —
  // and this is also where the model's own line-number hints are dropped, on
  // every path out of this function, before anything persists the object.
  const findingsVerdict = {
    verifiedFindings: withFindingIds(located),
    unverifiedFindings,
    rangeAgreement,
  };

  if (out.evidence.length === 0) {
    return { label: "no_evidence", verified: [], unverified: [], ...findingsVerdict };
  }

  // Every item is examined. The version this replaced `return`ed from inside
  // this loop on the first failure, which is why an item sitting after a bad
  // one was never read at all — `tests/critic/evidence-guard.test.ts` pins
  // that with an order-swapped pair.
  out.evidence.forEach((item, index) => {
    const reason = reasonItemFails(item, citationCorpus, changedFiles, sides);
    if (reason === null) {
      verified.push(item);
    } else {
      unverified.push({ index, reason, file: item.file, line: item.line });
    }
  });

  // Nothing survived, and nothing COULD have: every cited file is one the
  // corpus holds no bytes for, so each snippet was checked against text that
  // never contained it. That is not a verdict on the reviewer, and reporting
  // `none_verified` says it is.
  //
  // TWO causes produce this, and the second is the common one — stated here
  // because the first draft of this comment named only the first and undersold
  // what shipped (caught in review):
  //
  //   1. an UNTRACKED file — `git diff HEAD` runs without `--others`;
  //   2. a file whose hunks were entirely cut by the 20-hunk review budget —
  //      `selectHunksForBudget` drops them and `scopeDiffRawToFiles`
  //      (src/brain/prompt-tools.ts) drops that file's raw bytes with them.
  //
  // This code cannot tell them apart, and (2) is not exotic: this repo's own
  // measurement puts 39.1% of source-carrying diffs over that budget
  // (src/brain/hunk-selection.ts). So the softer label is reachable by citing
  // real code in any over-budget diff, not only by inventing a new file — a
  // wider door than "untracked" suggests. Narrowing it needs the guard to know
  // WHICH files the budget cut, which is information `diffCoverage` already
  // computes and this function is not passed. Left as one case on purpose:
  // both are the same fact about the corpus — it holds nothing to check
  // against — and splitting them without that plumbing would be a guess.
  //
  // How this was found, measured on critique c-dd21 (2026-09-04): the reviewed
  // file was UNTRACKED. `changedFiles` comes from the host transcript
  // (`extractChangedFiles`, src/hooks/handle-stop.ts), so a file the agent just
  // wrote IS there and the reviewer reads it — every line number it cited was
  // correct. The corpus is tool output, and the diff tool runs `git diff HEAD`
  // with no `--others`, so an untracked file contributes nothing. All four
  // citations were refused, the review shipped `confidence: high` beside
  // `Confirmed (none)`, and the Bubble told the user to refactor a working file.
  //
  // Note the asymmetry this sits on: `reasonItemFails` lets `changedFiles`
  // stand in for the corpus on the FILE check and not on the SNIPPET check.
  // That fallback exists because the author already knew a legitimately-cited
  // file may be missing from the corpus. This applies the same reasoning one
  // line up, where it was never carried.
  //
  // COST, stated rather than buried: a review that genuinely fabricated a
  // citation about a new file now reads `not_checked` instead of
  // `none_verified`. That is the honest trade — whether the reviewer was right
  // is UNKNOWN here, and "unknown" is what the label should say. It swaps a
  // confident wrong answer for an accurate absence of one.
  //
  // Deliberately narrow: ALL of them, and none verified. A review mixing a
  // corpus-covered file with an uncovered one still reports
  // `partly_unverified`, because part of it really was checked.
  // `unverified.length > 0` was here and is dead: the early return above makes
  // `out.evidence.length >= 1`, and every item lands in exactly one of the two
  // arrays, so `verified.length === 0` already implies a non-empty `unverified`.
  // A condition that cannot vary is a condition no test can pin — dropped
  // rather than left as reassuring noise. (`every` on an empty array returns
  // true, so it is not load-bearing as a guard against that either.)
  const unrunnable =
    verified.length === 0 &&
    unverified.every((u) => corpusHasNoBytesFor(u.file, citationCorpus, changedFiles));
  if (unrunnable) {
    // WHY the corpus is empty decides which of the two labels this is, and the
    // distinction is worth the extra state because the sentences a user reads
    // are not interchangeable:
    //
    //   budget-cut → "this change was too big to read in full" — siltpoke's
    //                own limit, and something the user can act on.
    //   otherwise  → "siltpoke could not read these files" — most often an
    //                untracked file, which the user did not choose either.
    //
    // Saying the first as the second is a false statement about a case this
    // repo measures at 39.1% of source-carrying diffs, and the first draft of
    // this fix did exactly that.
    //
    // ALL of them, not any: a review split across a cut file and an unreadable
    // one gets the plainer `not_checked`, because "too big to read" would then
    // only be half the reason.
    const allBudgetCut =
      budgetCutFiles.size > 0 && unverified.every((u) => budgetCutFiles.has(u.file));
    return {
      label: allBudgetCut ? "not_checked_budget" : "not_checked",
      verified: out.evidence,
      unverified: [],
      ...findingsVerdict,
    };
  }

  const label: EvidenceLabel =
    unverified.length === 0
      ? "verified"
      : verified.length === 0
        ? "none_verified"
        : "partly_unverified";

  return { label, verified, unverified, ...findingsVerdict };
}

/**
 * True when the corpus holds nothing at all about `file`, so no snippet from it
 * could ever match.
 *
 * The file must be one the reviewer legitimately had (`changedFiles`) — this is
 * about a gap in the CORPUS, not about a citation naming some unrelated path.
 *
 * Rests on one assumption, CHECKED against each tool rather than assumed: a
 * corpus that covers a file always names it. `git diff` prints
 * `a/src/foo.ts`, ripgrep runs `--json` (a path per match), eslint
 * `--format json` (filePath), and tsc prints `src/foo.ts(12,5):`. Two test
 * fixtures described a corpus holding a file's content while never mentioning
 * it — a shape no tool produces — and updating them was the right call, not
 * loosening this.
 *
 * Inherited limit: `includes` is a substring test, so a corpus naming an
 * absolute path still matches a relative citation but not the reverse. That is
 * the same comparison `reasonItemFails` already uses for its file check, so
 * this adds no new exposure — it does not remove the existing one either.
 *
 * Same test, other direction: a short name can be swallowed by an unrelated
 * path — `"components/ba.tsx".includes("a.ts")` is true — so a corpus that
 * only ever mentions `ba.tsx` reads as covering `a.ts`. That errs AWAY from
 * `not_checked`, denying the honest label to a genuinely uncovered file rather
 * than excusing anything, so it is recorded rather than patched: a
 * segment-aware match would be the fix if this is ever seen for real.
 */
function corpusHasNoBytesFor(
  file: string,
  citationCorpus: string,
  changedFiles: Set<string>,
): boolean {
  return changedFiles.has(file) && !citationCorpus.includes(file);
}

const EXTERNAL_CLAIM_PATTERN = /\b(api|library|package|npm|sdk|webhook)\b/i;

/**
 * Returns true when the critique references an external API/library but
 * provides no web sources to ground the claim.
 *
 * Callers may use this to flag or downgrade unverified external references
 * before surfacing critiques to the user.
 */
export function hasUngroundedExternalClaim(critique: {
  critique_for_claude: string;
  web_sources: WebSource[];
}): boolean {
  if (!EXTERNAL_CLAIM_PATTERN.test(critique.critique_for_claude)) return false;
  return critique.web_sources.length === 0;
}
