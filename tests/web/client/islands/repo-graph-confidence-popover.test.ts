/**
 * Unit tests: confidence popover content builder + tier-word helper.
 *
 * Pins the exact content spec for the popover: chip wording + popover
 * content copy.
 *
 * No DOM harness needed — these are pure string functions.
 *
 * // v2 copy:
 * //   definition-line pin → "What we counted"
 * //   action-phrase pins → So-what tier-variant pins
 * //   gap-line pin → gap number inside So-what
 * //   ADD fileCount variant tests
 */
import { describe, expect, test } from "bun:test";
import type { CoverageTier } from "../../../../src/repo-graph/types";
import {
  type CoverageInput,
  buildConfidencePopoverHtml,
  confidenceTierWord,
} from "../../../../src/web/client/islands/repo-graph-popovers";

describe("confidenceTierWord", () => {
  test("green → high (no suffix)", () => {
    expect(confidenceTierWord("green")).toBe("high"); // no '· path shown'
  });
  test("yellow → medium (no suffix)", () => {
    expect(confidenceTierWord("yellow")).toBe("medium");
  });
  test("red → low (no suffix)", () => {
    expect(confidenceTierWord("red")).toBe("low");
  });
  test("unknown tier → low (safe fallback)", () => {
    // Cast: the type now forbids this at compile time (review round-2 tightened
    // tier to CoverageTier); the runtime fallback stays pinned for malformed API data.
    expect(confidenceTierWord("unknown" as CoverageTier)).toBe("low");
  });
});

describe("buildConfidencePopoverHtml — high tier (green)", () => {
  const cov: CoverageInput = {
    pct: 76,
    tier: "green",
    resolvedCallsites: 3192,
    totalCallsites: 4186,
  };

  test("title: WHY THIS PATH IS TRUSTWORTHY in aria-label only, NOT in content (cycle-2 de-label)", () => {
    // flipped per 2026-06-12 cycle-2 de-label ruling
    const html = buildConfidencePopoverHtml(cov);
    expect(html).not.toContain("WHY THIS PATH IS TRUSTWORTHY"); // title must NOT be in content anymore
    expect(html).not.toContain("graph confidence");
  });

  test("formula headline: resolvedCallsites ÷ totalCallsites = pct%", () => {
    const html = buildConfidencePopoverHtml(cov);
    expect(html).toContain("3,192 ÷ 4,186 = 76%"); // toLocaleString en-US
  });

  test("What we counted: label stripped — opens directly with 'We read all' or 'We read every' (cycle-2 de-label)", () => {
    // flipped per 2026-06-12 cycle-2 de-label ruling
    const html = buildConfidencePopoverHtml(cov);
    expect(html).not.toContain("What we counted"); // label-free: bold lead-in stripped
    expect(html).toContain("We read every file in this repo"); // capitalized opening (no fileCount)
    expect(html).toContain("places where code calls a function"); // call-site framing intact
  });

  test("ladder: all three band labels present", () => {
    const html = buildConfidencePopoverHtml(cov);
    expect(html).toContain("&lt;40"); // escaped < for low band
    expect(html).toContain("40–60"); // medium band
    expect(html).toContain("≥60"); // high band
  });

  test("So-what green tier: label stripped — opens 'Every arrow you see' (cycle-2 de-label)", () => {
    // flipped per 2026-06-12 cycle-2 de-label ruling
    const html = buildConfidencePopoverHtml(cov);
    // gap = 4186 - 3192 = 994
    expect(html).toContain("994"); // gap number still present
    expect(html).not.toContain("So what:"); // bold lead-in stripped
    expect(html).toContain("Every arrow you see"); // capitalized opening (green tier)
    expect(html).toContain("never guessed"); // tier-variant phrase intact
    expect(html).toContain("missing arrow doesn't mean"); // so-what for green intact
  });

  test("footer REMOVED", () => {
    const html = buildConfidencePopoverHtml(cov);
    expect(html).not.toContain("Computed automatically"); // footer gone
  });

  test("old checklist items REMOVED", () => {
    const html = buildConfidencePopoverHtml(cov);
    expect(html).not.toContain("Only confirmed edges drawn"); // checklist gone
    expect(html).not.toContain("path shown"); // no old suffix
    expect(html).not.toContain("in-repo call-sites pinned"); // old phrasing gone
  });

  test("fileCount variant: with fileCount opens 'We read all N files' (cycle-2 de-label)", () => {
    // flipped per 2026-06-12 cycle-2 de-label ruling
    const covWithFiles: CoverageInput = { ...cov, fileCount: 467 };
    const html = buildConfidencePopoverHtml(covWithFiles);
    expect(html).toContain("We read all 467 files"); // capitalized + no lead-in label
    expect(html).not.toContain("every file in this repo"); // without-fileCount fallback absent
    expect(html).not.toContain("What we counted"); // label stripped
  });

  test("fileCount variant: without fileCount opens 'We read every file in this repo' (cycle-2 de-label)", () => {
    // flipped per 2026-06-12 cycle-2 de-label ruling
    const html = buildConfidencePopoverHtml(cov); // no fileCount
    expect(html).toContain("We read every file in this repo"); // capitalized + no lead-in label
    expect(html).not.toContain("we read all "); // no "we read all N files" phrasing
    expect(html).not.toContain("What we counted"); // label stripped
  });
});

