// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
// Copyright (c) 2026 Jiaqi Duan
/**
 * Why a review has no audit trail — derived, not guessed.
 *
 * The timeline's three audit blocks (A / C / D) and the Trace tab used to
 * render ONE fixed sentence for every absence:
 *
 *     "v2 audit data unavailable — this review pre-dates pipeline wire OR ran
 *      on legacy path."
 *     "no trace join possible — this turn pre-dates per-row review ids."
 *
 * Both are claims about history, and both were shown on reviews that had run
 * minutes earlier. The accurate reason was never missing: it sits on the same
 * telemetry row, in `m112_reason` (a suppression) or `m112_guard_reason` (an
 * evidence-guard rejection). Nothing read either — `m112_accepted` was even
 * declared in the raw row type and then never mapped onto `CriticCall`. So the
 * surface built to explain an absence was printing a wrong explanation it had
 * the data to get right. That is the "signal decoupled from reality" shape in
 * `docs/lessons.md` L3, in its "lying" family.
 *
 * Measured distribution over the 400 most recent fired reviews of a real store
 * (`scripts/probes/critic-audit-coverage-probe.ts` section [4], snapshot
 * committed beside it):
 *
 *     214  53.5%  guard: NORMAL mode but evidence array empty
 *      94  23.5%  suppressed: claude -p exited with code 143
 *      41  10.3%  suppressed: Brain response failed schema validation
 *      22   5.5%  accepted -> critique written, id minted
 *      13   3.3%  suppressed: all tools clean, no diff hunks
 *      12   3.0%  guard: snippet not in evidence_corpus
 *       2   0.5%  suppressed: not valid JSON
 *       2   0.5%  suppressed: spawn failed / ENOENT
 *
 * None of those eight is "pre-dates the pipeline".
 *
 * The classification is computed here, in code, from those strings. It is
 * deliberately NOT taken from any model-produced field — same rule the project
 * applies to every routing-critical branch.
 *
 * Full write-up: an internal design note §2.4.
 *
 * **2026-08-19, second half.** The top two rows of that table — 56.5% of the
 * distribution — were reviews the evidence guard threw away whole. The guard
 * now labels instead of deleting (`src/critic/evidence-guard.ts`), so those
 * reviews are SHOWN. `evidence_empty` and `snippet_unverified` are kept, and
 * kept accurate, for the rows already on disk: a classifier that stopped
 * recognising them would make 226 real rows fall through to `unrecorded` and
 * claim to pre-date a wire they postdate.
 *
 * **This module was NOT extended to describe those newly-shown reviews**, and
 * the first draft of that change is why the boundary is now written down. This
 * union answers exactly one question — *why is the audit trail missing* — and
 * `auditAbsenceNote` renders it as the note standing in for the result an audit
 * block has no record of. (Since 2026-08-19 Block C still draws its static rule
 * list underneath, with a dot on every rule; the note says why none of them has
 * a result. Blocks A and D are still empty when it shows.)
 * A kind meaning "shown, but two of its quotes were dropped" would therefore be
 * printed as the explanation for a rubric checklist with no results: a wrong
 * explanation, in the one surface built to stop printing wrong explanations.
 * How much of a
 * review was confirmed rides its own field (`CriticCall.evidence_label` +
 * `evidence_unverified`) to its own component (`EvidenceMark`).
 */

/**
 * Closed set. A closed union (rather than passing the raw reason through) is
 * the same choice `RefFailure.kind` made for `/knowledge` parse failures: the
 * raw strings carry a variable tail — a snippet of the user's own code, an
 * absolute path, a stderr fragment — that must not reach the page, and an open
 * string would make every distinct tail its own "reason".
 */
