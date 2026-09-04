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

const SILENT_LABELS: Array<EvidenceLabel | null> = [null, "verified", "not_checked"];

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
