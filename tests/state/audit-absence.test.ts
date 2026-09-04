// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
// Copyright (c) 2026 Jiaqi Duan
/**
 * The gate for "the timeline stops guessing why the audit blocks are empty".
 *
 * Before this, three audit blocks and the Trace tab rendered a FIXED sentence
 * claiming the review "pre-dates pipeline wire OR ran on legacy path" — on
 * reviews that had run minutes earlier. The real reason was already on the same
 * telemetry row, in `m112_reason` / `m112_guard_reason`, and nothing read it
 * (`m112_accepted` was declared in the raw row type and never mapped).
 *
 * Measured shape of a real store (400 most recent fired reviews,
 * `scripts/probes/critic-audit-coverage-probe.ts` section [4]) — every literal
 * asserted below is a string that store actually contains, not an invented one:
 *
 *     214  53.5%  guard: NORMAL mode but evidence array empty
 *      94  23.5%  suppressed: claude -p exited with code 143
 *      41  10.3%  suppressed: Brain response failed schema validation
 *      22   5.5%  accepted -> critique written
 *      13   3.3%  suppressed: all tools clean, no diff hunks
 *      12   3.0%  guard: snippet not in evidence_corpus
 *       2   0.5%  suppressed: not valid JSON
 *       2   0.5%  suppressed: spawn failed / ENOENT
 *
 * The classification is derived IN CODE from those strings — never from a
 * model-supplied boolean — per the project's LLM-systems rule that
 * routing-critical branches are computed, not trusted.
 */
import { describe, expect, test } from "bun:test";
import {
  AUDIT_ABSENCE_COPY,
  type AuditAbsenceKind,
  classifyAuditAbsence,
} from "../../src/state/audit-absence";
import { auditAbsenceNote } from "../../src/web/primitives/critique-audit/shared";

/** Terse constructor — only the fields the classifier reads. */
function row(over: {
  accepted?: unknown;
  reason?: unknown;
  guardReason?: unknown;
  critiqueId?: string | null;
}) {
  return {
    accepted: over.accepted,
    reason: over.reason,
    guardReason: over.guardReason,
    critiqueId: over.critiqueId ?? null,
  };
}