export type AuditAbsenceKind =
  /** The evidence check passed and an id was minted; the v2 archive is a SECOND gate. */
  | "present"
  /** Accepted, but no id came back — the critique write itself failed. */
  | "write_failed"
  /**
   * HISTORICAL. Guard rejected: the reviewer returned a critique with no
   * evidence at all, so the whole review was discarded. No new row can carry
   * this — a review with no evidence is SHOWN and marked today — but
   * 53.5% of the rows already written say exactly this, and the timeline still
   * has to explain them.
   */
  | "evidence_empty"
  /** HISTORICAL. Guard rejected: cited a snippet absent from the evidence corpus. */
  | "snippet_unverified"
  /** The reviewer subprocess was killed at its timeout. */
  | "brain_killed"
  /** The reviewer replied, but the reply failed schema validation. */
  | "brain_schema"
  /** The reviewer's reply was not valid JSON. */
  | "brain_not_json"
  /** The reviewer CLI could not be spawned at all. */
  | "brain_unavailable"
  /** Tools clean and no diff hunks — there was nothing to review. */
  | "nothing_to_review"
  /** A reviewer failure whose text this classifier does not recognise. */
  | "brain_failed_other"
  /** The turn never reached a review at all (a skip: no code changed, muted, budget, ...). */
  | "not_reviewed"
  /** No reason recorded on the row at all — the ONLY genuinely legacy case. */
  | "unrecorded";

export interface AuditAbsenceInput {
  /** `m112_accepted` — whether the evidence guard accepted. */
  accepted: unknown;
  /** `m112_reason` — why the run was suppressed. */
  reason: unknown;
  /** `m112_guard_reason` — why the evidence guard rejected. */
  guardReason: unknown;
  /** The row's `critique_id`, already normalized to string|null. */
  critiqueId: string | null;
  /**
   * True when this row is a SKIP — the Stop hook declined to review at all, so
   * there is no critique whose absence needs explaining.
   *
   * Without this the classifier would fall through to `unrecorded` and a skip
   * that happened seconds ago would claim to pre-date the wiring — which is the
   * very defect this module exists to remove, reintroduced one row-type over.
   */
  skipped?: boolean;
}

function text(v: unknown): string {
  return typeof v === "string" ? v : "";
}

/**
 * Classify why this row has no audit trail.
 *
 * Order matters. A guard reason is checked BEFORE a suppression reason: a guard
 * rejection is the later, more specific event (the Brain call succeeded and its
 * output was then refused), so if a row somehow carries both, the guard reason
 * is the one that describes what actually stopped the write.
 */
export function classifyAuditAbsence(input: AuditAbsenceInput): AuditAbsenceKind {
  if (input.skipped === true) return "not_reviewed";

  if (input.accepted === true) {
    // Saved, or not saved. That is the whole question this function answers.
    //
    // It deliberately does NOT branch on how much of the review's evidence was
    // confirmed, even though that is now recorded on the same row. These kinds
    // are rendered by `auditAbsenceNote` as the note standing in for a result
    // an audit block (A / C / D) has no record of — above Block C's always-drawn
    // rule list, as the whole content of A and D — so a kind that talked about
    // dropped citations
    // would get printed as the explanation for a missing rubric checklist —
    // a wrong explanation, in the exact surface this module exists to stop
    // printing wrong explanations in. (Caught in review; the first draft did
    // add three `shown_*` kinds here.) The evidence label travels on its own
    // field, `CriticCall.evidence_label`, to its own component, `EvidenceMark`.
    return input.critiqueId !== null && input.critiqueId !== "" ? "present" : "write_failed";
  }

  const guard = text(input.guardReason);
  if (guard !== "") {
    if (guard.includes("evidence array empty")) return "evidence_empty";
    if (guard.includes("evidence_corpus")) return "snippet_unverified";
  }

  const reason = text(input.reason);
  if (reason !== "") {
    if (reason.includes("no diff hunks")) return "nothing_to_review";
    // Ordered most-specific-first: a spawn failure and a non-zero exit are both
    // "the subprocess did not give us output", but they are different problems
    // for the reader (one is an install/PATH fault, the other a timeout kill).
    if (reason.includes("spawn failed") || reason.includes("ENOENT")) return "brain_unavailable";
    if (reason.includes("exited with code 143")) return "brain_killed";
    if (reason.includes("failed schema validation")) return "brain_schema";
    if (reason.includes("not valid JSON")) return "brain_not_json";
    return "brain_failed_other";
  }

  // Nothing recorded. This — and only this — is the row that may claim to
  // pre-date the wire.
  return "unrecorded";
}

