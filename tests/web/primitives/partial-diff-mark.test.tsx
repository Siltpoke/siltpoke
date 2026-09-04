// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
// Copyright (c) 2026 Jiaqi Duan
/** @jsxImportSource hono/jsx */
/**
 * `PartialDiffMark` — the strip that tells a reader how much of their change
 * the review in front of them actually saw.
 *
 * WHY IT IS SILTPOKE'S COUNT AND NOT THE REVIEWER'S. #626 shipped a prompt that
 * asks the reviewer to declare partial coverage in `reasoning`, and a code
 * comment (plus four documents) claiming the schema forced that field to be
 * non-empty. It does not: `brain.ts` parses with `schema.ts`, where `reasoning`
 * is `.optional()`. So the declaration was a request with nothing behind it,
 * and a review written on a quarter of a diff could still arrive reading like a
 * review written on all of it. This component is the answer that does not
 * depend on the model having complied.
 *
 * Sibling of `EvidenceMark`, not a merge of it: that one answers "do the quotes
 * in this review check out", this one answers "did the reviewer see the change
 * at all". A review can be perfectly grounded in the quarter it was handed.
 *
 * These are string-render assertions. They cannot see whether the element is
 * VISIBLE in a browser — the same caveat `evidence-mark.test.tsx` carries, and
 * for the same measured reason: a previous marker in this repo passed its unit,
 * SSR and route tests while shipping `display:none` on every real page.
 */
import { describe, expect, test } from "bun:test";
import { PartialDiffMark } from "../../../src/web/primitives/critique-audit/shared";

describe("PartialDiffMark", () => {
  test("a partial review states both numbers, in siltpoke's own words", () => {
    const html = String(<PartialDiffMark shown={20} total={91} />);
    expect(html).toContain('data-partial-diff="true"');
    expect(html).toContain('data-diff-shown="20"');
    expect(html).toContain('data-diff-total="91"');
    expect(html).toContain("partial diff");
    // Both halves, always. "20 of ?" reads as a rendering bug and "? of 91"
    // invites the reader to fill in the blank.
    expect(html).toContain("20");
    expect(html).toContain("91");
  });

  test("nothing renders when the whole diff fitted", () => {
    // A mark on every review is a mark nobody reads.
    expect(String(<PartialDiffMark shown={20} total={20} />)).toBe("");
  });

  test("nothing renders on a row that carries no counts", () => {
    // Rows written before 2026-08-20 have no counts, and a row whose diff
    // fitted has none either — the two are indistinguishable here, so silence
    // must mean "no claim", never "full coverage".
    expect(String(<PartialDiffMark shown={null} total={null} />)).toBe("");
    expect(String(<PartialDiffMark shown={20} total={null} />)).toBe("");
    expect(String(<PartialDiffMark shown={null} total={91} />)).toBe("");
  });

  test("nothing renders on an incoherent pair", () => {
    // total < shown, or a zero shown, is a writer bug. Printing "0 of 91" or
    // "91 of 20" would present a defect as a fact about the user's diff.
    expect(String(<PartialDiffMark shown={91} total={20} />)).toBe("");
    expect(String(<PartialDiffMark shown={0} total={91} />)).toBe("");
  });
});