describe("classifyAuditAbsence", () => {
  test("an accepted review with an id is 'present' — audit data should exist", () => {
    expect(classifyAuditAbsence(row({ accepted: true, critiqueId: "c-3939" }))).toBe("present");
  });

  /**
   * The probe prints `guard-accepted=N has-critique_id=N agreement=400/400`.
   * That agreement is an OBSERVATION, not a guarantee — so accepted-but-no-id
   * gets its own kind rather than silently reading as "present" (which would
   * make a genuine write failure invisible in exactly the surface built to
   * explain absences).
   */
  test("accepted but NO id is 'write_failed', not 'present'", () => {
    expect(classifyAuditAbsence(row({ accepted: true, critiqueId: null }))).toBe("write_failed");
  });

  // -------------------------------------------------------------------------
  // The boundary this union does NOT cross, pinned.
  //
  // The first draft of the 2026-08-19 change added three `shown_*` kinds here
  // so an accepted-but-unverified review could be described. An independent
  // reviewer showed what that costs: `auditAbsenceNote` renders these kinds as
  // the placeholder INSIDE an empty audit block, so "some of its quotes were
  // dropped, the rest is shown as usual" would be printed as the explanation
  // for a blank RUBRIC CHECKLIST — a wrong explanation, in the one surface this
  // module exists to stop printing wrong explanations in.
  // -------------------------------------------------------------------------

  test("an accepted, saved review is 'present' no matter what its evidence label says", () => {
    // `m112_evidence_label` sits on these very rows. `AuditAbsenceInput` does
    // not declare it — that omission IS the boundary, so the cast below is the
    // test, not a workaround: it feeds the field in anyway and pins that the
    // answer does not move. The label travels on `CriticCall.evidence_label`
    // to `EvidenceMark` instead.
    for (const label of ["verified", "no_evidence", "partly_unverified", "none_verified"]) {
      const withLabel = { ...row({ accepted: true, critiqueId: "c-1" }), m112_evidence_label: label };
      expect(classifyAuditAbsence(withLabel)).toBe("present");
    }
  });

  test("write_failed still beats everything on an accepted row", () => {
    expect(classifyAuditAbsence(row({ accepted: true, critiqueId: null }))).toBe("write_failed");
  });

  test("no kind describes a review that IS on screen", () => {
    // The structural guard. Every kind here is rendered as the placeholder
    // inside an EMPTY audit block, so each one must be about something the
    // reader cannot see. A `shown_*` kind is by construction about something
    // they can, which is what made the first draft print "the rest of the
    // review is shown as usual" underneath a blank rubric checklist.
    //
    // Keyed on the name, not on the copy: two HISTORICAL kinds legitimately say
    // "quoted a line … so the whole review was thrown away" — past tense, about
    // a review that is genuinely absent — so a copy-text scan would have to
    // false-positive on them or be written loose enough to miss the real thing.
    for (const k of Object.keys(AUDIT_ABSENCE_COPY) as AuditAbsenceKind[]) {
      expect(k.startsWith("shown_")).toBe(false);
    }
  });

  test("the two HISTORICAL kinds keep their copy — 226 real rows depend on it", () => {
    // Guards the other direction of the same boundary: removing them to "clean
    // up" would send every pre-2026-08-19 guard-rejected row to `unrecorded`,
    // i.e. back to claiming it pre-dates a wire it postdates.
    expect(AUDIT_ABSENCE_COPY.evidence_empty.length).toBeGreaterThan(40);
    expect(AUDIT_ABSENCE_COPY.snippet_unverified.length).toBeGreaterThan(40);
  });

  test("no copy claims the review was thrown away — the page shows it", () => {
    // Found on a real /timeline, not in review: the two historical kinds said
    // "the whole review was thrown away", and that sentence rendered a few
    // lines UNDER the review text it was talking about. The reviewer's words
    // ride the telemetry row (`brain_output.*`) and `parseCall` surfaces them
    // with or without a `critique_id`, so the page falsifies the claim every
    // time it prints it — the same shape as the fixed "pre-dates the pipeline"
    // sentence this whole module replaced.
    //
    // What was actually discarded is the FILED RECORD, which is what the empty
    // section is. Every kind must be sayable next to visible review text.
    for (const k of Object.keys(AUDIT_ABSENCE_COPY) as AuditAbsenceKind[]) {
      const copy = AUDIT_ABSENCE_COPY[k].toLowerCase();
      expect(copy).not.toContain("thrown away");
      expect(copy).not.toContain("whole review");
    }
    // ...and the two historical kinds still explain the emptiness, rather than
    // going vague to satisfy the assertion above.
    expect(AUDIT_ABSENCE_COPY.evidence_empty).toContain("never filed");
    expect(AUDIT_ABSENCE_COPY.snippet_unverified).toContain("never filed");
  });

  // -------------------------------------------------------------------------
  // Rows already on disk from before that change. 56.5% of a real store says
  // one of the next two things, and a classifier that stopped recognising them
  // would send all of it to `unrecorded` — i.e. would claim 226 rows pre-date
  // a wire they postdate, which is the original defect coming back.
  // -------------------------------------------------------------------------

  test("HISTORICAL: the dominant case — Brain returned a critique with an empty evidence array", () => {
    expect(
      classifyAuditAbsence(row({ accepted: false, guardReason: "NORMAL mode but evidence array empty" })),
    ).toBe("evidence_empty");
  });

  test("evidence cited a snippet the corpus cannot confirm", () => {
    expect(
      classifyAuditAbsence(
        row({
          accepted: false,
          guardReason: "snippet not in evidence_corpus:     expect(ciDenylist).toEqual(docCorpusPaths);",
        }),
      ),
    ).toBe("snippet_unverified");
  });

  test("the Brain call was killed at the timeout (exit 143)", () => {
    expect(
      classifyAuditAbsence(
        row({
          reason:
            "Brain call failed in NORMAL: BrainError: [brain-failure class=resource attempts=1] claude -p exited with code 143: ",
        }),
      ),
    ).toBe("brain_killed");
  });

  test("the Brain reply failed schema validation", () => {
    expect(
      classifyAuditAbsence(
        row({ reason: "Brain call failed in NORMAL: BrainError: Brain response failed schema validation" }),
      ),
    ).toBe("brain_schema");
  });

  test("the Brain reply was not valid JSON", () => {
    expect(
      classifyAuditAbsence(
        row({
          reason:
            "Brain call failed in NORMAL: BrainError: Brain response was not valid JSON; possibly hallucinated prose around it",
        }),
      ),
    ).toBe("brain_not_json");
  });

  test("the reviewer CLI could not be spawned", () => {
    expect(
      classifyAuditAbsence(
        row({
          reason:
            "Brain call failed in NORMAL: BrainError: [brain-failure class=permanent attempts=1] claude -p spawn failed: Error: ENOENT: no such file or directory, posix_spawn 'claude'",
        }),
      ),
    ).toBe("brain_unavailable");
  });

  test("there was genuinely nothing to review", () => {
    expect(classifyAuditAbsence(row({ reason: "all tools clean, no diff hunks" }))).toBe(
      "nothing_to_review",
    );
  });

  test("an unrecognised Brain failure still reads as a Brain failure, not as legacy", () => {
    expect(
      classifyAuditAbsence(row({ reason: "Brain call failed in NORMAL: BrainError: something new" })),
    ).toBe("brain_failed_other");
  });

  /**
   * The ONLY case allowed to claim "this row predates the pipeline". Before
   * this change every row claimed it. The regression this pins: a row that DOES
   * carry a reason must never fall through to here.
   */
  test("only a row carrying no reason at all reads as 'unrecorded'", () => {
    expect(classifyAuditAbsence(row({}))).toBe("unrecorded");
    expect(classifyAuditAbsence(row({ accepted: false, reason: "", guardReason: "" }))).toBe(
      "unrecorded",
    );
  });

  /**
   * A skip is not a review, so there is no critique whose absence needs an
   * explanation. Without its own kind it would fall through to `unrecorded`
   * and a skip from seconds ago would claim to pre-date the wiring — the same
   * defect, one row-type over.
   */
  test("a skipped turn is 'not_reviewed', never 'unrecorded'", () => {
    expect(classifyAuditAbsence({ ...row({}), skipped: true })).toBe("not_reviewed");
  });

  test("skipped wins even when the row carries a stale reason", () => {
    expect(
      classifyAuditAbsence({
        ...row({ accepted: true, critiqueId: "c-1234" }),
        skipped: true,
      }),
    ).toBe("not_reviewed");
  });

  test("a guard reason wins over a suppression reason when both are somehow present", () => {
    expect(
      classifyAuditAbsence(
        row({
          accepted: false,
          guardReason: "NORMAL mode but evidence array empty",
          reason: "Brain call failed in NORMAL: BrainError: Brain response failed schema validation",
        }),
      ),
    ).toBe("evidence_empty");
  });
});

