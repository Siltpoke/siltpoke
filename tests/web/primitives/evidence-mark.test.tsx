// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
// Copyright (c) 2026 Jiaqi Duan
/** @jsxImportSource hono/jsx */
/**
 * `EvidenceMark` — the strip that tells a reader how far to trust the review
 * they are looking at.
 *
 * This component is the safety half of the 2026-08-19 evidence-guard change.
 * Before it, an unverifiable review was deleted; after it, the review is shown.
 * If the mark ever silently stops rendering, the product does not revert to the
 * old behavior — it lands somewhere worse than either: unverified reviews
 * presented as if they had been checked. So the tests below assert that it
 * renders on each label that needs it, and — just as load-bearing — that it
 * renders NOTHING otherwise, because a mark on every review is a mark nobody
 * reads.
 *
 * It is keyed on `CriticCall.evidence_label`, NOT on `audit_absence`. The first
 * draft used the absence kinds and an independent reviewer caught what that
 * costs: `auditAbsenceNote` renders those kinds as the placeholder INSIDE an
 * empty audit block, so "two of its quotes were dropped" would have been
 * printed as the explanation for a blank rubric checklist.
 *
 * These are string-render assertions. They cannot see whether the element is
 * VISIBLE in a browser; `tests/e2e/critic-evidence-mark.spec.ts` covers that,
 * and it exists because a previous marker in this repo passed its unit, SSR and
 * route tests while shipping `display:none` on every real page.
 */
import { describe, expect, test } from "bun:test";
import { EvidenceMark } from "../../../src/web/primitives/critique-audit/shared";
import type { EvidenceLabel } from "../../../src/critic/evidence-guard";

// `not_checked` LEFT this list on 2026-09-04 and that is the point of the
// change: it used to be here because it was unreachable in production —
// `guardCritique`'s one call site passes "NORMAL", so only the
// PASSIVE_BUBBLE/HARD_SUPPRESS branch produced it and nothing ran that branch.
// The empty-corpus fix made it reachable from NORMAL, at which point silence
// meant a review with NOT ONE examined citation rendered exactly like a
// fully-grounded one — the failure this component exists to prevent.
const SILENT_LABELS: Array<EvidenceLabel | null> = [null, "verified"];

