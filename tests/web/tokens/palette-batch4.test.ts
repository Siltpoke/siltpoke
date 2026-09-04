import { describe, expect, test } from "bun:test";
import { palette, contrastRatio, type ColorToken } from "../../../src/web/tokens/palette";

// Task 10b batch 4's own test additions, split out of palette.test.ts (fix
// round 1, Important 2): palette.test.ts was ~785 LOC before batch 4's +130,
// landing at 915 — past the repo's 800 LOC hard cap (lint:files started
// listing it under "ERROR — 25 file(s) exceed 800 LOC"). Same file-
// organization-only split precedent as Task 10b batch 2's fix round
// (palette.ts -> palette.ts + categorical.ts): a pure move, no API change,
// every test's assertions and RED evidence unchanged from where they were
// authored.

describe("Task 10b batch 4 — a retired component bug/idea washes + hero row (Family 6b)", () => {
  // The badge text is `tokens.color.terra`/`moss` painted DIRECTLY on top of
  // these washes (real text, "🐛 BUG"/"✨ IDEA", 10px bold — not WCAG large
  // text) — the same "brand accent as real text on a newly-minted wash"
  // shape Task 10b batch 2's diffDelBg/diffAddBg already established.
  test("light terra/moss on their light wash do not regress below the pre-existing measured gap (held, not improved)", () => {
    expect(contrastRatio(palette.light.terra, palette.light.questBugBg)).toBeGreaterThanOrEqual(3.054);
    expect(contrastRatio(palette.light.moss, palette.light.questIdeaBg)).toBeGreaterThanOrEqual(2.89);
  });

  // RED evidence: temporarily set dark.questBugBg to its LIGHT value
  // (#fdf2f0, i.e. simulate "forgot to darken for dark mode") and ran
  // `bun test tests/web/tokens/palette-batch4.test.ts`. Actual captured output:
  //
  //   error: expect(received).toBeGreaterThanOrEqual(expected)
  //   Expected: >= 4.5
  //   Received: 2.3727190464074073
  //   (fail) Task 10b batch 4 — a retired component bug/idea washes + hero row (Family 6b) > dark terra clears the 4.5:1 text floor on dark questBugBg [1.38ms]
  //
  // Reverted immediately (dark.questBugBg restored to #6a1c0e); re-ran: all
  // tests in this describe block pass.
  test("dark terra clears the 4.5:1 text floor on dark questBugBg", () => {
    expect(contrastRatio(palette.dark.terra, palette.dark.questBugBg)).toBeGreaterThanOrEqual(4.5);
  });
  test("dark moss clears the 4.5:1 text floor on dark questIdeaBg", () => {
    expect(contrastRatio(palette.dark.moss, palette.dark.questIdeaBg)).toBeGreaterThanOrEqual(4.5);
  });

  // Badge borders — graphical, 3:1 floor vs paper. Light values are today's
  // pale-pastel literals — a PRE-EXISTING sub-3:1 gap against paper
  // (1.32:1 / 1.21:1, held not fixed, same precedent as every other
  // light-mode pin in this file). Dark already clears the real floor
  // unlifted (pale pastel against dark.paper's near-black), same "already
  // clears, held" outcome as `teal`/`tan` above.
  test("light questBugEdge / questIdeaEdge do not regress below their pre-existing measured value on paper (held, not improved)", () => {
    expect(contrastRatio(palette.light.questBugEdge, palette.light.paper)).toBeGreaterThanOrEqual(1.322);
    expect(contrastRatio(palette.light.questIdeaEdge, palette.light.paper)).toBeGreaterThanOrEqual(1.205);
  });
  test("dark questBugEdge / questIdeaEdge clear the 3:1 graphical floor vs dark.paper", () => {
    expect(contrastRatio(palette.dark.questBugEdge, palette.dark.paper)).toBeGreaterThanOrEqual(3);
    expect(contrastRatio(palette.dark.questIdeaEdge, palette.dark.paper)).toBeGreaterThanOrEqual(3);
  });

  // questHeroBg — three real text tokens painted on top (title=ink, pr/note
  // labels=ink3, frac counter=terra); ink3 is the binding constraint (the
  // palest of the three in dark mode).
  test("light ink3/terra on light questHeroBg do not regress below the pre-existing measured gap (held, not improved)", () => {
    expect(contrastRatio(palette.light.ink3, palette.light.questHeroBg)).toBeGreaterThanOrEqual(3.882);
    expect(contrastRatio(palette.light.terra, palette.light.questHeroBg)).toBeGreaterThanOrEqual(3.189);
  });
  test("dark ink/ink3/terra all clear the 4.5:1 text floor on dark questHeroBg, ink3 the binding constraint", () => {
    const ink = contrastRatio(palette.dark.ink, palette.dark.questHeroBg);
    const ink3 = contrastRatio(palette.dark.ink3, palette.dark.questHeroBg);
    const terra = contrastRatio(palette.dark.terra, palette.dark.questHeroBg);
    expect(ink).toBeGreaterThanOrEqual(4.5);
    expect(ink3).toBeGreaterThanOrEqual(4.5);
    expect(terra).toBeGreaterThanOrEqual(4.5);
    // Confirms ink3 is genuinely the tightest of the three, not assumed.
    expect(ink3).toBeLessThan(ink);
    expect(ink3).toBeLessThan(terra);
  });
});