describe("buildConfidencePopoverHtml — medium tier (yellow)", () => {
  const cov: CoverageInput = {
    pct: 50,
    tier: "yellow",
    resolvedCallsites: 100,
    totalCallsites: 200,
  };

  test("title: PARTLY TRUSTWORTHY NOT in content (cycle-2 de-label)", () => {
    // flipped per 2026-06-12 cycle-2 de-label ruling
    expect(buildConfidencePopoverHtml(cov)).not.toContain("PARTLY TRUSTWORTHY"); // title → aria-label only
  });

  test("So-what yellow tier: label stripped — opens 'Only the' (cycle-2 de-label)", () => {
    // flipped per 2026-06-12 cycle-2 de-label ruling
    const html = buildConfidencePopoverHtml(cov);
    // gap = 200 - 100 = 100
    expect(html).toContain("100"); // gap number still present
    expect(html).not.toContain("So what:"); // bold lead-in stripped
    expect(html).toContain("Only the"); // capitalized opening (yellow tier)
    expect(html).toContain("rest is left blank"); // yellow so-what phrasing intact
    expect(html).toContain("missing arrow doesn't mean"); // so-what for yellow intact
  });
});

describe("buildConfidencePopoverHtml — low tier (red)", () => {
  const cov: CoverageInput = {
    pct: 30,
    tier: "red",
    resolvedCallsites: 30,
    totalCallsites: 100,
  };

  test("title: NOT TRUSTWORTHY NOT in content (cycle-2 de-label)", () => {
    // flipped per 2026-06-12 cycle-2 de-label ruling
    expect(buildConfidencePopoverHtml(cov)).not.toContain("NOT TRUSTWORTHY"); // title → aria-label only
  });

  test("So-what red tier: label stripped — opens 'Too few calls' (cycle-2 de-label)", () => {
    // flipped per 2026-06-12 cycle-2 de-label ruling
    const html = buildConfidencePopoverHtml(cov);
    // gap = 100 - 30 = 70
    expect(html).toContain("70"); // gap number still present
    expect(html).not.toContain("So what:"); // bold lead-in stripped
    expect(html).toContain("Too few calls could be traced"); // capitalized opening (red tier)
    expect(html).toContain("falls back to the file-level dependency graph"); // red so-what intact
  });

  test("large numbers formatted with toLocaleString (en-US thousands sep)", () => {
    const bigCov: CoverageInput = {
      pct: 76,
      tier: "green",
      resolvedCallsites: 3192,
      totalCallsites: 4186,
    };
    const html = buildConfidencePopoverHtml(bigCov);
    // Thousands separator present
    expect(html).toContain("3,192");
    expect(html).toContain("4,186");
  });
});
