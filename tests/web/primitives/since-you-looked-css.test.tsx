// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.1
// Copyright (c) 2026 Jiaqi Duan
/**
 * Every class the "Since you last looked" island invents must have a rule.
 *
 * The panel shipped with seven class names — `syl-row`, `syl-row-path`,
 * `syl-row-tag`, `syl-row-why`, `syl-row-disclosure`, `syl-dir-group`,
 * `syl-dir-label` — and not one of them had a CSS rule anywhere in the repo.
 * The only match for `.syl-row` was a COMMENT in the panel describing the
 * layout it was supposed to have. So the rows rendered as bare inline spans
 * jammed together with no separator, and the disclosure control (a `div`, so
 * block-level) broke onto its own line:
 *
 *     _index_repos.tsnew to youno WHY recorded
 *     mark seen
 *
 * A test that hard-codes today's seven names would go stale the moment an
 * eighth is added — which is exactly how the first seven got here. So this
 * reads the class names OUT of the island's source and requires a rule for
 * each. Adding a class with no style fails this test by construction.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { SINCE_YOU_LOOKED_CSS, SinceYouLookedPanel } from "../../../src/web/primitives/SinceYouLookedPanel";

const ISLAND = join(import.meta.dir, "../../../src/web/client/islands/since-you-looked.ts");

/** Every `el.className = "syl-…"` literal the island assigns. */
function islandClassNames(): string[] {
  const src = readFileSync(ISLAND, "utf8");
  const found = new Set<string>();
  for (const m of src.matchAll(/className\s*=\s*"(syl-[a-z0-9-]+)"/g)) {
    if (m[1]) found.add(m[1]);
  }
  return [...found].sort();
}

describe("SinceYouLookedPanel — the island's classes are actually styled", () => {
  test("the island really does invent classes (guard against a regex that matches nothing)", () => {
    // Without this, a rename in the island would silently empty the list below
    // and every assertion in this file would pass over zero classes.
    const names = islandClassNames();
    expect(names.length).toBeGreaterThanOrEqual(7);
    expect(names).toContain("syl-row");
    expect(names).toContain("syl-row-disclosure");
  });

  test("every class the island assigns has a rule in the panel's stylesheet", () => {
    const css = SINCE_YOU_LOOKED_CSS;
    const missing = islandClassNames().filter((c) => !new RegExp(`\\.${c}\\b`).test(css));
    expect(missing).toEqual([]);
  });

  test("the row is laid out, not left to default inline flow — that is the actual defect", () => {
    // The bug was not "unstyled"; it was that four children with no box model
    // ran together into one unreadable string. A rule that only set a colour
    // would satisfy the coverage test above and still ship the same screenshot.
    const rowRule = SINCE_YOU_LOOKED_CSS.match(/\.syl-row\s*\{[^}]*\}/)?.[0] ?? "";
    expect(rowRule).toContain("display:");
    expect(rowRule).toMatch(/gap:/);
  });

  test("the panel ships the stylesheet with itself, so the rules cannot be left behind", () => {
    const html = String(SinceYouLookedPanel({ projHash: "abc123" }));
    expect(html).toContain(".syl-row");
    expect(html).toContain("<style");
  });
});