/**
 * User-facing copy, one per kind.
 *
 * English per the 2026-08-18 decision ("the page's own words are English;
 * content carried in from a source document keeps that document's language").
 *
 * **Plain words on purpose.** The sentence being replaced —
 * "v2 audit data unavailable — this review pre-dates pipeline wire OR ran on
 * legacy path" — was not only wrong, it was unreadable: the user's verdict on
 * it was "I have no idea what this means." Writing the replacement in the same
 * register would have fixed half the defect. So: no "audit trail", no
 * "verdict", no "evidence corpus", no internal field names. Say who did what
 * and what it cost the reader.
 *
 * The two HISTORICAL kinds used to say "the whole review was thrown away", and
 * the page printing it was the thing that falsified it. Found by looking at a
 * real `/timeline` on 2026-08-19: the reviewer's words live on the telemetry
 * row itself (`brain_output.bubble_short` / `bubble_long` /
 * `critique_for_claude`) and `parseCall` surfaces them whether or not a
 * critique was ever filed — so "the whole review was thrown away" was
 * rendering a few lines beneath the review it claimed had been thrown away.
 *
 * What was thrown away is the FILED RECORD: no `critique_id`, no v2 sidecar,
 * which is exactly the emptiness the sentence is standing in. The copy says
 * that now — true, and an answer to the question the reader actually has
 * ("why is there no record here"). **No string in this table may say the
 * section is empty or blank**: since 2026-08-19 Block C renders its full rule
 * list underneath, so "this section is empty" was being printed above thirteen
 * visible rules. Two strings said it, both were fixed, and two more said
 * "nothing to show" / "why this is blank" and were missed on the first pass —
 * which is why the rule is written down here rather than left to reading.
 * Same defect family as the fixed sentence this
 * whole module was written to replace: a surface explaining an absence with a
 * claim its own page contradicts.
 *
 * Never includes the raw error text: the variable tail of a reason string can
 * carry the user's own source and absolute paths.
 */
export const AUDIT_ABSENCE_COPY: Record<AuditAbsenceKind, string> = {
  // No "below" — this sentence IS the block's content, so pointing downwards
  // pointed at nothing. Reported on a real page as reading like a bug.
  present:
    "Siltpoke reviewed this turn and saved it; this part is only recorded on some runs, and it wasn't on this one.",
  write_failed:
    "Siltpoke finished this review but failed to save it. That is not supposed to happen — worth reporting.",
  evidence_empty:
    "Siltpoke had something to say but did not point at any specific line, so this review was never filed — which is why nothing was recorded here. What you can read above survived only because it was written to the run log. This was by far the most common reason for a missing record; since 2026-08-19 these reviews are filed and marked unconfirmed instead.",
  snippet_unverified:
    "Siltpoke quoted a line of code it could not find in the excerpt it was given to read, so this review was never filed — which is why nothing was recorded here, including the parts that were fine. What you can read above survived only because it was written to the run log. Since 2026-08-19 only the bad quote is dropped and the rest is kept.",
  brain_killed:
    "Siltpoke took too long and was cut off before it finished, so it never produced this part.",
  brain_schema:
    "Siltpoke answered, but not in a format this page can read, so the answer was discarded.",
  brain_not_json: "Siltpoke's answer came back garbled and could not be read.",
  brain_unavailable:
    "Siltpoke could not start the reviewer program on this machine. Check that it is installed.",
  nothing_to_review:
    "Nothing to review here — no code changed on this turn, and every check came back clean.",
  brain_failed_other: "The review failed. The exact error is in the daemon log.",
  not_reviewed: "No review ran on this turn. The reason why is on the row itself.",
  unrecorded:
    "Nothing was recorded about why this is missing. This turn is older than the code that started recording it.",
};