describe("EvidenceMark", () => {
  test("a review that cited nothing says so, and says it without a count", () => {
    const html = String(<EvidenceMark label="no_evidence" unverifiedCount={0} />);
    expect(html).toContain('data-evidence-mark="no_evidence"');
    expect(html).toContain("unconfirmed");
    expect(html).toContain("does not point at any line");
    // "0 quotes could not be confirmed" would be true and useless here.
    expect(html).not.toContain("0 quote");
  });

  test("a partly-unverified review names how many quotes went", () => {
    const html = String(<EvidenceMark label="partly_unverified" unverifiedCount={2} />);
    expect(html).toContain("2 quotes");
    expect(html).toContain('data-unverified-count="2"');
    // Only true when EVERY quote failed — saying it here would overstate.
    expect(html).not.toContain("all of them");
    expect(html).not.toContain("nothing here is confirmed");
  });

  test("one dropped quote reads as singular", () => {
    const html = String(<EvidenceMark label="partly_unverified" unverifiedCount={1} />);
    expect(html).toContain("1 quote could not");
    expect(html).not.toContain("1 quotes");
    expect(html).toContain("it was dropped");
  });

  test("nothing left standing, plural", () => {
    const html = String(<EvidenceMark label="none_verified" unverifiedCount={3} />);
    expect(html).toContain("none of the 3 lines");
    expect(html).toContain("all of them were dropped");
    expect(html).toContain("nothing here is confirmed");
  });

  test("nothing left standing, and there was only ONE — reads as English, not as a count bug", () => {
    // The bug an independent reviewer found: the single-template version
    // produced `1 quote … — that was all of them`. n=1 is the commonest real
    // instance of `none_verified` (a review cites one line, that line cannot be
    // confirmed), and the suite covered only n=3, so it was structurally blind
    // to the sentence most users would actually see.
    const html = String(<EvidenceMark label="none_verified" unverifiedCount={1} />);
    expect(html).toContain("the only line this review quotes");
    expect(html).toContain("nothing here is confirmed");
    expect(html).not.toContain("all of them");
    expect(html).not.toContain("1 quotes");
    expect(html).not.toContain("none of the 1");
  });

  test("renders NOTHING for a verified, unchecked, or unrecorded review", () => {
    // Enumerated rather than sampled. The failure mode this guards is a mark
    // that fires on ordinary reviews, which is how a caveat stops being read.
    for (const label of SILENT_LABELS) {
      expect(String(<EvidenceMark label={label} unverifiedCount={0} />)).toBe("");
    }
  });

  test("an unchecked review says so, and does not need a count to say it", () => {
    // Its count is legitimately 0 — the items pass through as
    // cited-but-unexamined, so nothing sits in `unverified` — which is why
    // this branch has to return BEFORE the count gates below. Keying it on the
    // count would have re-silenced it.
    const html = String(<EvidenceMark label="not_checked" unverifiedCount={0} />);
    expect(html).toContain('data-evidence-mark="not_checked"');
    expect(html).toContain("unchecked");
    expect(html).toContain("could not read the files");
    // It must NOT read as a verdict on the reviewer: the findings may be right,
    // nobody checked. That distinction is the whole reason for the label.
    expect(html).toContain("may still be right");
    expect(html).not.toContain("dropped");
  });

  test("the budget case says WHY, and does not claim the files were unreadable", () => {
    // The two unchecked labels are not interchangeable. Siltpoke DID read this
    // diff and dropped part of it — the user can act on that (make a smaller
    // change) in a way they cannot act on an unreadable file. A first draft
    // printed the unreadable sentence for both, which is false for the case
    // this repo measures at 39.1% of source-carrying diffs.
    const html = String(<EvidenceMark label="not_checked_budget" unverifiedCount={0} />);
    expect(html).toContain('data-evidence-mark="not_checked_budget"');
    expect(html).toContain("too large");
    expect(html).toContain("the part it skipped");
    expect(html).not.toContain("could not read the files");
    // Still not a verdict on the reviewer.
    expect(html).toContain("may still be right");
  });

  test("NEITHER unchecked label is silent — the failure TypeScript cannot catch", () => {
    // Both are members of one union, so a consumer written as
    // `=== "not_checked"` keeps compiling and quietly stops being true when the
    // second label arrives. That is exactly how `not_checked` itself went
    // unnoticed here: it sat in SILENT_LABELS while unreachable in production,
    // and the moment it became reachable a wholly-unexamined review rendered
    // like a grounded one. Enumerated so adding a third cannot repeat it.
    for (const label of ["not_checked", "not_checked_budget"] as const) {
      const html = String(<EvidenceMark label={label} unverifiedCount={0} />);
      expect(html).not.toBe("");
      expect(html).toContain("unchecked");
    }
  });

  test("a label promising dropped quotes with a count of 0 renders nothing", () => {
    // Not reachable from today's writer — `handle-stop` writes both fields
    // together — but `unverifiedCountOf` coerces any absent or malformed value
    // to 0, so a truncated or hand-edited row can produce this pair. "0 quotes
    // … were dropped" on a review that is fine is noise, not a caveat.
    expect(String(<EvidenceMark label="partly_unverified" unverifiedCount={0} />)).toBe("");
    expect(String(<EvidenceMark label="none_verified" unverifiedCount={0} />)).toBe("");
    // ...but `no_evidence` legitimately has a count of 0 and must still render.
    expect(String(<EvidenceMark label="no_evidence" unverifiedCount={0} />)).not.toBe("");
  });

  test("the silent list is not the whole union — otherwise the loop above is vacuous", () => {
    expect(SILENT_LABELS).not.toContain("no_evidence");
    expect(SILENT_LABELS).not.toContain("partly_unverified");
    expect(SILENT_LABELS).not.toContain("none_verified");
  });
});