describe("Task 10b batch 4 — action-result.ts STAT_COLOR/ACTION_COLOR mini-palette (Family 7)", () => {
  // Real text (banner title chip, stat-delta chips, XP chip), painted
  // directly on the action-banner's `cream` background.
  const statTokens: ColorToken[] = ["statVitalityInk", "statHungerInk", "statEnergyInk", "statBondInk"];

  test("dark stat tokens clear the 4.5:1 text floor on dark.cream", () => {
    for (const token of statTokens) {
      expect(contrastRatio(palette.dark[token], palette.dark.cream), `dark.${token}`).toBeGreaterThanOrEqual(4.5);
    }
  });
  // NOTE: these tokens are gated ONLY against `cream` — the real, only
  // surface they render on (`showBanner` hardcodes `background:
  // ${tokens.color.cream}`; there is no `paper`-background call site for
  // these tokens in action-result.ts). A `paper` assertion was drafted and
  // dropped: statVitalityInk measures 4.14:1 against dark.paper (under the
  // floor) at the value chosen for the REAL cream surface — asserting a
  // floor against a surface the code never actually paints on would be
  // exactly the "measure against the surface the rule actually paints on"
  // mistake the evidence bar warns against, not a real gap to fix.

  // Light values are pre-existing sub-4.5 gaps (held, not improved) — same
  // precedent as every other light-mode pin in this file. Truncated to 3
  // decimals from the live measured value, never rounded up.
  test("light stat tokens do not regress below their pre-track measured value on cream (held, not improved)", () => {
    expect(contrastRatio(palette.light.statVitalityInk, palette.light.cream)).toBeGreaterThanOrEqual(3.805);
    expect(contrastRatio(palette.light.statHungerInk, palette.light.cream)).toBeGreaterThanOrEqual(2.863);
    expect(contrastRatio(palette.light.statEnergyInk, palette.light.cream)).toBeGreaterThanOrEqual(2.596);
    expect(contrastRatio(palette.light.statBondInk, palette.light.cream)).toBeGreaterThanOrEqual(2.934);
  });

  // RED evidence: temporarily set dark.statVitalityInk to its LIGHT value
  // (#c75c5c — one 0.005-lightness step short of the floor) and ran
  // `bun test tests/web/tokens/palette-batch4.test.ts`. Actual captured output:
  //
  //   error: dark.statVitalityInk
  //   Expected: >= 4.5
  //   Received: 4.446877120246101
  //   (fail) Task 10b batch 4 — action-result.ts STAT_COLOR/ACTION_COLOR mini-palette (Family 7) > dark stat tokens clear the 4.5:1 text floor on dark.cream [0.08ms]
  //
  // A mutation that merely swaps two DIFFERENT strings (e.g. dark.
  // statVitalityInk <-> dark.statHungerInk) would also be caught by a plain
  // "the four values are distinct" check — this RED instead shows the
  // ACTUAL near-miss shape (one lightness step short), which a distinctness
  // check cannot see. Reverted immediately (dark.statVitalityInk restored
  // to #c85e5e); re-ran: all tests in this describe block pass.
});

describe("Task 10b batch 4 — Memory.tsx date-group divider row (Family 11)", () => {
  // dateGroupSubInk — "N cleared/pending" sub-label, real TEXT (10px mono).
  // bookPendingBorder — dashed empty-state marker circle, graphical (no
  // strict floor gated here — a decorative empty-state placeholder, same
  // no-strict-floor treatment memWorkingDivider already established for a
  // decorative divider line — but still pinned so it cannot silently drift).
  test("light dateGroupSubInk does not regress below its pre-track measured value on paper/cream (held, not improved)", () => {
    expect(contrastRatio(palette.light.dateGroupSubInk, palette.light.paper)).toBeGreaterThanOrEqual(1.888);
    expect(contrastRatio(palette.light.dateGroupSubInk, palette.light.cream)).toBeGreaterThanOrEqual(2.025);
  });
  test("dark dateGroupSubInk clears the 4.5:1 text floor on paper/cream at its unlifted hex", () => {
    expect(contrastRatio(palette.dark.dateGroupSubInk, palette.dark.paper)).toBeGreaterThanOrEqual(4.5);
    expect(contrastRatio(palette.dark.dateGroupSubInk, palette.dark.cream)).toBeGreaterThanOrEqual(4.5);
  });
  test("bookPendingBorder does not regress below its measured value against paper in either theme", () => {
    expect(contrastRatio(palette.light.bookPendingBorder, palette.light.paper)).toBeGreaterThanOrEqual(1.601);
    expect(contrastRatio(palette.dark.bookPendingBorder, palette.dark.paper)).toBeGreaterThanOrEqual(8.99);
  });

  // dateGroupDivider — fix round 1, Minor finding: the original batch-4
  // implementation aliased this call site to `tokens.color.edge`
  // (`#d8cbab`) instead of pinning the ORIGINAL live literal (`#ece3d0`) —
  // the one place in this batch that changed a light-mode value rather
  // than holding it, contradicting the "all light values are the literal
  // already live" claim. `#ece3d0` (236,227,208) vs `edge` (216,203,171)
  // is a real, visible R-20/G-24/B-37 shift — a noticeably darker,
  // more-tan divider line in light mode, not the "small visual delta" the
  // original classification guessed. Fixed by minting `dateGroupDivider`
  // as its own token pair instead, matching every OTHER new token in this
  // batch: light = the exact original literal, unchanged; dark = derived.
  // No strict floor (a 1px decorative divider, same no-floor treatment as
  // `memWorkingDivider`/`edge` itself) — still pinned so it cannot
  // silently drift.
  test("dateGroupDivider's light value is byte-identical to the original pre-migration literal (no light-mode change)", () => {
    expect(palette.light.dateGroupDivider).toBe("#ece3d0");
  });
});
