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

import type { BrainOutput, EvidenceItem } from "../brain/schema";
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

export interface EvidenceVerdict {
  label: EvidenceLabel;
  /**
   * The items that check out — the ONLY ones a caller may surface as evidence.
   * Everything else in the review is surfaced regardless of this list.
   */
  verified: EvidenceItem[];
  /** One entry per refused item. Empty when nothing was refused. */
  unverified: UnverifiedEvidence[];
}

/** Snippet reason strings are truncated here to keep telemetry logs scannable. */
const SNIPPET_PREVIEW_MAX = 60;

function previewOf(snippet: string): string {
  return snippet.length > SNIPPET_PREVIEW_MAX
    ? `${snippet.slice(0, SNIPPET_PREVIEW_MAX)}...`
    : snippet;
}

/**
 * Check one evidence item against the corpus. Returns null when it checks out,
 * or the log-safe reason it does not.
 */
function reasonItemFails(
  item: EvidenceItem,
  citationCorpus: string,
  changedFiles: Set<string>,
): string | null {
  // Snippet must appear verbatim in the tool-derived citation corpus.
  if (!citationCorpus.includes(item.snippet)) {
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
    return { label: "not_checked", verified: out.evidence, unverified: [] };
  }

  // NORMAL from here.

  if (out.evidence.length === 0) {
    return { label: "no_evidence", verified: [], unverified: [] };
  }

  const verified: EvidenceItem[] = [];
  const unverified: UnverifiedEvidence[] = [];

  // Every item is examined. The version this replaced `return`ed from inside
  // this loop on the first failure, which is why an item sitting after a bad
  // one was never read at all — `tests/critic/evidence-guard.test.ts` pins
  // that with an order-swapped pair.
  out.evidence.forEach((item, index) => {
    const reason = reasonItemFails(item, citationCorpus, changedFiles);
    if (reason === null) {
      verified.push(item);
    } else {
      unverified.push({ index, reason, file: item.file, line: item.line });
    }
  });

  const label: EvidenceLabel =
    unverified.length === 0
      ? "verified"
      : verified.length === 0
        ? "none_verified"
        : "partly_unverified";

  return { label, verified, unverified };
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