describe("AUDIT_ABSENCE_COPY", () => {
  /**
   * DERIVED, not hand-listed. A hand-written array is the classic blind spot
   * here: add a twelfth kind, forget to add it to the list, and the
   * "only 'unrecorded' may mention predating" assertion below silently stops
   * covering it — the check would still be green while the thing it guards had
   * a hole. `AUDIT_ABSENCE_COPY` is typed `Record<AuditAbsenceKind, string>`,
   * so tsc already refuses a map that misses a union member; reading the keys
   * back off that map is therefore the complete set by construction.
   */
  const KINDS = Object.keys(AUDIT_ABSENCE_COPY) as AuditAbsenceKind[];

  test("the derived kind set is non-empty — an empty set would pass every loop below", () => {
    expect(KINDS.length).toBeGreaterThanOrEqual(11);
  });

  test("every kind has copy — a kind with no copy would render blank", () => {
    for (const k of KINDS) {
      expect(AUDIT_ABSENCE_COPY[k]).toBeTruthy();
      expect(AUDIT_ABSENCE_COPY[k].length).toBeGreaterThan(10);
    }
  });

  /**
   * The whole point of the change. "pre-dates" was the fixed sentence shown for
   * every absence; it may survive on exactly one kind — the one where it is
   * true — and must appear nowhere else.
   */
  test("only 'unrecorded' is allowed to mention predating the pipeline", () => {
    for (const k of KINDS) {
      // Matches the plain-language form too. The copy was rewritten out of
      // internal register ("pre-dates pipeline wire") into "older than the code
      // that started recording it"; a detector pinned to the old jargon would
      // have gone quietly blind on the very kind it exists to police.
      const mentionsLegacy = /pre-date|predate|legacy|older than/i.test(AUDIT_ABSENCE_COPY[k]);
      expect(mentionsLegacy).toBe(k === "unrecorded");
    }
  });

  /**
   * Found by re-capturing the goldens, not by review: the golden fixture builds
   * its CriticCall with `as unknown as CriticCall`, so it had no `audit_absence`
   * at all, and the placeholder rendered as an EMPTY string — an undefined JSX
   * child is simply nothing on the page. A blank note is worse than the wrong
   * sentence it replaced, because the wrong one was at least visible.
   *
   * The cast means tsc can never guard this, so the guard is here.
   */
  test("the three empty blocks say three DIFFERENT things, and none points 'below'", () => {
    // Reported on a real page as : all three blocks called
    // `auditAbsenceNote(kind)` with no block context, so a review with no v2
    // sidecar printed the SAME sentence three times under three different
    // headings — and that sentence said "the detailed breakdown BELOW" while
    // being the only thing in the block. Pre-existing since #607; it became
    // common because this branch routes ~56.5% more reviews through here.
    const a = auditAbsenceNote("present", "A");
    const c = auditAbsenceNote("present", "C");
    const d = auditAbsenceNote("present", "D");
    expect(new Set([a, c, d]).size).toBe(3);

    // Each names what IS missing from its own block, in that block's terms.
    expect(a).toContain("what Siltpoke read");
    // Not "no rubric checklist": the checklist is always drawn now, with a dot
    // on every rule. What is missing is the per-rule result, and the old
    // wording would contradict the list rendered under it.
    expect(c).toContain("rule-by-rule result");
    expect(d).toContain("signals");

    // ...and each still carries the shared reason, so the split did not trade
    // the repetition for three sentences that no longer say why.
    for (const note of [a, c, d]) {
      expect(note).toContain(AUDIT_ABSENCE_COPY.present);
      expect(note.toLowerCase()).not.toContain("below");
    }

    // No kind may point downwards from inside a block it is the whole content of.
    for (const k of Object.keys(AUDIT_ABSENCE_COPY) as AuditAbsenceKind[]) {
      expect(AUDIT_ABSENCE_COPY[k].toLowerCase()).not.toContain("below");
    }
  });

  test("no kind claims the section is empty — Block C renders 13 rules under it", () => {
    // Since 2026-08-19 Block C draws its full static rule list and puts this
    // note ABOVE it, so "which is why this section is empty" was being printed
    // over thirteen visible rows. Two strings said it and were fixed; two more
    // said "nothing to show" and "why this is blank" and were missed on the
    // first pass — an independent review found them. Hence a structural check
    // rather than a re-read: the class of wording is what has to stay out.
    const forbidden = [
      "section is empty",
      "this is blank",
      "nothing to show",
      "is blank",
      "left blank",
    ];
    for (const k of Object.keys(AUDIT_ABSENCE_COPY) as AuditAbsenceKind[]) {
      const copy = AUDIT_ABSENCE_COPY[k].toLowerCase();
      for (const phrase of forbidden) {
        expect(`${k}: ${copy}`).not.toContain(phrase);
      }
    }
    // Positive control: the check can fire. Without this, a typo in every
    // `forbidden` entry would leave the loop asserting nothing, and it would
    // read exactly like a clean pass.
    expect(forbidden.some((p) => "which is why this section is empty".includes(p))).toBe(true);
  });

  test("the Trace tab, which has no block, still gets the bare reason", () => {
    // `block` is optional for exactly one caller. If that stopped working the
    // trace note would render `undefined ...` — an undefined child is nothing
    // at all, which is the blank-note failure this module already ate once.
    expect(auditAbsenceNote("present")).toBe(AUDIT_ABSENCE_COPY.present);
  });

  test("an unrecognised kind still renders text — never blank", () => {
    const bogus = "not-a-kind" as unknown as AuditAbsenceKind;
    expect(auditAbsenceNote(bogus).length).toBeGreaterThan(10);
  });

  test("every real kind renders its own copy through the note helper", () => {
    for (const k of KINDS) {
      expect(auditAbsenceNote(k)).toBe(AUDIT_ABSENCE_COPY[k]);
    }
  });

  test("copy never leaks the raw reason string's variable tail", () => {
    for (const k of KINDS) {
      expect(AUDIT_ABSENCE_COPY[k]).not.toContain("/Users/");
      expect(AUDIT_ABSENCE_COPY[k]).not.toContain("BrainError");
    }
  });
});
